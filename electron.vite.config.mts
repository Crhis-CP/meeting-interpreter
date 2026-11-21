import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(import.meta.dirname, 'src/main/index.ts'),
          'local-asr-worker': resolve(import.meta.dirname, 'src/main/providers/local-asr/worker.ts'),
          'local-ai-worker': resolve(import.meta.dirname, 'src/main/providers/local-ai/worker.ts'),
          'neural-tts-worker': resolve(import.meta.dirname, 'src/main/providers/neural-tts/worker.ts'),
        },
      },
    },
    resolve: { alias: { '@core': resolve(import.meta.dirname, 'src/core'), '@shared': resolve(import.meta.dirname, 'src/shared') } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(import.meta.dirname, 'src/preload/index.ts'),
          audio: resolve(import.meta.dirname, 'src/preload/audio.ts'),
        },
      },
    },
    resolve: { alias: { '@shared': resolve(import.meta.dirname, 'src/shared') } },
  },
  renderer: {
    root: resolve(import.meta.dirname, 'src/renderer'),
    plugins: [react()],
    resolve: {
      alias: {
        '@core': resolve(import.meta.dirname, 'src/core'),
        '@shared': resolve(import.meta.dirname, 'src/shared'),
        '@renderer': resolve(import.meta.dirname, 'src/renderer/src'),
      },
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(import.meta.dirname, 'src/renderer/index.html'),
          overlay: resolve(import.meta.dirname, 'src/renderer/overlay.html'),
          audio: resolve(import.meta.dirname, 'src/renderer/audio.html'),
          room: resolve(import.meta.dirname, 'src/renderer/room.html'),
        },
      },
    },
  },
});
