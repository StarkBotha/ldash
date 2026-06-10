import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.VITE_PORT ?? 5273),
    strictPort: true,
    proxy: {
      '/api': process.env.VITE_API_TARGET ?? 'http://localhost:3000',
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
  },
});
