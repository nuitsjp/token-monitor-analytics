import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import { fileURLToPath } from 'node:url';

const local = (path: string) => fileURLToPath(new URL(path, import.meta.url));
export default defineConfig({
  root: local('.'),
  plugins: [
    tanstackRouter({
      target: 'react',
      routesDirectory: local('./src/routes'),
      generatedRouteTree: local('./src/routeTree.gen.ts'),
      autoCodeSplitting: false,
    }),
    react(),
  ],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: 'http://127.0.0.1:3000', changeOrigin: true } },
  },
  build: { outDir: 'dist', target: 'es2022', sourcemap: false, emptyOutDir: true },
});
