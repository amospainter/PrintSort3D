import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let tmpRoot: string;
let openInSlicer: typeof import('./openInApp').openInSlicer;
let saveConfig: typeof import('./config').saveConfig;

async function waitForFile(p: string, timeoutMs = 4000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(p)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'open-in-app-test-'));
  process.env.CONFIG_PATH = path.join(tmpRoot, 'config.json');
  ({ openInSlicer } = await import('./openInApp'));
  ({ saveConfig } = await import('./config'));
});

afterAll(() => {
  delete process.env.PRINTSORT_SLICER_COMMAND;
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('openInSlicer — configured command', () => {
  it('spawns the configured executable with the file path as its sole argument', async () => {
    // Use the Node binary itself as the "slicer": it will execute the path we hand it as a
    // script. Point that at a tiny script that writes a marker file, so we can prove the
    // spawn actually happened and the argument was passed through — no real GUI involved.
    const marker = path.join(tmpRoot, 'opened.marker');
    const script = path.join(tmpRoot, 'fake-slicer-target.js');
    fs.writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ok');`);

    saveConfig({ roots: [], slicerCommand: process.execPath });

    const result = await openInSlicer(script);
    expect(result.ok).toBe(true);
    expect(result.method).toBe('configured');
    expect(result.command).toBe(process.execPath);

    expect(await waitForFile(marker)).toBe(true);
    expect(fs.readFileSync(marker, 'utf-8')).toBe('ok');
  });

  it('reports ok:false with an error message when the configured command does not exist', async () => {
    saveConfig({ roots: [], slicerCommand: path.join(tmpRoot, 'does-not-exist-slicer') });
    const result = await openInSlicer(path.join(tmpRoot, 'model.3mf'));

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('prefers PRINTSORT_SLICER_COMMAND over the persisted config value', async () => {
    saveConfig({ roots: [], slicerCommand: '/persisted/slicer' });
    process.env.PRINTSORT_SLICER_COMMAND = process.execPath;

    const marker = path.join(tmpRoot, 'env-opened.marker');
    const script = path.join(tmpRoot, 'env-target.js');
    fs.writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'env');`);

    const result = await openInSlicer(script);
    expect(result.command).toBe(process.execPath);
    expect(await waitForFile(marker)).toBe(true);

    delete process.env.PRINTSORT_SLICER_COMMAND;
  });
});
