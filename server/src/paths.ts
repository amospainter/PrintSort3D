import fs from 'fs';
import path from 'path';

// Every per-file cached artifact — the thumbnail PNG, embedded-image WebPs, and the baked
// render mesh — lives under ASSETS_DIR/<fileId>/. (Thumbnails used to have their own
// THUMBNAILS_DIR; db.ts migrates any leftovers from that layout on startup.)
export const ASSETS_DIR = process.env.ASSETS_DIR ?? path.join(__dirname, '..', 'assets');

if (!fs.existsSync(ASSETS_DIR)) {
  fs.mkdirSync(ASSETS_DIR, { recursive: true });
}
