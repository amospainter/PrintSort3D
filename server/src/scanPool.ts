import path from 'path';
import { Worker } from 'worker_threads';
import { extractArtifacts, type FileArtifacts } from './scanArtifacts';

/**
 * Optional worker-thread pool for the CPU-bound "extract" half of a scan (baking meshes,
 * rendering thumbnails, hashing, WebP conversion). Off by default — set `SCAN_WORKERS=<n>`
 * to spread a big scan across cores. The DB writes stay on the main thread (single writer),
 * so a worker never touches SQLite; see scanArtifacts.ts.
 *
 * When workers are disabled, or if a worker fails to spin up (e.g. a stripped-down runtime),
 * everything falls back to running `extractArtifacts` inline on the main thread — the exact
 * path the tests exercise.
 */

const REQUESTED = Math.max(0, Math.floor(Number(process.env.SCAN_WORKERS) || 0));

interface Pending {
  resolve: (a: FileArtifacts) => void;
  reject: (e: Error) => void;
}

interface PoolWorker {
  worker: Worker;
  busy: boolean;
}

let pool: PoolWorker[] | null = null;
let degraded = false;
const pendingById = new Map<number, Pending>();
const queue: { id: number; fileId: number; fullPath: string; ext: string }[] = [];
let nextId = 1;

function workerEntry(): { file: string; execArgv: string[] } {
  const ext = path.extname(__filename); // ".ts" under ts-node(-dev), ".js" when compiled
  return {
    file: path.join(__dirname, `scanWorker${ext}`),
    execArgv: ext === '.ts' ? ['-r', 'ts-node/register/transpile-only'] : [],
  };
}

function spinUp(): void {
  if (pool || degraded || REQUESTED === 0) return;
  const { file, execArgv } = workerEntry();
  try {
    const created: PoolWorker[] = [];
    for (let i = 0; i < REQUESTED; i++) {
      const worker = new Worker(file, { execArgv });
      const pw: PoolWorker = { worker, busy: false };
      worker.on('message', (msg: { id: number; ok: boolean; artifacts?: FileArtifacts; error?: string }) => {
        const p = pendingById.get(msg.id);
        pendingById.delete(msg.id);
        pw.busy = false;
        if (p) {
          if (msg.ok && msg.artifacts) p.resolve(msg.artifacts);
          else p.reject(new Error(msg.error ?? 'worker failed'));
        }
        pump();
      });
      worker.on('error', (err) => {
        // A worker crashed — reject anything it was holding and stop using the pool.
        console.error('scan worker error, falling back to inline processing:', err);
        degraded = true;
        for (const [, p] of pendingById) p.reject(err);
        pendingById.clear();
        queue.length = 0;
      });
      created.push(pw);
    }
    pool = created;
    console.log(`Scan pool: ${REQUESTED} worker${REQUESTED === 1 ? '' : 's'}`);
  } catch (err) {
    console.error('Scan pool failed to start, using inline processing:', err);
    degraded = true;
  }
}

function pump(): void {
  if (!pool) return;
  for (const pw of pool) {
    if (pw.busy || queue.length === 0) continue;
    const job = queue.shift()!;
    pw.busy = true;
    pw.worker.postMessage(job);
  }
}

export function extractArtifactsPooled(
  fileId: number,
  fullPath: string,
  ext: string
): Promise<FileArtifacts> {
  spinUp();
  if (!pool || degraded) return extractArtifacts(fileId, fullPath, ext);

  return new Promise<FileArtifacts>((resolve, reject) => {
    const id = nextId++;
    pendingById.set(id, { resolve, reject });
    queue.push({ id, fileId, fullPath, ext });
    pump();
  }).catch((err) => {
    // If the pool degraded mid-flight, retry this file inline rather than failing the scan.
    if (degraded) return extractArtifacts(fileId, fullPath, ext);
    throw err;
  });
}

export async function shutdownScanPool(): Promise<void> {
  if (!pool) return;
  await Promise.all(pool.map((pw) => pw.worker.terminate()));
  pool = null;
}
