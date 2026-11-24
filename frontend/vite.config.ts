import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: { sourcemap: 'hidden' },   // maps are generated for error tracking but not referenced by the served files
  server: {
    port: 5173,
    proxy: { '/api': { target: process.env.API_URL || 'http://localhost:4000', changeOrigin: false } },
  },
});
