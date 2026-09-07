import { useEffect, useMemo, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api, type ArchiveEntry, type FileEntry, type TagInfo } from '../api';
import { ModelViewer } from '../ModelViewer';
import { ImageLightbox } from '../ImageLightbox';
import { TagInput } from '../TagInput';
import { tagColorMap } from '../tagColors';
import { ChevronLeftIcon, RefreshIcon } from '../Icons';

function fullFilePath(file: FileEntry): string {
  const root = (file.root.path ?? '').replace(/[\\/]+$/, '');
  const rel = file.relativePath.replace(/\\/g, '/');
  return `${root}/${rel}`;
}

// Directory portion of the file's path, rendered as links into the filtered library view
// (root, then each folder segment); the filename is shown plain as the last crumb.
function PathBreadcrumb({ file }: { file: FileEntry }) {
  const rootLabel = file.root.label ?? '';
  const parts = file.relativePath.split(/[\\/]/).filter(Boolean);
  const filename = parts.pop() ?? file.filename;
  return (
    <span className="path-breadcrumb" title={fullFilePath(file)}>
      <Link to={`/?root=${encodeURIComponent(rootLabel)}`}>{rootLabel}</Link>
      {parts.map((seg, i) => {
        const partial = parts.slice(0, i + 1).join('/');
        return (
          <span key={partial}>
            <span className="path-breadcrumb-sep">/</span>
            <Link to={`/?root=${encodeURIComponent(rootLabel)}&folder=${encodeURIComponent(partial)}`}>{seg}</Link>
          </span>
        );
      })}
      <span className="path-breadcrumb-sep">/</span>
      <span>{filename}</span>
    </span>
  );
}

// Below this source-file size, parsing the real model in-browser is cheap enough that the
// viewer prefers it over the server-baked mesh (which stays the default for large files to
// keep the main thread responsive). STL/OBJ/3MF alike.
const FULL_MODEL_AUTO_BYTES = 5 * 1024 * 1024;

