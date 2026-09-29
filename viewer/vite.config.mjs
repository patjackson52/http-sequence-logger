import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)), base: './', plugins: [react()],
  server: { host: '127.0.0.1', port: 4173, strictPort: true, fs: { allow: [fileURLToPath(new URL('..', import.meta.url))] } },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
  // The viewer CSP permits same-origin fonts, not inlined data URLs.
  build: { outDir: 'dist', emptyOutDir: true, assetsInlineLimit: 0 },
  worker: { format: 'es' },
});
