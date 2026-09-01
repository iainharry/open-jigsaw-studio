import { defineConfig } from 'vite';

export default defineConfig(({ command }) => ({
  // Production builds are pathed for GitHub Pages project hosting, but the dev server
  // stays at the root so `http://localhost:5173` works without remembering a sub-path.
  // Override for root hosting or a native shell with: VITE_BASE=/ npm run build
  base: command === 'build' ? (process.env.VITE_BASE ?? '/open-jigsaw-studio/') : '/',
  build: {
    target: 'es2022',
    sourcemap: true,
  },
}));
