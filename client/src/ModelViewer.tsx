import { useEffect, useMemo, useState } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { Grid, OrbitControls, Text } from '@react-three/drei';
import * as THREE from 'three';
import {
  loadModelAsObject3D,
  loadBakedMesh,
  frameObject,
  frameVisibleChildren,
  bedZ,
  applyPaintColors,
  removePaintColors,
} from './loadModel';

interface Footprint {
  x: number;
  y: number;
  z: number;
}

// One build-plate instance to draw: its centre and floor height in the framed (recentered)
// world space, plus the footprint of the items sitting on it (used only as a fallback size
// when there's no declared bed size).
interface PlateBed {
  key: number; // plate index for multi-plate, 0 for the single merged/selected case
  cx: number;
  cy: number;
  z: number;
  sx: number;
  sy: number;
  sz: number;
}

interface PlateRef {
  index: number;
  buildItemIndices?: number[];
}

function Model({
  ext,
  arrayBuffer,
  meshUrl,
  preferRaw,
  onFramed,
  onBeds,
  visibleChildIndices,
  plates,
  bedSize,
  filamentColors,
  painted,
}: {
  ext: string;
  arrayBuffer?: ArrayBuffer | null;
  meshUrl?: string | null;
  preferRaw?: boolean;
  onFramed?: () => void;
  onBeds?: (beds: PlateBed[]) => void;
  visibleChildIndices?: number[] | null;
  plates?: PlateRef[];
  bedSize?: { x: number; y: number } | null;
  filamentColors?: string[];
  painted?: boolean;
}) {
  const [object, setObject] = useState<THREE.Object3D | null>(null);
  const { camera } = useThree();

  // Prefer the server-baked mesh (fast: no unzip / DOM parse); fall back to parsing the raw
  // file bytes in-browser for archive entries and files not yet baked. `preferRaw` forces the
  // in-browser parse even when a baked mesh exists — the Detail page's "Load full model"
  // escape hatch for when the bake looks wrong.
  useEffect(() => {
    let cancelled = false;
    const useRaw = (!meshUrl || preferRaw) && arrayBuffer;
    const load = useRaw
      ? loadModelAsObject3D(ext, arrayBuffer)
      : meshUrl
        ? fetch(meshUrl)
            .then((res) => (res.ok ? res.arrayBuffer() : Promise.reject(new Error(`mesh ${res.status}`))))
            .then((buf) => loadBakedMesh(buf) as THREE.Object3D)
        : null;
    if (!load) return;
    setObject(null);
    load.then((obj) => !cancelled && setObject(obj)).catch(() => !cancelled && setObject(null));
    return () => {
      cancelled = true;
    };
  }, [ext, arrayBuffer, meshUrl, preferRaw]);

  // Toggle painted vertex colours on the loaded meshes in place. Independent of the framing
  // effect below — geometry swaps don't change the bounding box, and plate visibility toggling
  // operates on Group children, not geometry.
  useEffect(() => {
    if (!object) return;
    if (painted) {
      applyPaintColors(object, filamentColors ?? []);
    } else {
      removePaintColors(object);
    }
  }, [object, painted, filamentColors]);

  // Applies plate visibility (multi-plate 3MFs) and reframes the camera around whatever's
  // now visible. Also runs once on initial load, when visibleChildIndices is undefined/null
  // and every child stays visible — same as the old unconditional frameObject call.
  useEffect(() => {
    if (!object || !(camera instanceof THREE.PerspectiveCamera)) return;
    const floor = bedSize ?? undefined;
    let size: THREE.Vector3;
    if (visibleChildIndices) {
      const indexSet = new Set(visibleChildIndices);
      object.children.forEach((child, i) => {
        child.visible = indexSet.has(i);
      });
      size = frameVisibleChildren(object, camera, floor);
    } else {
      object.children.forEach((child) => {
        child.visible = true;
      });
      size = frameObject(object, camera, floor);
    }

    // In "All plates" view of a multi-plate 3MF, the plates keep their true side-by-side
    // layout from the file's coordinate space — a single bed centred on the merged centroid
    // sits under none of them. Draw one bed per plate, each under its own item cluster.
    object.updateMatrixWorld(true);
    const mappedPlates = (visibleChildIndices ? [] : plates ?? []).filter(
      (p) => p.buildItemIndices && p.buildItemIndices.length > 0
    );
    if (mappedPlates.length > 1) {
      const beds: PlateBed[] = [];
      for (const p of mappedPlates) {
        const box = new THREE.Box3();
        for (const i of p.buildItemIndices!) {
          const child = object.children[i];
          if (child) box.expandByObject(child);
        }
        if (box.isEmpty()) continue;
        const c = box.getCenter(new THREE.Vector3());
        const s = box.getSize(new THREE.Vector3());
        beds.push({ key: p.index, cx: c.x, cy: c.y, z: box.min.z, sx: s.x, sy: s.y, sz: s.z });
      }
      onBeds?.(beds);
    } else {
      // Single selected plate, or a single-plate / non-Bambu file: one bed, centred, sitting
      // at the bottom of the framed box (per bedZ's centered-box contract).
      onBeds?.([{ key: 0, cx: 0, cy: 0, z: bedZ(size.z), sx: size.x, sy: size.y, sz: size.z }]);
    }
    onFramed?.();
  }, [object, visibleChildIndices, plates, camera, onFramed, onBeds, bedSize]);

  if (!object) return null;
  return <primitive object={object} />;
}

