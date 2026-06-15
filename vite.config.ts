import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  root: resolve(__dirname, 'src/electron/renderer'),
  build: {
    outDir: resolve(__dirname, 'dist/electron/renderer'),
    emptyOutDir: true,
  },
});
