import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Present the proxied call to the API as same-origin: changeOrigin rewrites Host, and
      // the proxyReq hook rewrites Origin to match. Without this the server's cross-origin
      // CSRF guard (server/src/security.ts) rejects every mutation from the dev client,
      // which the browser sees as originating from :5173.
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            if (proxyReq.getHeader('origin')) {
              proxyReq.setHeader('origin', 'http://localhost:3001');
            }
          });
        },
      },
    },
  },
})
