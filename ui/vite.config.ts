import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.VITE_PORT ?? 5273),
    strictPort: true,
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET ?? 'http://localhost:3000',
        configure: (proxy) => {
          // When the backend dies mid-stream (e.g. server restart), http-proxy
          // neither errors nor ends the client response — the browser socket
          // dangles open and EventSource never notices the SSE connection is
          // dead (verified: vite held browser sockets with no upstream).
          // Propagate upstream termination so the browser reconnects.
          proxy.on('proxyRes', (proxyRes, _req, res) => {
            proxyRes.on('close', () => {
              if (!res.writableEnded) {
                res.destroy();
              }
            });
          });
          proxy.on('error', (_err, _req, res) => {
            res.destroy();
          });
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
  },
});
