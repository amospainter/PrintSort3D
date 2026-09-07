import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type RootConfig, type ScanResult, type ScanMode, type TagInfo, type PlateSize } from '../api';
import { TAG_COLOR_PRESETS, resolveTagColor, tagChipStyle } from '../tagColors';
import { useScanStatus } from '../useScanStatus';

export default function Settings() {
  const [roots, setRoots] = useState<RootConfig[]>([]);
  const [newLabel, setNewLabel] = useState('');
  const [newPath, setNewPath] = useState('');
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanningRoot, setScanningRoot] = useState<string | null>(null);

  const [plateSize, setPlateSize] = useState<PlateSize>({ x: 256, y: 256 });
  const [plateSaved, setPlateSaved] = useState<string | null>(null);

  const [tags, setTags] = useState<TagInfo[]>([]);
  const [missingCount, setMissingCount] = useState(0);
  const [purging, setPurging] = useState(false);
  const { status: scanStatus, refresh: refreshScan } = useScanStatus();
  const [cancelling, setCancelling] = useState(false);

  const reload = () => api.getRoots().then(setRoots);
  const reloadTags = () => api.listTags().then(setTags);
  const reloadMissing = () =>
    api.listFiles({ missingOnly: true, pageSize: 1 }).then((r) => setMissingCount(r.total));

  useEffect(() => {
    reload();
    reloadTags();
    reloadMissing();
    api.getSettings().then((s) => {
      setPlateSize(s.defaultPlateSize);
    });
  }, []);

  const addRoot = () => {
    if (!newPath.trim()) return;
    const updated = [...roots, { label: newLabel.trim() || newPath.trim(), path: newPath.trim() }];
    api.setRoots(updated).then(setRoots);
    setNewLabel('');
    setNewPath('');
  };

  const removeRoot = (path: string) => {
    const updated = roots.filter((r) => r.path !== path);
    api.setRoots(updated).then(setRoots);
  };

  const scan = (root?: string, mode?: ScanMode) => {
    if (root) setScanningRoot(root);
    else setScanning(true);
    setScanResult(null);
    setCancelling(false);
    // Kick a status poll immediately so the progress bar appears without the 15s idle delay.
    setTimeout(refreshScan, 100);
    api
      .scan(root, mode)
      .then((r) => {
        setScanResult(r);
        reloadMissing();
      })
      .finally(() => {
        setScanning(false);
        setScanningRoot(null);
        refreshScan();
      });
  };

  const cancelScan = () => {
    setCancelling(true);
    api.cancelScan().finally(refreshScan);
  };

  const purgeMissing = () => {
    if (!window.confirm(`Remove ${missingCount} missing file${missingCount === 1 ? '' : 's'} from the catalogue? Tags and notes on them are lost. Files on disk are not touched.`))
      return;
    setPurging(true);
    api
      .purgeMissing()
      .then(reloadMissing)
      .finally(() => setPurging(false));
  };

  const scanBusy = scanning || scanningRoot !== null || scanStatus.scanning;

  const savePlateSize = () => {
    setPlateSaved(null);
    api
      .updateSettings({ defaultPlateSize: plateSize })
      .then((s) => {
        setPlateSize(s.defaultPlateSize);
        setPlateSaved('Saved');
      })
      .catch(() => setPlateSaved('Enter positive width and depth in mm'));
  };

  const setTagColor = (name: string, color: string | null) => {
    api.setTagColor(name, color).then((updated) => {
      setTags((prev) => prev.map((t) => (t.name === name ? updated : t)));
    });
  };

  const deleteTag = (name: string) => {
    if (!window.confirm(`Delete the tag "${name}" from every file?`)) return;
    api.deleteTag(name).then(() => setTags((prev) => prev.filter((t) => t.name !== name)));
  };

  return (
    <div>
      <h2>Settings</h2>

      <section>
        <h3>Watched folders</h3>
        <table className="file-table">
          <thead>
            <tr>
              <th>Label</th>
              <th>Path</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {roots.map((r) => (
              <tr key={r.path}>
                <td>
                  {r.label}
                  {r.managed && <span className="muted"> · auto</span>}
                </td>
                <td>{r.path}</td>
                <td>
                  <button disabled={scanBusy} onClick={() => scan(r.label)}>
                    {scanningRoot === r.label ? 'Scanning...' : 'Rescan'}
                  </button>{' '}
                  {r.managed ? (
                    <span className="muted" title="Configured via the environment (e.g. a Docker mount)">
                      from environment
                    </span>
                  ) : (
                    <button onClick={() => removeRoot(r.path)}>Remove</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="add-root-form">
          <input placeholder="Label (optional)" value={newLabel} onChange={(e) => setNewLabel(e.target.value)} />
          <input placeholder="Folder path, e.g. C:/Users/you/3D Prints" value={newPath} onChange={(e) => setNewPath(e.target.value)} />
          <button onClick={addRoot}>Add folder</button>
        </div>
      </section>

      <section>
        <h3>Default build-plate size</h3>
        <p className="muted">
          Used in the 3D viewer for files that don't declare their own plate (STL/OBJ and non-Bambu 3MFs).
          Bambu Lab 3MFs carry their own plate size and ignore this.
        </p>
        <div className="plate-size-form">
          <label>
            Width (mm)
            <input
              type="number"
              min={1}
              value={plateSize.x}
              onChange={(e) => setPlateSize((p) => ({ ...p, x: Number(e.target.value) }))}
            />
          </label>
          <label>
            Depth (mm)
            <input
              type="number"
              min={1}
              value={plateSize.y}
              onChange={(e) => setPlateSize((p) => ({ ...p, y: Number(e.target.value) }))}
            />
          </label>
          <button onClick={savePlateSize}>Save</button>
          {plateSaved && <span className="muted">{plateSaved}</span>}
        </div>
      </section>

      <section>
        <h3>Tags</h3>
        {tags.length === 0 ? (
          <p className="muted">No tags yet. Add tags to files from the library or a file's detail page.</p>
        ) : (
          <table className="file-table tag-manage-table">
            <thead>
              <tr>
                <th>Tag</th>
                <th>Files</th>
                <th>Colour</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {tags.map((t) => (
                <tr key={t.name}>
                  <td>
                    <span className="tag-chip" style={tagChipStyle(t.name, t.color)}>
                      {t.name}
                    </span>
                  </td>
                  <td>{t.count}</td>
                  <td>
                    <div className="tag-color-picker">
                      {TAG_COLOR_PRESETS.map((preset) => (
                        <button
                          key={preset}
                          type="button"
                          className={`tag-color-swatch${t.color === preset ? ' active' : ''}`}
                          style={{ backgroundColor: preset }}
                          aria-label={`Set ${t.name} colour to ${preset}`}
                          onClick={() => setTagColor(t.name, preset)}
                        />
                      ))}
                      <input
                        type="color"
                        className="tag-color-custom"
                        value={resolveTagColor(t.name, t.color)}
                        aria-label={`Custom colour for ${t.name}`}
                        onChange={(e) => setTagColor(t.name, e.target.value)}
                      />
                      {t.color && (
                        <button type="button" className="tag-color-reset" onClick={() => setTagColor(t.name, null)}>
                          Auto
                        </button>
                      )}
                    </div>
                  </td>
                  <td>
                    <button onClick={() => deleteTag(t.name)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h3>Scan</h3>
        <p className="muted">Scans every watched folder. Use the Rescan button next to a folder above to scan just that one.</p>
        <div className="scan-actions">
          <button disabled={scanBusy || scanStatus.scanning} onClick={() => scan()}>
            {scanStatus.scanning ? 'Scanning…' : 'Rescan all'}
          </button>
          {scanStatus.scanning && (
            <button className="secondary" disabled={cancelling} onClick={cancelScan}>
              {cancelling ? 'Stopping…' : 'Cancel'}
            </button>
          )}
        </div>

        {scanStatus.scanning && (
          <div className="scan-progress" aria-live="polite">
            <div className="scan-progress-bar">
              <span
                style={{
                  width:
                    scanStatus.progress.total > 0
                      ? `${Math.round((scanStatus.progress.processed / scanStatus.progress.total) * 100)}%`
                      : '0%',
                }}
              />
            </div>
            <p className="muted">
              {scanStatus.progress.phase === 'walking'
                ? 'Finding files…'
                : scanStatus.progress.phase === 'flagging-missing'
                  ? 'Checking for removed files…'
                  : scanStatus.progress.phase === 'finalizing'
                    ? 'Finalizing…'
                    : `${scanStatus.progress.processed} / ${scanStatus.progress.total}`}
              {scanStatus.progress.currentFile ? ` · ${scanStatus.progress.currentFile}` : ''}
              {scanStatus.progress.added || scanStatus.progress.updated
                ? ` · +${scanStatus.progress.added} new, ${scanStatus.progress.updated} updated`
                : ''}
            </p>
          </div>
        )}

        {!scanStatus.scanning && scanResult && (
          <p>
            {scanResult.cancelled ? 'Scan cancelled — ' : ''}
            Added: {scanResult.added}, Updated: {scanResult.updated}, Missing: {scanResult.missing}
          </p>
        )}

        {!scanStatus.scanning && scanStatus.pendingReprocess > 0 && (
          <p className="muted">
            {scanStatus.pendingReprocess} file{scanStatus.pendingReprocess === 1 ? '' : 's'} need a
            metadata update (new scan-time processing available).{' '}
            <button className="linklike" onClick={() => scan(undefined, 'reprocess-stale')}>
              Update now
            </button>{' '}
            — no folder walk, just reprocesses those files.
          </p>
        )}
      </section>

      <section>
        <h3>Missing files</h3>
        <p className="muted">
          Files flagged missing on the last scan (not found on disk). Their tags and notes are
          kept in case a drive was just unplugged. Removing them clears those rows and their
          cached thumbnails — the files on disk are never touched.
        </p>
        {missingCount === 0 ? (
          <p className="muted">No missing files.</p>
        ) : (
          <p>
            <Link to="/?missing=1">
              {missingCount} missing file{missingCount === 1 ? '' : 's'}
            </Link>{' '}
            <button disabled={purging} onClick={purgeMissing}>
              {purging ? 'Removing…' : 'Remove all from catalogue'}
            </button>
          </p>
        )}
      </section>
    </div>
  );
}
