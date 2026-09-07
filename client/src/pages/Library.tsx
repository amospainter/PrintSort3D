import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, type FileEntry, type TagInfo } from '../api';
import { Menu, MenuItem } from '../Menu';
import { TagInput } from '../TagInput';
import { TagChip } from '../TagChip';
import { tagColorMap } from '../tagColors';
import { SearchIcon, GridIcon, ListIcon } from '../Icons';

type ViewMode = 'grid' | 'table';

const PAGE_SIZE_OPTIONS = [10, 15, 20, 30, 40, 50] as const;
const DEFAULT_PAGE_SIZE = 20;
const EXT_TABS = [
  { value: '', label: 'All' },
  { value: '.stl', label: 'STL' },
  { value: '.3mf', label: '3MF' },
  { value: '.obj', label: 'OBJ' },
  { value: '.zip', label: 'ZIP' },
] as const;
const SORT_OPTIONS = [
  { value: 'name', label: 'Name' },
  { value: 'added', label: 'Date added' },
  { value: 'mtime', label: 'Date modified' },
  { value: 'size', label: 'Size' },
] as const;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// relativePath includes the filename and may use OS-specific separators (scanned with path.relative);
// normalize to "/" and drop the filename so this reads as the subfolder within the library.
function subfolder(f: FileEntry): string {
  const parts = f.relativePath.split(/[\\/]/);
  parts.pop();
  return parts.join('/');
}

function fileLocation(f: FileEntry): string {
  const sub = subfolder(f);
  return sub ? `${f.root.label} / ${sub}` : f.root.label ?? '';
}

