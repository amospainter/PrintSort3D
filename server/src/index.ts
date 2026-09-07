import { db } from './db';
import './paths';
import { createApp } from './app';
import { runScan } from './scanner';
import { pruneOrphanAssets } from './assets';

const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;
// Bind loopback by default so a fresh install isn't reachable from the LAN with no auth.
// Set HOST=0.0.0.0 (the Docker image does) to expose it — pair that with PRINTSORT_PASSWORD
// or a reverse proxy. See server/src/security.ts.
const HOST = process.env.HOST ?? '127.0.0.1';

// Opt-in: scan every watched folder once on boot so freshly-mounted sources (Docker volume
// mounts, env-derived roots) are catalogued without anyone clicking "Rescan". Runs after the
// server is already listening and never blocks it; a rescan of an unchanged catalog is cheap.
const scanOnStartup = /^(1|true|yes)$/i.test(process.env.SCAN_ON_STARTUP ?? '');

createApp().listen(PORT, HOST, () => {
  console.log(`printsort3d server listening on http://${HOST}:${PORT}`);

  // Sweep asset directories left behind by removed files (purge-missing / DELETE / a crash
  // mid-teardown). Cheap: one query + a readdir.
  try {
    const liveIds = new Set(
      (db.prepare('SELECT id FROM files').all() as { id: number }[]).map((r) => r.id)
    );
    const pruned = pruneOrphanAssets(liveIds);
    if (pruned > 0) console.log(`Pruned ${pruned} orphaned asset director${pruned === 1 ? 'y' : 'ies'}`);
  } catch (err) {
    console.error('Orphan-asset prune failed:', err);
  }

  if (scanOnStartup) {
    console.log('Startup scan: running...');
    runScan()
      .then((r) => console.log(`Startup scan: added ${r.added}, updated ${r.updated}, missing ${r.missing}`))
      .catch((err) => console.error('Startup scan failed:', err));
  }
});
