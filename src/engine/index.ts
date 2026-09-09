/**
 * Public surface of the headless puzzle engine.
 *
 * Nothing in here touches the DOM. Anything that needs a canvas belongs in
 * `src/render/`, and anything that needs pointer events belongs in `src/input/`.
 */

export * from './types.js';
export * from './rng.js';
export * from './geometry.js';
export * from './clusters.js';
export * from './puzzle.js';
export * from './imageEdit.js';
export * from './polyomino.js';
export * from './pieceColouring.js';
export * from './freeform.js';
export * from './colour.js';
export * from './colourSort.js';
export * from './trays.js';
export * from './serialize.js';
export * from './packing.js';
export * from './challenge.js';
