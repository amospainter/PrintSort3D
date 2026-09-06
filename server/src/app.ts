import express from 'express';
import cors from 'cors';
import { router } from './routes';

export function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '25mb' }));
  app.use('/api', router);
  return app;
}
