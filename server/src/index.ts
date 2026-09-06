import './db';
import './paths';
import { createApp } from './app';
import { runScan } from './scanner';

const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;

// Opt-in: scan every watched folder once on boot so freshly-mounted sources (Docker volume
// mounts, env-derived roots) are catalogued without anyone clicking "Rescan". Runs after the
// server is already listening and never blocks it; a rescan of an unchanged catalog is cheap.
const scanOnStartup = /^(1|true|yes)$/i.test(process.env.SCAN_ON_STARTUP ?? '');

createApp().listen(PORT, () => {
  console.log(`3d-tracker server listening on http://localhost:${PORT}`);
  if (scanOnStartup) {
    console.log('Startup scan: running...');
    runScan()
      .then((r) => console.log(`Startup scan: added ${r.added}, updated ${r.updated}, missing ${r.missing}`))
      .catch((err) => console.error('Startup scan failed:', err));
  }
});
