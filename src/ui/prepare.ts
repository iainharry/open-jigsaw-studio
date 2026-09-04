/**
 * The preparation view: crop, rotate, straighten, flip and adjust before cutting.
 *
 * Self-contained — it owns an overlay, borrows the chosen picture, and resolves with an
 * `ImageEdit` or null if cancelled. It never touches puzzle state, and nothing else needs
 * to know it exists beyond "give me an edit for this picture".
 *
 * The crop rectangle is kept in the image's rotated coordinate space (see
 * `engine/imageEdit.ts`) and converted to screen only for drawing and hit testing, so
 * dragging the straighten slider does not move the crop out from under the pointer.
 */

import {
  applyAspect,
  ASPECT_PRESETS,
  clampCrop,
  DEFAULT_EDIT,
  editedSize,
  effectiveCrop,
  usableArea,
  type CropRect,
  type ImageEdit,
  type QuarterTurns,
} from '../engine/imageEdit.js';
import { chooseGrid, pieceCountLimits, pieceEdgePixels } from '../engine/geometry.js';
import { drawEditPreview } from '../render/applyEdit.js';

type Handle = 'move' | 'nw' | 'ne' | 'sw' | 'se' | null;

export interface PrepareOptions {
  image: ImageBitmap;
  /** Starting edit, so reopening preparation resumes where it left off. */
  edit?: ImageEdit;
  /** Piece count the puzzle will use, for the live readout. */
  pieceCount: number;
  maxEdge: number;
  title: string;
}

export class PrepareView {
  private readonly root: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly overlay: HTMLCanvasElement;
  private edit: ImageEdit;
  private aspect: number | null = null;
  private drag: { handle: Handle; startX: number; startY: number; startCrop: CropRect } | null = null;
  private scale = 1;
  private resolve: ((edit: ImageEdit | null) => void) | null = null;
  private readonly options: PrepareOptions;

  constructor(host: HTMLElement, options: PrepareOptions) {
    this.options = options;
    this.edit = { ...DEFAULT_EDIT, ...options.edit };

    this.root = document.createElement('div');
    this.root.className = 'prepare';
    this.root.innerHTML = `
      <div class="prep-panel">
        <div class="prep-head">
          <strong>Prepare picture</strong>
          <span class="prep-title"></span>
        </div>
        <div class="prep-stage">
          <canvas class="prep-canvas"></canvas>
          <canvas class="prep-overlay"></canvas>
        </div>
        <div class="prep-controls">
          <div class="prep-row">
            <span class="prep-label">Shape</span>
            <span class="prep-aspects"></span>
          </div>
          <div class="prep-row">
            <span class="prep-label">Turn</span>
            <button class="btn" data-prep="rot-left" title="Rotate left">&#8634;</button>
            <button class="btn" data-prep="rot-right" title="Rotate right">&#8635;</button>
            <button class="btn" data-prep="flip" title="Mirror horizontally">Flip</button>
          </div>
          <label class="prep-row"><span class="prep-label">Straighten</span>
            <input type="range" class="prep-straighten" min="-15" max="15" step="0.1" value="0" />
            <output class="prep-out prep-straighten-out">0.0&deg;</output>
          </label>
          <label class="prep-row"><span class="prep-label">Brightness</span>
            <input type="range" class="prep-brightness" min="-60" max="60" step="1" value="0" />
            <output class="prep-out prep-brightness-out">0</output>
          </label>
          <label class="prep-row"><span class="prep-label">Contrast</span>
            <input type="range" class="prep-contrast" min="-60" max="60" step="1" value="0" />
            <output class="prep-out prep-contrast-out">0</output>
          </label>
          <label class="prep-row"><span class="prep-label">Saturation</span>
            <input type="range" class="prep-saturation" min="-100" max="100" step="1" value="0" />
            <output class="prep-out prep-saturation-out">0</output>
          </label>
        </div>
        <div class="prep-foot">
          <span class="prep-readout"></span>
          <span class="prep-actions">
            <button class="btn" data-prep="reset">Reset</button>
            <button class="btn" data-prep="cancel">Cancel</button>
            <button class="btn on" data-prep="create">Create puzzle</button>
          </span>
        </div>
      </div>`;

    host.append(this.root);
    this.canvas = this.root.querySelector('.prep-canvas')!;
    this.overlay = this.root.querySelector('.prep-overlay')!;
    this.root.querySelector('.prep-title')!.textContent = options.title;

    this.buildAspects();
    this.wire();
    // Lay out once the overlay has real dimensions.
    requestAnimationFrame(() => this.render());
  }

  open(): Promise<ImageEdit | null> {
    return new Promise((resolve) => {
      this.resolve = resolve;
    });
  }

  private close(result: ImageEdit | null): void {
    this.resolve?.(result);
    this.resolve = null;
    this.root.remove();
  }

