import { useEffect, useMemo, useRef, useState } from 'react';
import { Routes, Route, Link, useLocation, useSearchParams } from 'react-router-dom';
import Library from './pages/Library';
import Detail from './pages/Detail';
import Settings from './pages/Settings';
import ThemeToggle from './ThemeToggle';
import { api, type FolderEntry, type RootConfig } from './api';
import { useScanStatus } from './useScanStatus';
import {
  ChevronDownIcon,
  GridIcon,
  CopyIcon,
  GearIcon,
  FolderIcon,
  PlusIcon,
  RefreshIcon,
  AlertIcon,
  MenuIcon,
} from './Icons';

const MOBILE_QUERY = '(max-width: 860px)';
const isMobile = () => typeof window !== 'undefined' && window.matchMedia(MOBILE_QUERY).matches;

interface FolderNode {
  name: string;
  path: string;
  fileCount: number;
  children: FolderNode[];
}

// Turns the server's flat, pre-sorted folder list (every ancestor dir included) into a
// forest. Parents always precede their children in the sorted input, so a lookup by path
// is enough; anything whose parent is somehow absent is promoted to a top-level node.
function buildForest(folders: FolderEntry[]): FolderNode[] {
  const byPath = new Map<string, FolderNode>();
  const roots: FolderNode[] = [];
  for (const f of folders) {
    const node: FolderNode = { name: f.name, path: f.path, fileCount: f.fileCount, children: [] };
    byPath.set(f.path, node);
    const slash = f.path.lastIndexOf('/');
    const parent = slash === -1 ? undefined : byPath.get(f.path.slice(0, slash));
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

function FolderTreeNode({
  node,
  rootLabel,
  activeFolder,
  expanded,
  toggle,
  depth,
}: {
  node: FolderNode;
  rootLabel: string;
  activeFolder: string | null;
  expanded: Set<string>;
  toggle: (path: string) => void;
  depth: number;
}) {
  const hasChildren = node.children.length > 0;
  const isOpen = expanded.has(node.path);
  const isActive = activeFolder === node.path;
  return (
    <>
      <div className="sidebar-folder-row" style={{ paddingLeft: depth * 12 }}>
        {hasChildren ? (
          <button
            type="button"
            className="icon-button sidebar-folder-toggle"
            aria-label={isOpen ? `Collapse ${node.name}` : `Expand ${node.name}`}
            onClick={() => toggle(node.path)}
          >
            <ChevronDownIcon className={isOpen ? '' : 'chevron-collapsed'} />
          </button>
        ) : (
          <span className="sidebar-folder-toggle" />
        )}
        <Link
          to={`/?root=${encodeURIComponent(rootLabel)}&folder=${encodeURIComponent(node.path)}`}
          className={`sidebar-link sidebar-folder-link${isActive ? ' active' : ''}`}
        >
          <span className="sidebar-link-icon">
            <FolderIcon />
          </span>
          <span className="sidebar-link-label">{node.name}</span>
          <span className="sidebar-badge">{node.fileCount}</span>
        </Link>
      </div>
      {isOpen &&
        node.children.map((child) => (
          <FolderTreeNode
            key={child.path}
            node={child}
            rootLabel={rootLabel}
            activeFolder={activeFolder}
            expanded={expanded}
            toggle={toggle}
            depth={depth + 1}
          />
        ))}
    </>
  );
}

function FolderTree({
  rootLabel,
  folders,
  activeFolder,
}: {
  rootLabel: string;
  folders: FolderEntry[];
  activeFolder: string | null;
}) {
  const forest = useMemo(() => buildForest(folders), [folders]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Auto-expand every ancestor of the active folder so it's always revealed in the tree.
  useEffect(() => {
    if (!activeFolder) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      const parts = activeFolder.split('/');
      let acc = '';
      for (const p of parts) {
        acc = acc ? `${acc}/${p}` : p;
        next.add(acc);
      }
      return next;
    });
  }, [activeFolder]);

  const toggle = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  if (forest.length === 0) return null;

  return (
    <div className="sidebar-folder-tree">
      {forest.map((node) => (
        <FolderTreeNode
          key={node.path}
          node={node}
          rootLabel={rootLabel}
          activeFolder={activeFolder}
          expanded={expanded}
          toggle={toggle}
          depth={0}
        />
      ))}
    </div>
  );
}

function SidebarLink({
  to,
  active,
  icon,
  children,
  badge,
}: {
  to: string;
  active: boolean;
  icon: React.ReactNode;
  children: React.ReactNode;
  badge?: number;
}) {
  return (
    <Link to={to} className={`sidebar-link${active ? ' active' : ''}`}>
      <span className="sidebar-link-icon">{icon}</span>
      <span className="sidebar-link-label">{children}</span>
      {!!badge && <span className="sidebar-badge">{badge}</span>}
    </Link>
  );
}

export default function App() {
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const [roots, setRoots] = useState<RootConfig[]>([]);
  const [folders, setFolders] = useState<FolderEntry[]>([]);
  const [dupCount, setDupCount] = useState(0);
  const [missingCount, setMissingCount] = useState(0);
  const [scanning, setScanning] = useState(false);
  // Label of the single source currently being rescanned, or null. Distinct from `scanning`
  // (the whole-library pass) so only the row being scanned shows a spinner.
  const [scanningRoot, setScanningRoot] = useState<string | null>(null);
  const { status: scanStatus, refresh: refreshScan } = useScanStatus();

  // Sidebar: a persistent column on desktop (collapsible, preference stored per browser) and
  // an off-canvas drawer on mobile (starts closed, closes on navigation / backdrop / Esc).
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    if (isMobile()) return false;
    try {
      return localStorage.getItem('printsort3d-sidebar') !== '0';
    } catch {
      return true;
    }
  });
  const toggleSidebar = () =>
    setSidebarOpen((open) => {
      const next = !open;
      if (!isMobile()) {
        try {
          localStorage.setItem('printsort3d-sidebar', next ? '1' : '0');
        } catch {
          /* private mode */
        }
      }
      return next;
    });

  const refreshSidebar = () => {
    api.getRoots().then(setRoots);
    api.listFolders().then(setFolders);
    api.listFiles({ duplicatesOnly: true, pageSize: 1 }).then((res) => setDupCount(res.total));
    api.listFiles({ missingOnly: true, pageSize: 1 }).then((res) => setMissingCount(res.total));
  };

  useEffect(refreshSidebar, [location.pathname]);

  // Close the mobile drawer whenever navigation happens (tapping a source link, a card, etc.).
  useEffect(() => {
    if (isMobile()) setSidebarOpen(false);
  }, [location.pathname, location.search]);

  // Esc closes the mobile drawer.
  useEffect(() => {
    if (!sidebarOpen || !isMobile()) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setSidebarOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sidebarOpen]);

  // Refresh sidebar counts when a scan (started here or anywhere) finishes.
  const wasScanning = useRef(false);
  useEffect(() => {
    if (wasScanning.current && !scanStatus.scanning) refreshSidebar();
    wasScanning.current = scanStatus.scanning;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanStatus.scanning]);

  const foldersByRoot = useMemo(() => {
    const map = new Map<string, FolderEntry[]>();
    for (const f of folders) {
      const list = map.get(f.root) ?? [];
      list.push(f);
      map.set(f.root, list);
    }
    return map;
  }, [folders]);

  const busy = scanning || scanningRoot !== null || scanStatus.scanning;

  const runScan = (root?: string) => {
    if (root) setScanningRoot(root);
    else setScanning(true);
    setTimeout(refreshScan, 100);
    api
      .scan(root)
      .then(refreshSidebar)
      .finally(() => {
        setScanning(false);
        setScanningRoot(null);
        refreshScan();
      });
  };

  const onLibrary = location.pathname === '/';
  const activeRoot = searchParams.get('root');
  const activeFolder = searchParams.get('folder');
  const isDuplicatesView = onLibrary && searchParams.get('dup') === '1';
  const isMissingView = onLibrary && searchParams.get('missing') === '1';
  const isAllModelsView = onLibrary && !isDuplicatesView && !isMissingView && !activeRoot;

  return (
    <div className={`app-shell${sidebarOpen ? ' sidebar-open' : ''}`}>
      <header className="topbar">
        <button
          type="button"
          className="topbar-toggle"
          aria-label={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
          aria-expanded={sidebarOpen}
          onClick={toggleSidebar}
        >
          <MenuIcon />
        </button>
        <Link to="/" className="brand">
          <span className="brand-mark">🖨️</span> PrintSort3D
        </Link>
      </header>

      <div className="app">
        <div
          className="sidebar-backdrop"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
        <aside className="sidebar">
          <nav className="sidebar-nav">
          <SidebarLink to="/" active={isAllModelsView} icon={<GridIcon />}>
            All models
          </SidebarLink>
          <SidebarLink to="/?dup=1" active={isDuplicatesView} icon={<CopyIcon />} badge={dupCount}>
            Duplicates
          </SidebarLink>
          {(missingCount > 0 || isMissingView) && (
            <SidebarLink to="/?missing=1" active={isMissingView} icon={<AlertIcon />} badge={missingCount}>
              Missing
            </SidebarLink>
          )}
        </nav>

        <div className="sidebar-section">
          <div className="sidebar-section-header">
            <span>Sources</span>
            <div className="sidebar-section-actions">
              <button
                type="button"
                className="icon-button"
                aria-label="Rescan all sources"
                disabled={busy}
                onClick={() => runScan()}
              >
                <RefreshIcon className={scanning ? 'spin' : ''} />
              </button>
              <Link to="/settings" className="icon-button" aria-label="Add a source">
                <PlusIcon />
              </Link>
            </div>
          </div>
          <nav className="sidebar-nav">
            {roots.map((r) => {
              const isActiveRoot = onLibrary && activeRoot === r.label;
              const rootFolders = foldersByRoot.get(r.label) ?? [];
              return (
                <div key={r.path}>
                  <div className="sidebar-source-row">
                    <SidebarLink
                      to={`/?root=${encodeURIComponent(r.label)}`}
                      active={isActiveRoot && !activeFolder}
                      icon={<FolderIcon />}
                    >
                      {r.label}
                    </SidebarLink>
                    <button
                      type="button"
                      className="icon-button sidebar-source-rescan"
                      aria-label={`Rescan ${r.label}`}
                      disabled={busy}
                      onClick={() => runScan(r.label)}
                    >
                      <RefreshIcon className={scanningRoot === r.label ? 'spin' : ''} />
                    </button>
                  </div>
                  {isActiveRoot && rootFolders.length > 0 && (
                    <FolderTree
                      rootLabel={r.label}
                      folders={rootFolders}
                      activeFolder={activeFolder}
                    />
                  )}
                </div>
              );
            })}
            {roots.length === 0 && <p className="sidebar-empty muted">No folders added yet</p>}
          </nav>
        </div>

        <div className="sidebar-footer">
          <ThemeToggle />
          <SidebarLink to="/settings" active={location.pathname === '/settings'} icon={<GearIcon />}>
            Settings
          </SidebarLink>
        </div>
        </aside>

        <div className="app-content">
          <main>
            <Routes>
              <Route path="/" element={<Library />} />
              <Route path="/files/:id" element={<Detail />} />
              <Route path="/settings" element={<Settings />} />
            </Routes>
          </main>
        </div>
      </div>
    </div>
  );
}
