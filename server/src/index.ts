import './db';
import './paths';
import { createApp } from './app';

const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;

createApp().listen(PORT, () => {
  console.log(`3d-tracker server listening on http://localhost:${PORT}`);
});
