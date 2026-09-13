import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// COOP/COEP make SharedArrayBuffer available (AudioWorklet ring buffer,
// ffmpeg.wasm threads). Spec 9.5. Community assets are fetched with CORP headers.
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'cross-origin',
};

export default defineConfig({
  plugins: [svelte()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    headers: isolationHeaders,
    // Tauri dev: let the shell reach the dev server, ignore Rust churn
    watch: { ignored: ['**/src-tauri/**', '**/crates/**', '**/services/**'] },
  },
  preview: { port: 4173, headers: isolationHeaders },
  worker: { format: 'es' },
  assetsInclude: ['**/*.wasm', '**/*.task'],
  optimizeDeps: {
    exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'],
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three'],
          mediapipe: ['@mediapipe/tasks-vision'],
        },
      },
    },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
} as any);
