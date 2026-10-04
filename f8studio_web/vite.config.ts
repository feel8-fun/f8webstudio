import frontend from './package.json';
import backend from '../component.json';
import react from '@vitejs/plugin-react';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  build: { outDir: '../build/web-studio', emptyOutDir: true },
  plugins: [react(), {
    name: 'f8-component-release',
    generateBundle() {
      if (frontend.version !== backend.version) throw new Error('WebStudio frontend/backend versions must match');
      this.emitFile({ type: 'asset', fileName: 'f8-release.json', source: JSON.stringify({ componentId: backend.componentId, version: backend.version }) });
    },
  }],
  server: {
    proxy: {
      '/api': { target: 'http://127.0.0.1:8210', ws: true },
    },
  },
  test: {
    environment: 'jsdom',
    exclude: [...configDefaults.exclude, 'e2e/**'],
    setupFiles: ['./src/test/setup.ts'],
  },
});
