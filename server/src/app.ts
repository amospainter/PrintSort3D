import express from 'express';
import fs from 'fs';
import path from 'path';
import { router } from './routes';
import {
  corsMiddleware,
  basicAuthMiddleware,
  csrfGuardMiddleware,
  readonlyMiddleware,
} from './security';

// When a built client is present (Docker / single-deployable setups), serve it from the
// same origin as the API so the app is reachable on one port with no reverse proxy.
// In dev this is absent and Vite serves the client on :5173, proxying /api here.
function resolveClientDist(): string | null {
  // Opt-in only: an explicit CLIENT_DIST, or NODE_ENV=production (how the Docker image runs).
  // Dev and tests never serve static assets from here — Vite owns the client in dev.
  if (!process.env.CLIENT_DIST && process.env.NODE_ENV !== 'production') return null;
  const candidates = process.env.CLIENT_DIST
    ? [process.env.CLIENT_DIST]
    : [path.join(__dirname, '..', '..', 'client', 'dist'), path.join(__dirname, '..', 'client')];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'index.html'))) return dir;
  }
  return null;
}

export function createApp() {
  const app = express();
  // Order matters: CORS first (so its preflight response beats every guard), then auth, then
  // the CSRF and read-only guards, then body parsing and routes. All the guards are no-ops
  // unless their env var is set — see security.ts.
  app.use(corsMiddleware());
  app.use(basicAuthMiddleware());
  app.use(csrfGuardMiddleware());
  app.use(readonlyMiddleware());
  // 2mb is ample: the largest body any route accepts is a roots array or a tag list. (This
  // was 25mb for a since-removed client thumbnail-upload endpoint.)
  app.use(express.json({ limit: '2mb' }));
  app.use('/api', router);

  const clientDist = resolveClientDist();
  if (clientDist) {
    app.use(express.static(clientDist));
    // SPA fallback: any non-/api GET that didn't match a static file gets index.html
    // so client-side routes (e.g. /files/12) work on a hard refresh.
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/') || !req.accepts('html')) return next();
      res.sendFile(path.join(clientDist, 'index.html'));
    });
  }

  return app;
}
