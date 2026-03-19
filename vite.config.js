import { defineConfig } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.json';

export default defineConfig({
  plugins: [crx({ manifest })],
  build: {
    rollupOptions: {
      input: {
        background: 'src/background/index.js',
      },
      output: {
        // Give the background script a stable, predictable filename
        entryFileNames: (chunk) => {
          if (chunk.name === 'background') return 'assets/background.js';
          return 'assets/[name]-[hash].js';
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    hmr: {
      port: 5173,
    },
  }
});
