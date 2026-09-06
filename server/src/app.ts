import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { router } from './routes';

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
  app.use(cors());
  app.use(express.json({ limit: '25mb' }));
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