  private buildAspects(): void {
    const host = this.root.querySelector('.prep-aspects')!;
    for (const preset of ASPECT_PRESETS) {
      const btn = document.createElement('button');
      btn.className = 'btn prep-aspect';
      btn.textContent = preset.label;
      if (preset.value === null) btn.classList.add('on');
      btn.addEventListener('click', () => {
        this.aspect = preset.value;
        for (const other of host.querySelectorAll('.prep-aspect')) other.classList.remove('on');
        btn.classList.add('on');
        const bounds = this.bounds();
        this.edit.crop = applyAspect(this.currentCrop(), this.aspect, bounds);
        this.render();
      });
      host.append(btn);
    }
  }

  private wire(): void {
    this.root.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>('[data-prep]')?.dataset['prep'];
      if (!act) return;
      if (act === 'cancel') this.close(null);
      else if (act === 'create') this.close(this.edit);
      else if (act === 'reset') this.reset();
      else if (act === 'flip') {
        this.edit.flipH = !this.edit.flipH;
        this.render();
      } else if (act === 'rot-left' || act === 'rot-right') {
        const delta = act === 'rot-right' ? 1 : 3;
        this.edit.turns = (((this.edit.turns + delta) % 4) + 4) % 4 as QuarterTurns;
        // The crop lived in the old rotated frame; it means nothing in the new one.
        this.edit.crop = null;
        this.render();
      }
    });

    const slider = (
      cls: string,
      apply: (v: number) => void,
      format: (v: number) => string,
    ): void => {
      const input = this.root.querySelector<HTMLInputElement>(`.prep-${cls}`)!;
      const out = this.root.querySelector<HTMLElement>(`.prep-${cls}-out`)!;
      input.addEventListener('input', () => {
        const v = Number(input.value);
        apply(v);
        out.textContent = format(v);
        this.render();
      });
    };
    slider('straighten', (v) => {
      this.edit.straighten = v;
      // Straightening shrinks the usable area, so the crop may no longer fit.
      if (this.edit.crop) this.edit.crop = clampCrop(this.edit.crop, this.bounds());
    }, (v) => `${v.toFixed(1)}°`);
    slider('brightness', (v) => (this.edit.brightness = v), (v) => String(v));
    slider('contrast', (v) => (this.edit.contrast = v), (v) => String(v));
    slider('saturation', (v) => (this.edit.saturation = v), (v) => String(v));

    this.overlay.addEventListener('pointerdown', (e) => this.onDown(e));
    this.overlay.addEventListener('pointermove', (e) => this.onMove(e));
    this.overlay.addEventListener('pointerup', (e) => this.onUp(e));
    this.overlay.addEventListener('pointercancel', (e) => this.onUp(e));

    window.addEventListener('resize', () => this.render());
  }

  private reset(): void {
    this.edit = { ...DEFAULT_EDIT };
    this.aspect = null;
    for (const [cls, value] of [
      ['straighten', '0'],
      ['brightness', '0'],
      ['contrast', '0'],
      ['saturation', '0'],
    ] as const) {
      const input = this.root.querySelector<HTMLInputElement>(`.prep-${cls}`)!;
      input.value = value;
      const out = this.root.querySelector<HTMLElement>(`.prep-${cls}-out`)!;
      out.textContent = cls === 'straighten' ? '0.0°' : '0';
    }
    for (const [i, btn] of [...this.root.querySelectorAll('.prep-aspect')].entries()) {
      btn.classList.toggle('on', i === 0);
    }
    this.render();
  }

  private bounds(): CropRect {
    return usableArea(this.options.image.width, this.options.image.height, this.edit);
  }

  private currentCrop(): CropRect {
    return effectiveCrop(this.options.image.width, this.options.image.height, this.edit);
  }

  // --- drawing ---------------------------------------------------------------

  private render(): void {
    const stage = this.root.querySelector<HTMLElement>('.prep-stage')!;
    const box = stage.getBoundingClientRect();
    if (box.width < 10 || box.height < 10) {
      requestAnimationFrame(() => this.render());
      return;
    }

    const { image } = this.options;
    const result = drawEditPreview(
      this.canvas,
      image,
      image.width,
      image.height,
      this.edit,
      box.width,
      box.height,
    );
    this.scale = result.scale;
    this.drawOverlay();
    this.updateReadout();
  }

  private drawOverlay(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.overlay.width = Math.round(w * dpr);
    this.overlay.height = Math.round(h * dpr);
    this.overlay.style.width = `${w}px`;
    this.overlay.style.height = `${h}px`;
    // Sit exactly on top of the preview, which may be letterboxed inside the stage.
    this.overlay.style.left = `${this.canvas.offsetLeft}px`;
    this.overlay.style.top = `${this.canvas.offsetTop}px`;

    const ctx = this.overlay.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const crop = this.currentCrop();
    const r = {
      x: crop.x * this.scale,
      y: crop.y * this.scale,
      w: crop.w * this.scale,
      h: crop.h * this.scale,
    };

    // Darken everything outside the crop.
    ctx.fillStyle = 'rgba(6,8,11,0.62)';
    ctx.fillRect(0, 0, w, r.y);
    ctx.fillRect(0, r.y + r.h, w, h - (r.y + r.h));
    ctx.fillRect(0, r.y, r.x, r.h);
    ctx.fillRect(r.x + r.w, r.y, w - (r.x + r.w), r.h);

    // Thirds, which is how people actually judge a crop.
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i < 3; i++) {
      ctx.moveTo(r.x + (r.w * i) / 3, r.y);
      ctx.lineTo(r.x + (r.w * i) / 3, r.y + r.h);
      ctx.moveTo(r.x, r.y + (r.h * i) / 3);
      ctx.lineTo(r.x + r.w, r.y + (r.h * i) / 3);
    }
    ctx.stroke();

    ctx.strokeStyle = '#6aa9ff';
    ctx.lineWidth = 2;
    ctx.strokeRect(r.x, r.y, r.w, r.h);

    ctx.fillStyle = '#6aa9ff';
    for (const [hx, hy] of [
      [r.x, r.y],
      [r.x + r.w, r.y],
      [r.x, r.y + r.h],
      [r.x + r.w, r.y + r.h],
    ] as const) {
      ctx.fillRect(hx - 7, hy - 7, 14, 14);
    }
  }

  private updateReadout(): void {
    const { image, pieceCount, maxEdge } = this.options;
    const size = editedSize(image.width, image.height, this.edit, maxEdge);
    const limits = pieceCountLimits(size.width, size.height);
    const target = Math.min(pieceCount, limits.maximum);
    const grid = chooseGrid(size.width, size.height, target);
    const made = grid.rows * grid.cols;
    const edge = Math.round(pieceEdgePixels(size.width, size.height, made));

    const readout = this.root.querySelector<HTMLElement>('.prep-readout')!;
    readout.textContent =
      `${size.width}×${size.height} → ${made} pieces, about ${edge}px each` +
      (made > limits.comfortable ? ' — soft and low-detail at this size' : '');
    readout.classList.toggle('warn', made > limits.comfortable);
  }

  // --- crop dragging ---------------------------------------------------------

  private at(e: PointerEvent): { x: number; y: number } {
    const box = this.overlay.getBoundingClientRect();
    return { x: (e.clientX - box.left) / this.scale, y: (e.clientY - box.top) / this.scale };
  }

  private handleAt(p: { x: number; y: number }): Handle {
    const crop = this.currentCrop();
    const grab = 18 / this.scale;
    const near = (a: number, b: number): boolean => Math.abs(a - b) <= grab;
    const l = near(p.x, crop.x);
    const r = near(p.x, crop.x + crop.w);
    const t = near(p.y, crop.y);
    const b = near(p.y, crop.y + crop.h);
    if (l && t) return 'nw';
    if (r && t) return 'ne';
    if (l && b) return 'sw';
    if (r && b) return 'se';
    if (p.x >= crop.x && p.x <= crop.x + crop.w && p.y >= crop.y && p.y <= crop.y + crop.h) {
      return 'move';
    }
    return null;
  }

  private onDown(e: PointerEvent): void {
    const p = this.at(e);
    const handle = this.handleAt(p);
    if (!handle) return;
    e.preventDefault();
    try {
      this.overlay.setPointerCapture(e.pointerId);
    } catch {
      /* pointer already gone */
    }
    this.drag = { handle, startX: p.x, startY: p.y, startCrop: this.currentCrop() };
  }

  private onMove(e: PointerEvent): void {
    if (!this.drag) {
      this.overlay.style.cursor = this.handleAt(this.at(e)) ? 'move' : 'default';
      return;
    }
    const p = this.at(e);
    const dx = p.x - this.drag.startX;
    const dy = p.y - this.drag.startY;
    const start = this.drag.startCrop;
    const bounds = this.bounds();
    let next: CropRect;

    if (this.drag.handle === 'move') {
      next = { ...start, x: start.x + dx, y: start.y + dy };
    } else {
      // Corner drags move one corner; the opposite one stays anchored.
      let { x, y, w, h } = start;
      if (this.drag.handle === 'nw') {
        x += dx;
        y += dy;
        w -= dx;
        h -= dy;
      } else if (this.drag.handle === 'ne') {
        y += dy;
        w += dx;
        h -= dy;
      } else if (this.drag.handle === 'sw') {
        x += dx;
        w -= dx;
        h += dy;
      } else {
        w += dx;
        h += dy;
      }
      if (this.aspect) {
        // Let width lead, then derive height, so the box cannot drift off-ratio.
        h = w / this.aspect;
        if (this.drag.handle === 'nw' || this.drag.handle === 'ne') y = start.y + start.h - h;
      }
      next = { x, y, w, h };
    }

    this.edit.crop = clampCrop(next, bounds, Math.max(24, bounds.w * 0.05));
    this.drawOverlay();
    this.updateReadout();
  }

  private onUp(e: PointerEvent): void {
    this.drag = null;
    try {
      if (this.overlay.hasPointerCapture(e.pointerId)) this.overlay.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
  }
}
