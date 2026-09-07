import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { loadConfig } from './config';

/**
 * Launches the user's slicer with a local model file. This is only reachable from the
 * (localhost) API — routes.ts gates it to loopback callers — because it shells out to a
 * desktop GUI app, which is meaningless (and undesirable) for a remote or containerized
 * request.
 *
 * Resolution order:
 *   1. `config.slicerCommand` (Settings UI / PRINTSORT_SLICER_COMMAND) if set — spawned with
 *      the file path as its sole argument.
 *   2. An auto-detected Bambu Studio install for the current platform.
 *   3. The OS default handler for the file's extension (Windows `start`, macOS `open`,
 *      Linux `xdg-open`).
 */

// Common Bambu Studio install locations, checked in order. `bambu-studio.exe` is the
// Windows binary name; macOS ships an .app bundle opened via `open -a`.
function windowsBambuCandidates(): string[] {
  const out: string[] = [];
  for (const base of [process.env['ProgramFiles'], process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]) {
    if (base) out.push(path.join(base, 'Bambu Studio', 'bambu-studio.exe'));
  }
  if (process.env.LOCALAPPDATA) {
    out.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Bambu Studio', 'bambu-studio.exe'));
  }
  return out;
}

const LINUX_BAMBU_CANDIDATES = [
  '/usr/bin/bambu-studio',
  '/usr/local/bin/bambu-studio',
  '/opt/bambu-studio/bambu-studio',
];

export interface OpenResult {
  ok: boolean;
  method: 'configured' | 'bambu-studio' | 'os-default';
  command: string;
  error?: string;
}

function firstExisting(paths: string[]): string | null {
  for (const p of paths) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  return null;
}

interface Launch {
  command: string;
  args: string[];
  method: OpenResult['method'];
}

function resolveLaunch(filePath: string): Launch {
  const configured = loadConfig().slicerCommand;
  if (configured) return { command: configured, args: [filePath], method: 'configured' };

  if (process.platform === 'win32') {
    const exe = firstExisting(windowsBambuCandidates());
    if (exe) return { command: exe, args: [filePath], method: 'bambu-studio' };
    // `start` is a cmd builtin; the empty "" is the window-title positional so a quoted
    // path isn't swallowed as the title.
    return { command: 'cmd', args: ['/c', 'start', '', filePath], method: 'os-default' };
  }

  if (process.platform === 'darwin') {
    if (fs.existsSync('/Applications/BambuStudio.app')) {
      return { command: 'open', args: ['-a', 'BambuStudio', filePath], method: 'bambu-studio' };
    }
    return { command: 'open', args: [filePath], method: 'os-default' };
  }

  const linuxExe = firstExisting(LINUX_BAMBU_CANDIDATES);
  if (linuxExe) return { command: linuxExe, args: [filePath], method: 'bambu-studio' };
  return { command: 'xdg-open', args: [filePath], method: 'os-default' };
}

// spawn() reports a missing executable asynchronously via an 'error' event, not by throwing,
// so this resolves only once the child has either actually started ('spawn') or failed
// ('error'). A short timeout resolves ok as a safety net in case neither fires.
export function openInSlicer(filePath: string): Promise<OpenResult> {
  const { command, args, method } = resolveLaunch(filePath);
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: OpenResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    try {
      const child = spawn(command, args, { detached: true, stdio: 'ignore' });
      child.on('error', (err) => done({ ok: false, method, command, error: err.message }));
      child.on('spawn', () => {
        child.unref();
        done({ ok: true, method, command });
      });
      setTimeout(() => done({ ok: true, method, command }), 1500);
    } catch (err) {
      done({ ok: false, method, command, error: err instanceof Error ? err.message : String(err) });
    }
  });
}
