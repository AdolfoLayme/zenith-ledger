import { copyFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const extDir = import.meta.dirname;
const outDir = resolve(extDir, 'dist');

export default defineConfig({
  root: extDir,
  envDir: resolve(extDir, '..'),
  base: './',
  publicDir: false,
  plugins: [
    react(),
    {
      name: 'copy-extension-manifest',
      closeBundle() {
        mkdirSync(outDir, { recursive: true });
        copyFileSync(resolve(extDir, 'manifest.json'), resolve(outDir, 'manifest.json'));
        copyFileSync(resolve(extDir, 'background.js'), resolve(outDir, 'background.js'));
      },
    },
  ],
  build: {
    outDir,
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(extDir, 'sidepanel.html'),
    },
  },
});
