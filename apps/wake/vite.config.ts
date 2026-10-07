import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportData } from '../../packages/map/vite/export-data';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAP = path.resolve(HERE, '../../packages/map');
const WAKE = path.resolve(HERE, '../..');

export default defineConfig({
  // `?data=<name>` is the no-daemon fallback, served by the same middleware
  // the spike uses: the export itself plus /file and /diff from its repo.path.
  plugins: [solid(), exportData()],
  resolve: {
    alias: [
      { find: '@wake/map/style.css', replacement: path.join(MAP, 'src/style.css') },
      { find: '@wake/map/splash.css', replacement: path.join(MAP, 'src/splash.css') },
      { find: /^@wake\/map$/, replacement: path.join(MAP, 'src/index.ts') }
    ]
  },
  server: {
    port: 5200,
    strictPort: true,
    fs: { allow: [HERE, MAP, path.join(WAKE, '.wake')] }
  },
  preview: { port: 5200, strictPort: true },
  worker: { format: 'es' },
  build: { target: 'es2022', sourcemap: false }
});
