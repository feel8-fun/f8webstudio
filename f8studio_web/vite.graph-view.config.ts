import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../build/graph-view',
    emptyOutDir: true,
    lib: { entry: 'src/graph-view.ts', formats: ['es'], fileName: 'graph-view', cssFileName: 'graph-view' },
    rolldownOptions: { external: ['react', 'react-dom', 'react/jsx-runtime', '@xyflow/react'] },
  },
});