function formatDimensions(size: { x: number; y: number; z: number }): string {
  const fmt = (n: number) => n.toFixed(1);
  return `${fmt(size.x)} × ${fmt(size.y)} × ${fmt(size.z)} mm`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function ArchiveViewer({ fileId }: { fileId: number }) {
  const [entries, setEntries] = useState<ArchiveEntry[] | null>(null);
  const [active, setActive] = useState<ArchiveEntry | null>(null);
  const [arrayBuffer, setArrayBuffer] = useState<ArrayBuffer | null>(null);

  useEffect(() => {
    api.listArchiveEntries(fileId).then(setEntries);
  }, [fileId]);

  useEffect(() => {
    if (!active) return;
    setArrayBuffer(null);
    let cancelled = false;
    fetch(api.archiveEntryRawUrl(fileId, active.path))
      .then((res) => (res.ok ? res.arrayBuffer() : null))
      .then((buf) => {
        if (!cancelled) setArrayBuffer(buf);
      });
    return () => {
      cancelled = true;
    };
  }, [fileId, active]);

  if (active) {
    return (
      <div>
        <button type="button" onClick={() => setActive(null)}>
          &larr; Back to archive contents
        </button>
        <div className="viewer-pane" style={{ marginTop: 8, height: 560 }}>
          {arrayBuffer ? <ModelViewer ext={active.ext} arrayBuffer={arrayBuffer} /> : <p>Loading model...</p>}
        </div>
      </div>
    );
  }

  if (!entries) return <p>Loading archive contents...</p>;
  if (entries.length === 0) return <p>No 3D model files found inside this archive.</p>;

  return (
    <ul className="archive-entry-list">
      {entries.map((entry) => (
        <li key={entry.path}>
          <button type="button" onClick={() => setActive(entry)}>
            <span>{entry.path}</span>
            <span className="archive-entry-size">{formatSize(entry.sizeBytes)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export default function Detail() {
  const { id } = useParams();
  const fileId = Number(id);
  const [file, setFile] = useState<FileEntry | null>(null);
  const [arrayBuffer, setArrayBuffer] = useState<ArrayBuffer | null>(null);
  const [notes, setNotes] = useState('');
  const [tagDraft, setTagDraft] = useState<string[]>([]);
  // The tag text currently typed into TagInput but not yet turned into a chip. saveTags folds
  // it in so "type a tag, click Save" (without pressing Enter) still persists it.
  const [pendingTag, setPendingTag] = useState('');
  const [allTags, setAllTags] = useState<TagInfo[]>([]);
  const tagNames = useMemo(() => allTags.map((t) => t.name), [allTags]);
  const tagColors = useMemo(() => tagColorMap(allTags), [allTags]);
  const [saving, setSaving] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [activePlateIndex, setActivePlateIndex] = useState<number | null>(null);
  const [rescanning, setRescanning] = useState(false);
  const [rescanMessage, setRescanMessage] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [openMessage, setOpenMessage] = useState<string | null>(null);
  const [painted, setPainted] = useState(false);
  // "Load full model": swap the fast server-baked mesh for the raw source file parsed
  // in-browser (three.js's own STL/OBJ/3MF loaders) — an escape hatch for when the bake
  // looks wrong. Small source files (< FULL_MODEL_AUTO_BYTES) parse in-browser fast enough
  // that we default to the raw model for them, using the bake only as the perf fallback for
  // large files. Reset whenever the viewed file changes.
  const [loadFull, setLoadFull] = useState(false);

  useEffect(() => {
    api.getFile(fileId).then((f) => {
      setFile(f);
      setNotes(f.notes);
      setTagDraft(f.tags);
      setPendingTag('');
      setActivePlateIndex(null); // "All plates" by default — matches the pre-plate-switcher 3D view
      setLoadFull(f.ext !== '.zip' && f.sizeBytes > 0 && f.sizeBytes < FULL_MODEL_AUTO_BYTES);
      setArrayBuffer(null);
    });
    api.listTags().then(setAllTags);
  }, [fileId]);

  const rescan = () => {
    setRescanning(true);
    setRescanMessage(null);
    api
      .rescanFile(fileId)
      .then((f) => {
        setFile(f);
        setNotes(f.notes);
        setTagDraft(f.tags);
        setRescanMessage(f.rescanStatus === 'missing' ? 'File not found on disk' : 'Rescanned');
      })
      .catch(() => setRescanMessage('Rescan failed'))
      .finally(() => setRescanning(false));
  };

  // Archive files are browsed entry-by-entry (ArchiveViewer fetches its own bytes). Baked
  // files load their mesh inside ModelViewer. The whole-file raw fetch here is the fallback
  // for a non-archive file with no baked mesh yet (pre-v8 scan, or bake failed), and the
  // source for the "Load full model" toggle when a baked mesh does exist.
  useEffect(() => {
    if (!file || file.ext === '.zip') return;
    if (file.meshUrl && !(loadFull && !painted)) return; // baked mesh covers this case
    if (arrayBuffer) return;
    fetch(api.rawFileUrl(fileId))
      .then((res) => (res.ok ? res.arrayBuffer() : null))
      .then(setArrayBuffer);
  }, [fileId, file, loadFull, painted, arrayBuffer]);

  const activePlate = useMemo(
    () => (activePlateIndex === null ? null : file?.plates.find((p) => p.index === activePlateIndex) ?? null),
    [file, activePlateIndex]
  );
  // null activePlateIndex ("All plates") shows every embedded image and the whole merged
  // model; a specific plate shows just its images and (when buildItemIndices is mapped)
  // just its meshes in the 3D viewer.
  const galleryImages = activePlate ? activePlate.images : file?.embeddedImages ?? [];
  const visibleChildIndices = activePlate ? activePlate.buildItemIndices ?? null : undefined;

  const saveNotes = () => {
    setSaving(true);
    api
      .updateFile(fileId, { notes })
      .then(setFile)
      .finally(() => setSaving(false));
  };

  const saveTags = () => {
    const pending = pendingTag.trim().toLowerCase();
    const tags = pending && !tagDraft.includes(pending) ? [...tagDraft, pending] : tagDraft;
    setSaving(true);
    api
      .updateFile(fileId, { tags })
      .then((f) => {
        setFile(f);
        setTagDraft(f.tags);
        setPendingTag('');
      })
      .finally(() => setSaving(false));
  };

  const openInSlicer = () => {
    setOpening(true);
    setOpenMessage(null);
    api
      .openInSlicer(fileId)
      .then((r) => setOpenMessage(r.method === 'os-default' ? 'Opened with the default app' : 'Opened in slicer'))
      .catch(() => setOpenMessage('Could not open — set the slicer path in Settings'))
      .finally(() => setOpening(false));
  };

  if (!file) return <p>Loading...</p>;

  return (
    <div>
      <div className="detail-breadcrumb">
        <Link to="/" className="detail-back">
          <ChevronLeftIcon /> Library
        </Link>
        <span className="detail-breadcrumb-sep">/</span>
        <span className="detail-breadcrumb-file">{file.filename}</span>
        <button type="button" className="rescan-button" disabled={rescanning} onClick={rescan}>
          <RefreshIcon className={rescanning ? 'spin' : ''} /> {rescanning ? 'Rescanning…' : 'Rescan'}
        </button>
        {file.ext !== '.zip' && !file.missing && (
          <button type="button" className="rescan-button" disabled={opening} onClick={openInSlicer}>
            {opening ? 'Opening…' : 'Open in slicer'}
          </button>
        )}
      </div>
      {rescanMessage && <p className="muted rescan-status">{rescanMessage}</p>}
      {openMessage && <p className="muted rescan-status">{openMessage}</p>}

      <div className="detail-layout">
        <div className="viewer-column">
          <div className="viewer-shell">
            <div className="viewer-pane">
              {file.ext === '.zip' ? (
                <ArchiveViewer fileId={fileId} />
              ) : file.meshUrl || arrayBuffer ? (
                <>
                  <ModelViewer
                    ext={file.ext}
                    arrayBuffer={arrayBuffer}
                    meshUrl={file.meshUrl}
                    // Painted colours ride inside the baked mesh, so turning paint on forces
                    // the baked mesh even when we'd otherwise show the raw full model.
                    preferRaw={loadFull && !painted}
                    visibleChildIndices={visibleChildIndices}
                    plates={file.plates}
                    bedSize={file.bedSize}
                    filamentColors={file.filaments.map((f) => f.color)}
                    painted={painted}
                  />
                  <div className="viewer-hint">
                    <span>Drag to rotate &middot; Right-drag to pan &middot; Scroll to zoom</span>
                    {file.meshUrl && file.filaments.length > 1 && (
                      <label className="viewer-paint-toggle">
                        <input type="checkbox" checked={painted} onChange={(e) => setPainted(e.target.checked)} />
                        Show painted colors
                      </label>
                    )}
                    {file.meshUrl &&
                      !painted &&
                      (loadFull ? (
                        <span className="viewer-fullmodel-status">
                          {arrayBuffer ? 'Full model (parsed in browser)' : 'Loading full model…'}
                          {arrayBuffer && (
                            <button type="button" className="linklike" onClick={() => setLoadFull(false)}>
                              use fast mesh
                            </button>
                          )}
                        </span>
                      ) : (
                        <button type="button" className="linklike" onClick={() => setLoadFull(true)}>
                          Load full model
                        </button>
                      ))}
                  </div>
                </>
              ) : (
                <p>Loading model...</p>
              )}
            </div>

            {file.plates.length > 1 && (
              <div className="plate-rail">
                <button
                  type="button"
                  className={activePlateIndex === null ? 'active' : ''}
                  onClick={() => setActivePlateIndex(null)}
                >
                  All plates
                </button>
                {file.plates.map((p) => (
                  <button
                    key={p.index}
                    type="button"
                    className={p.index === activePlateIndex ? 'active' : ''}
                    onClick={() => setActivePlateIndex(p.index)}
                  >
                    <span>Plate {p.index}</span>
                    {p.name && <span className="plate-rail-name">{p.name}</span>}
                  </button>
                ))}
              </div>
            )}
          </div>

          {galleryImages.length > 0 && (
            <div className="image-carousel">
              {galleryImages.map((url, i) => (
                <button
                  key={url}
                  type="button"
                  className={i === lightboxIndex ? 'active' : ''}
                  onClick={() => setLightboxIndex(i)}
                >
                  <img src={url} alt="" />
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="meta-pane">
          <section className="details-section">
            <h3>Details</h3>
            <div className="details-row">
              <span className="muted">Type</span>
              <span>{file.ext.replace('.', '').toUpperCase()}</span>
            </div>
            <div className="details-row">
              <span className="muted">Size</span>
              <span>{formatSize(file.sizeBytes)}</span>
            </div>
            <div className="details-row">
              <span className="muted">Library</span>
              <span>
                <Link to={`/?root=${encodeURIComponent(file.root.label ?? '')}`}>{file.root.label}</Link>
              </span>
            </div>
            <div className="details-row details-row-path">
              <span className="muted">Path</span>
              <PathBreadcrumb file={file} />
            </div>
            <div className="details-row">
              <span className="muted">Modified</span>
              <span>{formatDate(file.mtime)}</span>
            </div>
            <div className="details-row">
              <span className="muted">Indexed</span>
              <span>{formatDate(file.addedAt)}</span>
            </div>
            {file.missing && (
              <div className="details-row">
                <span className="muted">Status</span>
                <span className="danger-text">Missing on disk</span>
              </div>
            )}
            {file.ext !== '.zip' && (
              <div className="details-row">
                <span className="muted">Dimensions</span>
                <span>{file.dimensions ? formatDimensions(file.dimensions) : 'Unknown'}</span>
              </div>
            )}
            {file.ext !== '.zip' && (
              <div className="details-row">
                <span className="muted">Build plate</span>
                <span title={file.plateSizeSource === 'file' ? 'From this file’s slicer settings' : 'App default (Settings)'}>
                  {file.bedSize.x} × {file.bedSize.y} mm{file.plateSizeSource === 'default' ? ' (default)' : ''}
                </span>
              </div>
            )}
          </section>

          <section>
            <h3>Tags</h3>
            <TagInput
              value={tagDraft}
              onChange={setTagDraft}
              onDraftChange={setPendingTag}
              suggestions={tagNames}
              colors={tagColors}
              placeholder="Add a tag…"
            />
            <button disabled={saving} onClick={saveTags}>Save tags</button>
          </section>

          <section>
            <h3>Notes</h3>
            <textarea
              rows={5}
              placeholder="Print settings, orientation, paint notes…"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
            <button disabled={saving} onClick={saveNotes}>Save notes</button>
          </section>

          {(file.filamentType || file.filamentColor || file.layerHeight || file.filaments.length > 0) && (
            <section>
              <h3>Slicer metadata (from 3MF)</h3>
              {file.filaments.length > 0 ? (
                <div className="details-row">
                  <span className="muted">
                    {file.filaments.length > 1 ? `Filaments (${file.filaments.length})` : 'Filament'}
                  </span>
                  <span className="filament-swatches">
                    {file.filaments.map((f, i) => (
                      <span
                        key={`${f.color}-${i}`}
                        className="filament-swatch"
                        title={f.type ? `${f.color} · ${f.type}` : f.color}
                      >
                        <span className="filament-swatch-chip" style={{ backgroundColor: f.color }} />
                        <span className="filament-swatch-label">{f.color}</span>
                      </span>
                    ))}
                  </span>
                </div>
              ) : (
                <>
                  <div className="details-row">
                    <span className="muted">Filament type</span>
                    <span>{file.filamentType ?? '—'}</span>
                  </div>
                  <div className="details-row">
                    <span className="muted">Filament color</span>
                    <span>{file.filamentColor ?? '—'}</span>
                  </div>
                </>
              )}
              <div className="details-row">
                <span className="muted">Layer height</span>
                <span>{file.layerHeight ?? '—'}</span>
              </div>
            </section>
          )}

          {file.duplicates && file.duplicates.length > 0 && (
            <section>
              <h3>Duplicates ({file.duplicates.length})</h3>
              <ul className="plain-list">
                {file.duplicates.map((d) => (
                  <li key={d.id}>
                    <Link to={`/files/${d.id}`}>{d.filename}</Link>{' '}
                    <span className="muted">
                      ({d.matchType === 'exact' ? 'exact file' : 'same geometry'}, {d.rootLabel}/{d.relativePath})
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>

      {lightboxIndex !== null && (
        <ImageLightbox
          images={galleryImages}
          index={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
          onIndexChange={setLightboxIndex}
        />
      )}
    </div>
  );
}

