import './ui/style.css';
import { App } from './ui/app.js';

const root = document.getElementById('app');
if (!root) throw new Error('#app is missing from index.html');
const app = new App(root);

// Exposed so `scripts/bench.mjs` can drive the real app rather than a stub.
// Harmless in production and deliberately not part of any public API.
(globalThis as unknown as { __ojs?: App }).__ojs = app;