// Picks a grid line spacing (minor "cell" lines + bolder "section" lines every Nth cell)
// that reads sensibly across the whole range of real print-file sizes, from small
// jewelry-scale parts up to full-bed-size prints — modeled on the spacing choices slicers
// themselves use for their build-plate grids.
function gridSteps(maxDim: number): { cellSize: number; sectionSize: number } {
  if (maxDim <= 20) return { cellSize: 1, sectionSize: 10 };
  if (maxDim <= 100) return { cellSize: 5, sectionSize: 25 };
  if (maxDim <= 300) return { cellSize: 10, sectionSize: 50 };
  return { cellSize: 20, sectionSize: 100 };
}

function formatMm(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/**
 * A finite print-bed on the model's own XY plane (Z-up, per bedZ's contract): a dark plate
 * surface against the dark viewport void, its boundary marked by a light edge outline, with
 * drei's grid overlay and a size label just off the front edge. When the file declares a
 * build-plate size (Bambu/Orca 3MF) or the app's configured default applies, it's drawn at
 * those exact bed dimensions so the model reads to scale; with no bed size at all (e.g.
 * archive entries) it falls back to "just big enough for this model" plus padding, and the
 * label is hidden.
 *
 * drei's <Grid> defaults to lying in the *unrotated* mesh's local X/Z plane (it swizzles
 * the plane geometry's own x/y into world x/z in its shader) — rotating it -90° about X
 * turns that into the model's X/Y plane instead, matching STL/OBJ/3MF's Z-up convention.
 * The surface plane and edge frame are plain PlaneGeometry, which already lies in XY, so
 * they need no rotation — only a Z offset to `bedZ`.
 */
function PrintBed({
  footprint,
  bedSize,
  origin = [0, 0],
  surfaceZ,
  label,
}: {
  footprint: Footprint;
  bedSize?: { x: number; y: number } | null;
  origin?: [number, number];
  surfaceZ?: number;
  label?: string | null;
}) {
  let width: number;
  let depth: number;
  if (bedSize) {
    width = bedSize.x;
    depth = bedSize.y;
  } else {
    const pad = Math.max(20, Math.max(footprint.x, footprint.y) * 0.15);
    width = footprint.x + pad * 2;
    depth = footprint.y + pad * 2;
  }
  const z = surfaceZ ?? bedZ(footprint.z);
  const maxDim = Math.max(width, depth);
  const { cellSize, sectionSize } = gridSteps(maxDim);

  // EdgesGeometry of a plane is just its 4 border segments (the coplanar diagonal is
  // dropped) — a crisp light outline marking the plate boundary. Memoized so it isn't
  // rebuilt (and leaked) on every render.
  const edges = useMemo(() => new THREE.EdgesGeometry(new THREE.PlaneGeometry(width, depth)), [width, depth]);
  useEffect(() => () => edges.dispose(), [edges]);

  const labelSize = Math.max(4, maxDim * 0.045);

  // Two-tone build plate: a dark plate surface against the (dark) viewport void, its
  // boundary marked by a light edge outline rather than a separate filled frame. The
  // surface is unlit (meshBasicMaterial) so its tone stays flat regardless of lighting.
  const labelText = bedSize
    ? `${label ? `${label} — ` : ''}${formatMm(width)} × ${formatMm(depth)} mm`
    : null;

  return (
    <group position={[origin[0], origin[1], 0]}>
      {/* Plate surface the grid and model sit on. */}
      <mesh position={[0, 0, z - 0.05]}>
        <planeGeometry args={[width, depth]} />
        <meshBasicMaterial color="#363b43" side={THREE.DoubleSide} />
      </mesh>

      {/* Light boundary outline. */}
      <lineSegments position={[0, 0, z + 0.02]} geometry={edges}>
        <lineBasicMaterial color="#dfe3e8" toneMapped={false} />
      </lineSegments>

      <Grid
        args={[width, depth]}
        position={[0, 0, z]}
        rotation={[-Math.PI / 2, 0, 0]}
        cellSize={cellSize}
        cellColor="#4f555e"
        cellThickness={0.5}
        sectionSize={sectionSize}
        sectionColor="#646b76"
        sectionThickness={1}
        fadeDistance={maxDim * 4}
        fadeStrength={0.6}
        side={THREE.DoubleSide}
      />

      {labelText && (
        <Text
          position={[0, -depth / 2 - labelSize * 0.7, z + 0.05]}
          fontSize={labelSize}
          color="#e6e9ed"
          anchorX="center"
          anchorY="top"
          outlineWidth={labelSize * 0.08}
          outlineColor="#1b1f25"
        >
          {labelText}
        </Text>
      )}
    </group>
  );
}

interface ModelViewerProps {
  ext: string;
  // Raw file bytes — used for `.zip` archive entries and any file with no baked mesh yet.
  arrayBuffer?: ArrayBuffer | null;
  // Server-baked "PSM1" mesh URL (file.meshUrl); preferred over `arrayBuffer` when present.
  meshUrl?: string | null;
  // Force parsing `arrayBuffer` in-browser even when `meshUrl` is set (Detail's "Load full
  // model" toggle). No-op unless `arrayBuffer` has been fetched.
  preferRaw?: boolean;
  interactive?: boolean;
  onFramed?: () => void;
  // Which top-level build items (Group.children, in 3MF build order) to show — used to view
  // one plate of a multi-plate 3MF in isolation. Undefined/null shows the whole model.
  visibleChildIndices?: number[] | null;
  // All plates of the file (index + buildItemIndices). When set and no single plate is
  // selected, the viewer draws a separate bed under each plate's own item cluster instead
  // of one merged bed on the combined centroid.
  plates?: PlateRef[];
  // Build-plate footprint (mm) to draw the model against, to scale. From the API's
  // file.bedSize (declared 3MF size or the configured default). Omit for archive entries.
  bedSize?: { x: number; y: number } | null;
  // Painted multi-material / AMS 3MFs: `filamentColors` is the palette (file.filaments
  // colours), `painted` toggles the rendering. The per-triangle slots ride inside the baked
  // mesh blob, so no extra fetch.
  filamentColors?: string[];
  painted?: boolean;
}

export function ModelViewer({
  ext,
  arrayBuffer,
  meshUrl,
  preferRaw,
  interactive = true,
  onFramed,
  visibleChildIndices,
  plates,
  bedSize,
  filamentColors,
  painted,
}: ModelViewerProps) {
  const [beds, setBeds] = useState<PlateBed[] | null>(null);
  const multi = (beds?.length ?? 0) > 1;

  return (
    <Canvas camera={{ fov: 30, up: [0, 0, 1] }} gl={{ preserveDrawingBuffer: true }}>
      {/* Fixed dark void so the plate / dark frame / darker background read as three
          distinct tones regardless of the page's light or dark theme. */}
      <color attach="background" args={['#15181c']} />
      <ambientLight intensity={0.6} />
      <directionalLight position={[5, 8, 5]} intensity={1.2} />
      <directionalLight position={[-5, -3, -5]} intensity={0.3} />
      <Model
        ext={ext}
        arrayBuffer={arrayBuffer}
        meshUrl={meshUrl}
        preferRaw={preferRaw}
        onFramed={onFramed}
        onBeds={setBeds}
        visibleChildIndices={visibleChildIndices}
        plates={plates}
        bedSize={bedSize}
        filamentColors={filamentColors}
        painted={painted}
      />
      {beds?.map((bed) => (
        <PrintBed
          key={bed.key}
          footprint={{ x: bed.sx, y: bed.sy, z: bed.sz }}
          bedSize={bedSize}
          origin={[bed.cx, bed.cy]}
          surfaceZ={bed.z}
          label={multi ? `Plate ${bed.key}` : null}
        />
      ))}
      {interactive && <OrbitControls enableDamping />}
    </Canvas>
  );
}
