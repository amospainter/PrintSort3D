import { useEffect, useState } from 'react';
import { Routes, Route, Link, useLocation, useSearchParams } from 'react-router-dom';
import Library from './pages/Library';
import Detail from './pages/Detail';
import Settings from './pages/Settings';
import { api, type RootConfig } from './api';
import { GridIcon, CopyIcon, GearIcon, FolderIcon, PlusIcon, RefreshIcon } from './Icons';

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
  const [dupCount, setDupCount] = useState(0);
  const [scanning, setScanning] = useState(false);
  // Label of the single source currently being rescanned, or null. Distinct from `scanning`
  // (the whole-library pass) so only the row being scanned shows a spinner.
  const [scanningRoot, setScanningRoot] = useState<string | null>(null);

  const refreshSidebar = () => {
    api.getRoots().then(setRoots);
    api.listFiles({ duplicatesOnly: true, pageSize: 1 }).then((res) => setDupCount(res.total));
  };

  useEffect(refreshSidebar, [location.pathname]);

  const busy = scanning || scanningRoot !== null;

  const runScan = (root?: string) => {
    if (root) setScanningRoot(root);
    else setScanning(true);
    api
      .scan(root)
      .then(refreshSidebar)
      .finally(() => {
        setScanning(false);
        setScanningRoot(null);
      });
  };

  const onLibrary = location.pathname === '/';
  const activeRoot = searchParams.get('root');
  const isDuplicatesView = onLibrary && searchParams.get('dup') === '1';
  const isAllModelsView = onLibrary && !isDuplicatesView && !activeRoot;

  return (
    <div className="app">
      <aside className="sidebar">
        <Link to="/" className="brand">
          <span className="brand-mark">🖨️</span> PrintSort3D
        </Link>

        <nav className="sidebar-nav">
          <SidebarLink to="/" active={isAllModelsView} icon={<GridIcon />}>
            All models
          </SidebarLink>
          <SidebarLink to="/?dup=1" active={isDuplicatesView} icon={<CopyIcon />} badge={dupCount}>
            Duplicates
          </SidebarLink>
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
            {roots.map((r) => (
              <div key={r.path} className="sidebar-source-row">
                <SidebarLink
                  to={`/?root=${encodeURIComponent(r.label)}`}
                  active={onLibrary && activeRoot === r.label}
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
            ))}
            {roots.length === 0 && <p className="sidebar-empty muted">No folders added yet</p>}
          </nav>
        </div>

        <div className="sidebar-footer">
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
  );
}
