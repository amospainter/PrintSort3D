import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let tmp: string;
let modelsParent: string;
let loadConfig: typeof import('./config').loadConfig;
let saveConfig: typeof import('./config').saveConfig;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-config-test-'));
  process.env.CONFIG_PATH = path.join(tmp, 'config.json');

  modelsParent = path.join(tmp, 'models');
  fs.mkdirSync(path.join(modelsParent, 'prints'), { recursive: true });
  fs.mkdirSync(path.join(modelsParent, 'downloads'), { recursive: true });
  fs.writeFileSync(path.join(modelsParent, 'loose-file.txt'), 'not a dir');

  ({ loadConfig, saveConfig } = await import('./config'));
});

afterEach(() => {
  delete process.env.PRINTSORT_ROOTS;
  delete process.env.PRINTSORT_MODELS_DIR;
  try {
    fs.unlinkSync(process.env.CONFIG_PATH as string);
  } catch {
    /* no config written this test */
  }
});

describe('env-derived roots', () => {
  it('has no managed roots when neither env var is set', () => {
    expect(loadConfig().roots).toEqual([]);
  });

  it('turns each immediate subdirectory of PRINTSORT_MODELS_DIR into a managed root', () => {
    process.env.PRINTSORT_MODELS_DIR = modelsParent;
    const { roots } = loadConfig();
    expect(roots).toEqual(
      expect.arrayContaining([
        { label: 'prints', path: path.join(modelsParent, 'prints'), managed: true },
        { label: 'downloads', path: path.join(modelsParent, 'downloads'), managed: true },
      ])
    );
    expect(roots).toHaveLength(2); // the loose .txt file is not a directory
  });

  it('parses PRINTSORT_ROOTS entries ("Label=/path" and bare "/path")', () => {
    process.env.PRINTSORT_ROOTS = `Vehicles=${path.join(tmp, 'v')};${path.join(tmp, 'misc')}`;
    const { roots } = loadConfig();
    expect(roots).toEqual([
      { label: 'Vehicles', path: path.join(tmp, 'v'), managed: true },
      { label: 'misc', path: path.join(tmp, 'misc'), managed: true },
    ]);
  });

  it('merges managed roots after user roots and dedupes by path (env wins)', () => {
    const shared = path.join(tmp, 'shared');
    saveConfig({ roots: [{ label: 'User Shared', path: shared }, { label: 'User Only', path: path.join(tmp, 'only') }] });
    process.env.PRINTSORT_ROOTS = `Managed Shared=${shared}`;

    const { roots } = loadConfig();
    expect(roots).toEqual([
      { label: 'User Only', path: path.join(tmp, 'only') },
      { label: 'Managed Shared', path: shared, managed: true },
    ]);
  });

  it('never persists managed roots to config.json', () => {
    process.env.PRINTSORT_MODELS_DIR = modelsParent;
    const cfg = loadConfig();
    saveConfig({ roots: [...cfg.roots, { label: 'Hand Added', path: path.join(tmp, 'hand') }] });

    const onDisk = JSON.parse(fs.readFileSync(process.env.CONFIG_PATH as string, 'utf-8'));
    expect(onDisk.roots).toEqual([{ label: 'Hand Added', path: path.join(tmp, 'hand') }]);
  });
});
