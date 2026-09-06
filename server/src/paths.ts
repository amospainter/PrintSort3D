import fs from 'fs';
import path from 'path';

export const THUMBNAILS_DIR = process.env.THUMBNAILS_DIR ?? path.join(__dirname, '..', 'thumbnails');
export const ASSETS_DIR = process.env.ASSETS_DIR ?? path.join(__dirname, '..', 'assets');

for (const dir of [THUMBNAILS_DIR, ASSETS_DIR]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
