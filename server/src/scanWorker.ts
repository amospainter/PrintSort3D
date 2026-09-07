import { parentPort } from 'worker_threads';
import sharp from 'sharp';
import { extractArtifacts } from './scanArtifacts';

// Each worker runs its own libvips thread pool; with several workers that multiplies fast.
// Pin sharp to one thread per worker — the parallelism we want is across files, not within
// one image conversion.
sharp.concurrency(1);

interface Request {
  id: number;
  fileId: number;
  fullPath: string;
  ext: string;
}

if (!parentPort) throw new Error('scanWorker must run as a worker thread');

parentPort.on('message', async (req: Request) => {
  try {
    const artifacts = await extractArtifacts(req.fileId, req.fullPath, req.ext);
    parentPort!.postMessage({ id: req.id, ok: true, artifacts });
  } catch (err) {
    parentPort!.postMessage({
      id: req.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});
