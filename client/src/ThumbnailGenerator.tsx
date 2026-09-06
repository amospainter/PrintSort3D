import { useEffect } from 'react';
import * as THREE from 'three';
import { loadModelAsObject3D, frameObject } from './loadModel';
import { api } from './api';

interface Props {
  fileId: number;
  ext: string;
  onDone: () => void;
}

export function ThumbnailGenerator({ fileId, ext, onDone }: Props) {
  useEffect(() => {
    let renderer: THREE.WebGLRenderer | null = null;
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch(api.rawFileUrl(fileId));
        if (!res.ok) throw new Error(`raw fetch failed: ${res.status}`);
        const arrayBuffer = await res.arrayBuffer();
        if (cancelled) return;

        const object = await loadModelAsObject3D(ext, arrayBuffer);
        if (cancelled) return;

        const size = 256;
        const canvas = document.createElement('canvas');
        renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
        renderer.setSize(size, size);

        const scene = new THREE.Scene();
        scene.add(new THREE.AmbientLight(0xffffff, 0.6));
        const key = new THREE.DirectionalLight(0xffffff, 1.2);
        key.position.set(5, 8, 5);
        scene.add(key);
        const fill = new THREE.DirectionalLight(0xffffff, 0.3);
        fill.position.set(-5, -3, -5);
        scene.add(fill);
        scene.add(object);

        const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
        frameObject(object, camera);

        renderer.render(scene, camera);
        const dataUrl = canvas.toDataURL('image/png');

        await api.uploadThumbnail(fileId, dataUrl);
      } catch (err) {
        console.error('[thumb] failed for file', fileId, err);
      } finally {
        renderer?.dispose();
        if (!cancelled) onDone();
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId]);

  return null;
}
