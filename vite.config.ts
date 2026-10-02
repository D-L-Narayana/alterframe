import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// Shared build config. Owner: W10 may extend (e.g. test config), others must not edit.
export default defineConfig({
  // Relative base: the bundle works at the domain root (Vercel) and under a sub-path (private previews).
  base: './',
  plugins: [react()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  assetsInclude: ['**/*.task', '**/*.tflite', '**/*.glsl', '**/*.frag', '**/*.vert'],
  server: { port: 5173, strictPort: true, headers: { 'Permissions-Policy': 'camera=(self), microphone=()' } },
  build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 1500 },
  optimizeDeps: { exclude: ['@mediapipe/tasks-vision'] },
});
