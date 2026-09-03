import './ui/style.css';
import { App } from './ui/app.js';

const root = document.getElementById('app');
if (!root) throw new Error('#app is missing from index.html');
const app = new App(root);

// Exposed so `scripts/bench.mjs` can drive the real app rather than a stub.
// Harmless in production and deliberately not part of any public API.
(globalThis as unknown as { __ojs?: App }).__ojs = app;

// Register the service worker only in a built app. In dev it would cache the dev
// server's modules and make every code change look like it did not take effect.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, {
      scope: import.meta.env.BASE_URL,
    });
  });
}
