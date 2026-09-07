import crypto from 'crypto';
import type { RequestHandler } from 'express';
import cors from 'cors';

/**
 * Security middleware for a local-first app that people nonetheless expose on a LAN or behind
 * a reverse proxy. All of it is off by default so a pure-localhost user sees no change; each
 * piece turns on via an env var.
 *
 *   PRINTSORT_PASSWORD        require HTTP Basic auth on every request (any username)
 *   PRINTSORT_CORS_ORIGINS    comma-separated origin allowlist for cross-origin browser calls
 *   PRINTSORT_READONLY=1      reject every state-changing request (GET/HEAD/OPTIONS only)
 *
 * A cross-origin CSRF guard on mutating methods is always on: a POST/PUT/PATCH/DELETE whose
 * `Origin` header is neither same-origin nor in the CORS allowlist is refused. This blocks a
 * malicious page from driving the API with the browser's ambient credentials even when Basic
 * auth is set, and needs no client cooperation (same-origin requests omit `Origin` or send a
 * matching one).
 */

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function corsOrigins(): string[] {
  return (process.env.PRINTSORT_CORS_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Enables CORS only when an explicit allowlist is configured; otherwise no CORS headers. */
export function corsMiddleware(): RequestHandler {
  const origins = corsOrigins();
  if (origins.length === 0) return (_req, _res, next) => next();
  return cors({ origin: origins, credentials: true });
}

function timingSafeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** HTTP Basic auth, enabled only when PRINTSORT_PASSWORD is set. Username is ignored. */
export function basicAuthMiddleware(): RequestHandler {
  const password = process.env.PRINTSORT_PASSWORD;
  if (!password) return (_req, _res, next) => next();

  return (req, res, next) => {
    // Let CORS preflight through — it never carries credentials and the browser blocks the
    // real request anyway if the preflight's headers don't check out.
    if (req.method === 'OPTIONS') return next();

    const header = req.headers.authorization ?? '';
    const [scheme, encoded] = header.split(' ');
    if (scheme === 'Basic' && encoded) {
      const decoded = Buffer.from(encoded, 'base64').toString('utf8');
      const idx = decoded.indexOf(':');
      const supplied = idx >= 0 ? decoded.slice(idx + 1) : decoded;
      if (timingSafeEqual(supplied, password)) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="PrintSort3D", charset="UTF-8"');
    return res.status(401).json({ error: 'authentication required' });
  };
}

/** Rejects every mutating request when PRINTSORT_READONLY is truthy. */
export function readonlyMiddleware(): RequestHandler {
  const readonly = /^(1|true|yes)$/i.test(process.env.PRINTSORT_READONLY ?? '');
  if (!readonly) return (_req, _res, next) => next();
  return (req, res, next) => {
    if (!MUTATING.has(req.method)) return next();
    return res.status(403).json({ error: 'server is in read-only mode' });
  };
}

/**
 * CSRF guard: a mutating request carrying an `Origin` that is neither same-origin nor
 * allowlisted is refused. Requests with no `Origin` (curl, same-origin navigations in some
 * browsers, server-to-server) are allowed through — Basic auth / network placement is the
 * control for those.
 */
export function csrfGuardMiddleware(): RequestHandler {
  const allowed = new Set(corsOrigins());
  return (req, res, next) => {
    if (!MUTATING.has(req.method)) return next();
    const origin = req.headers.origin;
    if (!origin) return next();
    if (allowed.has(origin)) return next();

    // Same-origin: the request's Origin matches the Host it was sent to.
    const host = req.headers.host;
    if (host) {
      try {
        if (new URL(origin).host === host) return next();
      } catch {
        /* malformed Origin — fall through to reject */
      }
    }
    return res.status(403).json({ error: 'cross-origin request refused' });
  };
}