function parseTagsParam(raw: string | null): string[] {
  return (raw ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

export default function Library() {
  // All filter/sort/pagination state lives in the URL rather than component state, so
  // navigating to a file's Detail page and back restores exactly where you left off —
  // the browser's back button returns to this same URL (react-router doesn't touch
  // Library's history entry when pushing Detail's), whereas plain useState would reset
  // on remount since Library unmounts while Detail is shown.
  const [searchParams, setSearchParams] = useSearchParams();

  const query = searchParams.get('q') ?? '';
  const tagsFilter = useMemo(() => parseTagsParam(searchParams.get('tags')), [searchParams]);
  const extFilter = searchParams.get('ext') ?? '';
  const rootFilter = searchParams.get('root') ?? '';
  const folderFilter = searchParams.get('folder') ?? '';
  const duplicatesOnly = searchParams.get('dup') === '1';
  const sort = searchParams.get('sort') ?? 'added';
  const view = (searchParams.get('view') as ViewMode) || 'grid';
  const page = Math.max(1, Number(searchParams.get('page')) || 1);
  const pageSize = Number(searchParams.get('pageSize')) || DEFAULT_PAGE_SIZE;

  // Sidebar-driven view title — mirrors which of the sidebar's "All models" / "Duplicates" /
  // source links produced the current URL, so the page heading stays in sync with it.
  const folderSegments = folderFilter ? folderFilter.split('/') : [];
  const pageTitle = duplicatesOnly
    ? 'Duplicates'
    : folderSegments.length > 0
      ? folderSegments[folderSegments.length - 1]
      : rootFilter || 'All models';

  const [files, setFiles] = useState<FileEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [allTags, setAllTags] = useState<TagInfo[]>([]);
  const tagNames = useMemo(() => allTags.map((t) => t.name), [allTags]);
  const tagColors = useMemo(() => tagColorMap(allTags), [allTags]);
  const [rescanningIds, setRescanningIds] = useState<Set<number>>(new Set());

  // ---- Multi-select (click, shift-range, or rubber-band drag) → bulk tag ----
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [band, setBand] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);
  const lastIndexRef = useRef<number | null>(null);
  const dragBaseRef = useRef<Set<number>>(new Set());
  const suppressClickRef = useRef(false);

  const selectedFiles = useMemo(() => files.filter((f) => selectedIds.has(f.id)), [files, selectedIds]);
  const selectionTagUnion = useMemo(
    () => [...new Set(selectedFiles.flatMap((f) => f.tags))].sort(),
    [selectedFiles]
  );

  const clearSelection = () => {
    setSelectedIds(new Set());
    lastIndexRef.current = null;
  };

  const toggleSelect = (id: number, index: number, range: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (range && lastIndexRef.current != null) {
        const [lo, hi] = [lastIndexRef.current, index].sort((a, b) => a - b);
        for (let i = lo; i <= hi; i++) next.add(files[i].id);
      } else if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
    lastIndexRef.current = index;
  };

  const applyBulkTag = (change: { add?: string[]; remove?: string[] }) => {
    if (selectedIds.size === 0) return;
    setBulkBusy(true);
    api
      .bulkTag([...selectedIds], change)
      .then(() => Promise.all([loadInto(), api.listTags().then(setAllTags)]))
      .finally(() => setBulkBusy(false));
  };

  // Merges a patch into the URL's search params. Resets to page 1 by default (any filter
  // change invalidates the current page's contents) — pass resetPage: false for changes
  // that don't affect the result set (view toggle) or that are themselves a page change.
  // `replace: true` keeps every in-Library filter tweak on one history entry instead of
  // spamming "back" with every keystroke; Detail's own navigation still pushes normally.
  const updateParams = (patch: Record<string, string | null>, resetPage = true) => {
    const next = new URLSearchParams(searchParams);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === '') next.delete(k);
      else next.set(k, v);
    }
    if (resetPage) next.delete('page');
    setSearchParams(next, { replace: true });
  };

  // Reload the current result set without touching selection (used after a bulk tag edit,
  // where the selected cards should stay selected but show their new tags).
  const loadInto = () =>
    api
      .listFiles({
        query: query || undefined,
        root: rootFilter || undefined,
        folder: folderFilter || undefined,
        tags: tagsFilter.length > 0 ? tagsFilter : undefined,
        ext: extFilter || undefined,
        duplicatesOnly: duplicatesOnly || undefined,
        sort,
        page,
        pageSize,
      })
      .then((res) => {
        setFiles(res.items);
        setTotal(res.total);
        setTotalPages(res.totalPages);
      });

  const load = () => {
    setLoading(true);
    loadInto().finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
    api.listTags().then(setAllTags);
    clearSelection();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const goToPage = (p: number) => updateParams({ page: String(Math.min(Math.max(1, p), totalPages)) }, false);

  const addTagFilter = (tag: string) => {
    if (tagsFilter.includes(tag)) return;
    updateParams({ tags: [...tagsFilter, tag].join(',') });
  };

  // Per-file rescan, for quick re-testing scan-time logic on a single file instead of
  // waiting on a full library scan. Reloads the current page afterward so the card
  // reflects whatever changed (thumbnail, hashes, plates, dimensions, ...).
  const rescanOne = (id: number) => {
    setRescanningIds((prev) => new Set(prev).add(id));
    api
      .rescanFile(id)
      .then(load)
      .finally(() => {
        setRescanningIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      });
  };

  // Rubber-band drag select over the grid background. Holding Shift/Ctrl/Cmd on mousedown
  // adds to the existing selection instead of replacing it.
  const onGridMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0 || view !== 'grid') return;
    if ((e.target as HTMLElement).closest('button, a[href], input, .tag-chip, .card-menu')) return;
    const startX = e.clientX;
    const startY = e.clientY;
    dragBaseRef.current = e.shiftKey || e.metaKey || e.ctrlKey ? new Set(selectedIds) : new Set();
    let moved = false;

    const onMove = (ev: MouseEvent) => {
      if (!moved && Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) < 6) return;
      moved = true;
      const rect = {
        x0: Math.min(startX, ev.clientX),
        y0: Math.min(startY, ev.clientY),
        x1: Math.max(startX, ev.clientX),
        y1: Math.max(startY, ev.clientY),
      };
      setBand(rect);
      const next = new Set(dragBaseRef.current);
      gridRef.current?.querySelectorAll<HTMLElement>('[data-file-id]').forEach((el) => {
        const r = el.getBoundingClientRect();
        const hit = !(r.right < rect.x0 || r.left > rect.x1 || r.bottom < rect.y0 || r.top > rect.y1);
        if (hit) next.add(Number(el.dataset.fileId));
      });
      setSelectedIds(next);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      setBand(null);
      if (moved) {
        suppressClickRef.current = true;
        setTimeout(() => {
          suppressClickRef.current = false;
        }, 0);
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const selecting = selectedIds.size > 0;

  const onCardClick = (e: React.MouseEvent, f: FileEntry, index: number) => {
    if (suppressClickRef.current) {
      e.preventDefault();
      return;
    }
    if (selecting || e.shiftKey || e.metaKey || e.ctrlKey) {
      e.preventDefault();
      toggleSelect(f.id, index, e.shiftKey);
    }
  };

  return (
    <div>
      <div className="page-heading">
        <h1>{pageTitle}</h1>
        {!loading && <span className="page-heading-count">{total} model{total === 1 ? '' : 's'}</span>}
      </div>

      {folderFilter && (
        <div className="folder-breadcrumb">
          <Link to={`/?root=${encodeURIComponent(rootFilter)}`}>{rootFilter || 'All models'}</Link>
          {folderSegments.map((seg, i) => {
            const partial = folderSegments.slice(0, i + 1).join('/');
            const isLast = i === folderSegments.length - 1;
            return (
              <span key={partial}>
                <span className="folder-breadcrumb-sep">/</span>
                {isLast ? (
                  <span>{seg}</span>
                ) : (
                  <Link to={`/?root=${encodeURIComponent(rootFilter)}&folder=${encodeURIComponent(partial)}`}>
                    {seg}
                  </Link>
                )}
              </span>
            );
          })}
        </div>
      )}

      <div className="toolbar">
        <div className="search-input-wrap">
          <SearchIcon className="search-input-icon" />
          <input
            className="search-input"
            placeholder="Search models..."
            value={query}
            onChange={(e) => updateParams({ q: e.target.value })}
          />
        </div>
        <TagInput
          className="toolbar-tag-filter"
          value={tagsFilter}
          onChange={(tags) => updateParams({ tags: tags.join(',') || null })}
          suggestions={tagNames}
          colors={tagColors}
          placeholder="Filter by tag…"
        />

        <div className="segmented">
          {EXT_TABS.map((tab) => (
            <button
              key={tab.value}
              type="button"
              className={extFilter === tab.value ? 'active' : ''}
              onClick={() => updateParams({ ext: tab.value })}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <select aria-label="Sort by" value={sort} onChange={(e) => updateParams({ sort: e.target.value }, false)}>
          {SORT_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>

        <div className="view-toggle">
          <button
            aria-label="Grid view"
            className={view === 'grid' ? 'active' : ''}
            onClick={() => updateParams({ view: 'grid' }, false)}
          >
            <GridIcon />
          </button>
          <button
            aria-label="Table view"
            className={view === 'table' ? 'active' : ''}
            onClick={() => updateParams({ view: 'table' }, false)}
          >
            <ListIcon />
          </button>
        </div>
      </div>

      {selecting && (
        <div className="bulk-bar">
          <span className="bulk-bar-count">{selectedIds.size} selected</span>
          <button type="button" onClick={() => setSelectedIds(new Set(files.map((f) => f.id)))}>
            Select page
          </button>
          <button type="button" onClick={clearSelection}>
            Clear
          </button>
          <TagInput
            value={[]}
            onChange={(tags) => tags.length > 0 && applyBulkTag({ add: tags })}
            suggestions={tagNames}
            colors={tagColors}
            placeholder={bulkBusy ? 'Working…' : 'Add tag to selected…'}
          />
          {selectionTagUnion.length > 0 && (
            <div className="card-tags">
              {selectionTagUnion.map((t) => (
                <TagChip
                  key={t}
                  name={t}
                  color={tagColors.get(t)}
                  onClick={() => applyBulkTag({ remove: [t] })}
                />
              ))}
              <span className="filament-swatch-label">(click a tag to remove it from all selected)</span>
            </div>
          )}
        </div>
      )}

      {loading && <p>Loading...</p>}
      {!loading && files.length === 0 && <p>No files found. Add root folders in Settings and rescan.</p>}

      {!loading && view === 'grid' && (
        <div className="grid grid-selectable" ref={gridRef} onMouseDown={onGridMouseDown}>
          {files.map((f, index) => (
            <Link
              to={`/files/${f.id}`}
              key={f.id}
              data-file-id={f.id}
              className={`card ${f.missing ? 'missing' : ''} ${selectedIds.has(f.id) ? 'selected' : ''}`}
              onClick={(e) => onCardClick(e, f, index)}
            >
              <div className="card-thumb">
                {(selecting || selectedIds.has(f.id)) && (
                  <span className="card-select-box">{selectedIds.has(f.id) ? '✓' : ''}</span>
                )}
                {f.thumbnailUrl ? (
                  <img src={f.thumbnailUrl} alt={f.filename} />
                ) : (
                  <div className="thumb-placeholder">
                    {f.ext === '.zip' && f.archiveEntryCount != null
                      ? `${f.archiveEntryCount} model${f.archiveEntryCount === 1 ? '' : 's'}`
                      : ''}
                  </div>
                )}
                <span className="card-ext-badge">{f.ext.replace('.', '').toUpperCase()}</span>
                <div className="card-menu">
                  <Menu triggerLabel={`Actions for ${f.filename}`} trigger="⋮">
                    <MenuItem disabled={rescanningIds.has(f.id)} onSelect={() => rescanOne(f.id)}>
                      {rescanningIds.has(f.id) ? 'Rescanning…' : '↻ Rescan this file'}
                    </MenuItem>
                  </Menu>
                </div>
              </div>
              <div className="card-body">
                <div className="card-name">{f.filename}</div>
                <div className="card-location">{fileLocation(f)}</div>
                <div className="card-size">{formatSize(f.sizeBytes)}</div>
                <div className="card-tags">
                  {f.tags.map((t) => (
                    <TagChip key={t} name={t} color={tagColors.get(t)} onClick={() => addTagFilter(t)} />
                  ))}
                </div>
                {f.duplicateCount > 0 && (
                  <div>
                    <span className="dup-badge">⧉ {f.duplicateCount} duplicate{f.duplicateCount === 1 ? '' : 's'}</span>
                  </div>
                )}
              </div>
            </Link>
          ))}
        </div>
      )}

      {!loading && view === 'table' && (
        <table className="file-table">
          <thead>
            <tr>
              <th></th>
              <th>Name</th>
              <th>Library</th>
              <th>Path</th>
              <th>Type</th>
              <th>Size</th>
              <th>Tags</th>
            </tr>
          </thead>
          <tbody>
            {files.map((f, index) => (
              <tr key={f.id} className={f.missing ? 'missing' : ''}>
                <td>
                  <input
                    type="checkbox"
                    aria-label={`Select ${f.filename}`}
                    checked={selectedIds.has(f.id)}
                    onChange={(e) => toggleSelect(f.id, index, (e.nativeEvent as MouseEvent).shiftKey)}
                  />
                </td>
                <td>
                  <Link to={`/files/${f.id}`}>{f.filename}</Link>
                </td>
                <td>{f.root.label}</td>
                <td className="muted">{subfolder(f) || '—'}</td>
                <td>{f.ext}</td>
                <td>{formatSize(f.sizeBytes)}</td>
                <td>
                  {f.tags.map((t) => (
                    <TagChip key={t} name={t} color={tagColors.get(t)} onClick={() => addTagFilter(t)} />
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {band && (
        <div
          className="rubber-band"
          style={{ left: band.x0, top: band.y0, width: band.x1 - band.x0, height: band.y1 - band.y0 }}
        />
      )}

      {!loading && total > 0 && (
        <div className="pagination">
          <select
            className="page-size-select"
            aria-label="Items per page"
            value={pageSize}
            onChange={(e) => updateParams({ pageSize: e.target.value })}
          >
            {PAGE_SIZE_OPTIONS.map((size) => (
              <option key={size} value={size}>
                {size} / page
              </option>
            ))}
          </select>
          <button disabled={page <= 1} onClick={() => goToPage(page - 1)}>
            Prev
          </button>
          <span className="pagination-status">
            Page {page} of {totalPages}
          </span>
          <button disabled={page >= totalPages} onClick={() => goToPage(page + 1)}>
            Next
          </button>
        </div>
      )}
    </div>
  );
}
