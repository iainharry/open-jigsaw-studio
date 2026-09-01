import { defineConfig } from 'vite';

// Base is set for GitHub Pages project-page hosting.
// Override with `VITE_BASE=/ npm run build` for root hosting or a Tauri shell.
export default defineConfig({
  base: process.env.VITE_BASE ?? '/open-jigsaw-studio/',
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
