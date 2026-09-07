import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import type { Express } from 'express';

let tmpRoot: string;
let db: typeof import('./db').db;
let createApp: typeof import('./app').createApp;

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-security-test-'));
  process.env.DB_PATH = path.join(tmpRoot, 'test.db');
  process.env.CONFIG_PATH = path.join(tmpRoot, 'config.json');
  process.env.ASSETS_DIR = path.join(tmpRoot, 'assets');
  fs.mkdirSync(process.env.ASSETS_DIR, { recursive: true });

  ({ db } = await import('./db'));
  ({ createApp } = await import('./app'));
});

afterEach(() => {
  delete process.env.PRINTSORT_PASSWORD;
  delete process.env.PRINTSORT_READONLY;
  delete process.env.PRINTSORT_CORS_ORIGINS;
  delete process.env.PRINTSORT_ROOTS_LOCKED;
});

afterAll(() => {
  db.close();
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* Windows lock */
  }
});

describe('no env set (default)', () => {
  it('serves the API with no auth and no CORS headers', async () => {
    const app = createApp();
    const res = await request(app).get('/api/tags');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('refuses a mutating request from a foreign Origin (CSRF guard)', async () => {
    const app = createApp();
    const res = await request(app)
      .put('/api/settings')
      .set('Origin', 'https://evil.example')
      .send({ defaultPlateSize: { x: 256, y: 256 } });
    expect(res.status).toBe(403);
  });

  it('allows a mutating request with a same-origin Origin header', async () => {
    const app = createApp();
    const res = await request(app)
      .put('/api/settings')
      .set('Host', 'localhost:3001')
      .set('Origin', 'http://localhost:3001')
      .send({ defaultPlateSize: { x: 256, y: 256 } });
    expect(res.status).toBe(200);
  });

  it('allows a mutating request with no Origin header (curl / same-origin nav)', async () => {
    const app = createApp();
    const res = await request(app).put('/api/settings').send({ defaultPlateSize: { x: 256, y: 256 } });
    expect(res.status).toBe(200);
  });
});

describe('PRINTSORT_PASSWORD', () => {
  it('401s without credentials and sets WWW-Authenticate', async () => {
    process.env.PRINTSORT_PASSWORD = 's3cret';
    const app = createApp();
    const res = await request(app).get('/api/tags');
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toMatch(/^Basic/);
  });

  it('accepts the right password with any username, rejects the wrong one', async () => {
    process.env.PRINTSORT_PASSWORD = 's3cret';
    const app = createApp();
    const good = Buffer.from('anyone:s3cret').toString('base64');
    const bad = Buffer.from('anyone:nope').toString('base64');
    expect((await request(app).get('/api/tags').set('Authorization', `Basic ${good}`)).status).toBe(200);
    expect((await request(app).get('/api/tags').set('Authorization', `Basic ${bad}`)).status).toBe(401);
  });
});

describe('PRINTSORT_READONLY', () => {
  it('allows GET but 403s every mutation', async () => {
    process.env.PRINTSORT_READONLY = '1';
    const app = createApp();
    expect((await request(app).get('/api/tags')).status).toBe(200);
    const res = await request(app).put('/api/settings').send({ defaultPlateSize: { x: 256, y: 256 } });
    expect(res.status).toBe(403);
    expect((await request(app).post('/api/scan')).status).toBe(403);
  });
});

describe('PRINTSORT_CORS_ORIGINS', () => {
  it('echoes an allowlisted origin and lets it mutate cross-origin', async () => {
    process.env.PRINTSORT_CORS_ORIGINS = 'https://models.example';
    const app = createApp();
    const res = await request(app).get('/api/tags').set('Origin', 'https://models.example');
    expect(res.headers['access-control-allow-origin']).toBe('https://models.example');

    const put = await request(app)
      .put('/api/settings')
      .set('Origin', 'https://models.example')
      .send({ defaultPlateSize: { x: 256, y: 256 } });
    expect(put.status).toBe(200);
  });
});

describe('PRINTSORT_ROOTS_LOCKED', () => {
  it('403s PUT /api/roots', async () => {
    process.env.PRINTSORT_ROOTS_LOCKED = '1';
    const app = createApp();
    const res = await request(app).put('/api/roots').send([]);
    expect(res.status).toBe(403);
  });
});
