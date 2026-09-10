import { defineConfig } from 'vite';
import pkg from './package.json' with { type: 'json' };

export default defineConfig(({ command }) => ({
  // The guide prints the version it describes. Injected from package.json rather than
  // typed into the source, because a version number kept in two places is a version
  // number that is wrong in one of them.
  define: { __APP_VERSION__: JSON.stringify(`v${pkg.version}`) },
  // Production builds are pathed for GitHub Pages project hosting, but the dev server
  // stays at the root so `http://localhost:5173` works without remembering a sub-path.
  // Override for root hosting or a native shell with: VITE_BASE=/ npm run build
  base: command === 'build' ? (process.env.VITE_BASE ?? '/open-jigsaw-studio/') : '/',
  build: {
    target: 'es2022',
    sourcemap: true,
  },
}));
