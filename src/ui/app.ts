/**
 * Application shell.
 *
 * The UI layer only ever sees coarse state: which puzzle is open, how complete it is,
 * what the current tool is. Piece positions never pass through here -- they live in the
 * engine and go straight to the renderer. That boundary is what keeps a 2,000-piece
 * drag at 60fps instead of at whatever rate the UI can re-render.
 */

import {
  chooseGrid,
  createPuzzle,
  deserialize,
  generateGeometry,
  isComplete,
  pieceCountLimits,
  pieceEdgePixels,
  progress,
  randomSeed,
  scatter,
  serialize,
  stateFromGeometry,
  DEFAULT_SETTINGS,
  type GeometryOptions,
  type PuzzleState,
  type Viewport,
} from '../engine/index.js';
import { PointerInput, type Tool } from '../input/pointer.js';
import { Renderer } from '../render/renderer.js';
import { fitTo, zoomAbout } from '../render/viewport.js';
import { canvasToBlob, makeDemoImage } from './demoImage.js';
import {
  deletePuzzle,
  getImage,
  getLastOpened,
  getPuzzle,
  hashBlob,
  listPuzzles,
  makeThumbnail,
  pruneOrphanImages,
  putImage,
  putPuzzle,
  setLastOpened,
  type PuzzleRecord,
  type StoredImage,
} from './storage.js';

const PIECE_CHOICES = [12, 20, 50, 100, 200, 300, 500, 1000, 2000];
/**
 * Longest edge kept when importing. Raised from 4000: at 2,000 pieces a 4000px cap
 * leaves each piece around 60 source pixels, and detail is exactly what a high piece
 * count needs. 5000px of a 3:2 photo decodes to roughly 66 MB of RGBA, which is the
 * point where a mid-range tablet starts to care.
 */
const MAX_IMAGE_EDGE = 5000;
const AUTOSAVE_MS = 20_000;
const GEOMETRY_OPTIONS: GeometryOptions = { vertexJitter: 0.06, tabScale: 1, randomiseTabs: true };

export type RefMode = 'right' | 'bottom' | 'off';

function formatWhen(ms: number): string {
  const days = Math.floor((Date.now() - ms) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return new Date(ms).toLocaleDateString();
}

interface Session {
  record: PuzzleRecord;
  state: PuzzleState;
  image: ImageBitmap;
  imageMeta: StoredImage;
}

export class App {
  private readonly root: HTMLElement;
  private canvas!: HTMLCanvasElement;
  private renderer!: Renderer;
  /** Held so the listeners stay attached for the life of the app. */
  private readonly input: PointerInput;
  private session: Session | null = null;
  private viewport: Viewport = { x: 0, y: 0, zoom: 1 };
  private dirty = true;
  private saveTimer: number | null = null;
  private playingSince = performance.now();

  private els!: {
    pieces: HTMLSelectElement;
    status: HTMLElement;
    stats: HTMLElement;
    reference: HTMLElement;
    referenceImg: HTMLCanvasElement;
    file: HTMLInputElement;
    title: HTMLInputElement;
    tool: HTMLButtonElement;
    rotateOn: HTMLInputElement;
    stage: HTMLElement;
    splitter: HTMLElement;
    refMode: HTMLSelectElement;
    library: HTMLElement;
    libList: HTMLElement;
    zoomReadout: HTMLElement;
  };

  /** Cluster ids the player has selected. Interaction state, never saved. */
  private readonly selection = new Set<number>();
  private tool: Tool = 'move';
  private refMode: RefMode = 'off';
  private refSize = 300;

  constructor(root: HTMLElement) {
    this.root = root;
    this.buildDom();
    this.renderer = new Renderer(this.canvas);
    this.input = new PointerInput(this.canvas, this.renderer, {
      getState: () => this.session?.state ?? null,
      getViewport: () => this.viewport,
      setViewport: (vp) => {
        this.viewport = vp;
        this.dirty = true;
      },
      getTool: () => this.tool,
      selection: this.selection,
      onChange: () => {
        this.dirty = true;
      },
      onSelectionChange: () => {
        this.renderer.selection = this.selection;
        this.updateStatus();
        this.dirty = true;
      },
      onDrop: (result) => {
        if (result.merges > 0) void this.save();
        this.updateStatus();
      },
    });
    this.renderer.selection = this.selection;

    // Restore the reference panel layout from last time.
    try {
      const savedSize = Number(localStorage.getItem('ojs:refSize'));
      if (Number.isFinite(savedSize) && savedSize > 0) this.refSize = savedSize;
      const savedMode = localStorage.getItem('ojs:refMode');
      if (savedMode === 'right' || savedMode === 'bottom' || savedMode === 'off') {
        this.refMode = savedMode;
      }
    } catch {
      /* storage disabled; defaults are fine */
    }
    this.setReferenceMode(this.refMode);

    window.addEventListener('resize', () => {
      // Re-clamp: a panel sized on a wide monitor must not swallow a narrower window.
      this.applyReferenceSize();
      this.drawReference();
      this.dirty = true;
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) void this.save();
    });
    window.addEventListener('beforeunload', () => {
      void this.save();
    });

    this.loop();
    void this.boot();
  }

  /** Detach listeners. Not used by the single-page shell, but required for tests. */
  dispose(): void {
    this.input.dispose();
  }

  // --- DOM ------------------------------------------------------------------

  private buildDom(): void {
    this.root.innerHTML = `
      <div class="ojs">
        <header class="bar">
          <strong class="brand">Open Jigsaw Studio</strong>
          <label class="field name-field">Name
            <input class="title" type="text" placeholder="Untitled puzzle" title="Rename this puzzle" />
          </label>
          <button class="btn" data-act="library">My puzzles</button>
          <label class="btn file-btn">Load image<input type="file" accept="image/*" hidden /></label>
          <label class="field">Pieces
            <select class="pieces"></select>
          </label>
          <button class="btn" data-act="new">New puzzle</button>
          <button class="btn" data-act="shuffle">Shuffle</button>
          <span class="group">
            <button class="btn zoom" data-act="zoom-out" title="Zoom out (−)">&minus;</button>
            <span class="zoom-readout" title="Zoom, and how big a piece is on screen">100%</span>
            <button class="btn zoom" data-act="zoom-in" title="Zoom in (+)">+</button>
            <button class="btn" data-act="fit-board" title="Fit the picture area (0)">Fit board</button>
            <button class="btn" data-act="fit-all" title="Fit everything including loose pieces (9)">Fit all</button>
          </span>
          <label class="field">Reference
            <select class="ref-mode">
              <option value="right">Side</option>
              <option value="bottom">Below</option>
              <option value="off">Hidden</option>
            </select>
          </label>
          <span class="divider"></span>
          <span class="group">
            <button class="btn tool" data-act="tool" title="Drag the board to pan, or to rubber-band select (Shift+drag always selects)">Move</button>
            <label class="field">
              <input type="checkbox" class="rotate-on" /> Rotation
            </label>
            <button class="btn rot" data-act="rotl" title="Rotate selection anticlockwise (Shift+R)">&#8634;</button>
            <button class="btn rot" data-act="rotr" title="Rotate selection clockwise (R)">&#8635;</button>
          </span>
          <span class="spacer"></span>
          <span class="status"></span>
        </header>
        <main class="stage" data-ref="off">
          <canvas class="board"></canvas>
          <div class="splitter" title="Drag to resize the reference image"></div>
          <aside class="reference">
            <div class="ref-head">Reference</div>
            <canvas class="ref-img"></canvas>
          </aside>
        </main>
        <footer class="foot"><span class="stats"></span></footer>
        <div class="library" hidden>
          <div class="lib-panel">
            <div class="lib-head">
              <strong>My puzzles</strong>
              <button class="btn" data-act="close-library">Close</button>
            </div>
            <div class="lib-list"></div>
          </div>
        </div>
      </div>`;

    const q = <T extends Element>(sel: string): T => this.root.querySelector<T>(sel)!;
    this.canvas = q<HTMLCanvasElement>('.board');
    this.els = {
      pieces: q<HTMLSelectElement>('.pieces'),
      status: q<HTMLElement>('.status'),
      stats: q<HTMLElement>('.stats'),
      reference: q<HTMLElement>('.reference'),
      referenceImg: q<HTMLCanvasElement>('.ref-img'),
      file: q<HTMLInputElement>('.file-btn input'),
      title: q<HTMLInputElement>('.title'),
      tool: q<HTMLButtonElement>('.tool'),
      rotateOn: q<HTMLInputElement>('.rotate-on'),
      stage: q<HTMLElement>('.stage'),
      splitter: q<HTMLElement>('.splitter'),
      refMode: q<HTMLSelectElement>('.ref-mode'),
      library: q<HTMLElement>('.library'),
      libList: q<HTMLElement>('.lib-list'),
      zoomReadout: q<HTMLElement>('.zoom-readout'),
    };

    for (const n of PIECE_CHOICES) {
      const opt = document.createElement('option');
      opt.value = String(n);
      opt.textContent = String(n);
      this.els.pieces.append(opt);
    }
    this.els.pieces.value = '100';

    this.root.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset['act'];
      if (act === 'new') void this.newPuzzle();
      else if (act === 'shuffle') this.shuffle();
      else if (act === 'fit-board') this.fitBoard();
      else if (act === 'fit-all') this.fitAll();
      else if (act === 'zoom-in') this.zoomBy(1.25);
      else if (act === 'zoom-out') this.zoomBy(1 / 1.25);
      else if (act === 'tool') this.toggleTool();
      else if (act === 'library') void this.openLibrary();
      else if (act === 'close-library') this.closeLibrary();
      else if (act === 'rotl') this.input.rotateSelection(-Math.PI / 2);
      else if (act === 'rotr') this.input.rotateSelection(Math.PI / 2);
    });

    this.els.rotateOn.addEventListener('change', () => {
      if (!this.session) return;
      const on = this.els.rotateOn.checked;
      this.session.state.settings = { ...this.session.state.settings, rotationEnabled: on };
      // Turning rotation off would otherwise strand any piece left at an angle,
      // because the snap test stops considering rotation at all.
      if (!on) {
        for (const cluster of this.session.state.clusters.values()) cluster.rotation = 0;
      }
      this.updateRotationUi();
      this.dirty = true;
      void this.save();
    });

    this.els.file.addEventListener('change', () => {
      const file = this.els.file.files?.[0];
      if (file) void this.loadImageFile(file);
      this.els.file.value = '';
    });

    this.els.pieces.addEventListener('change', () => void this.newPuzzle());

    this.els.title.addEventListener('change', () => {
      if (!this.session) return;
      const name = this.els.title.value.trim() || 'Untitled puzzle';
      this.session.record.title = name;
      this.els.title.value = name;
      this.setStatus(`Renamed to “${name}”`);
      void this.save();
    });

    this.els.refMode.addEventListener('change', () => {
      this.setReferenceMode(this.els.refMode.value as RefMode);
    });

    this.setupSplitter();

    window.addEventListener('keydown', (e) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT')) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === '+' || e.key === '=') this.zoomBy(1.25);
      else if (e.key === '-' || e.key === '_') this.zoomBy(1 / 1.25);
      else if (e.key === '0') this.fitBoard();
      else if (e.key === '9') this.fitAll();
      else return;
      e.preventDefault();
    });

    this.els.library.addEventListener('click', (e) => {
      // Clicking the dimmed backdrop closes the library.
      if (e.target === this.els.library) this.closeLibrary();
    });
  }

  // --- Boot and puzzle lifecycle -------------------------------------------

  private async boot(): Promise<void> {
    const lastId = getLastOpened();
    if (lastId) {
      const record = await getPuzzle(lastId).catch(() => undefined);
      if (record) {
        const restored = await this.openRecord(record).catch(() => false);
        if (restored) return;
      }
    }
    await this.useDemoImage();
  }

  private async useDemoImage(): Promise<void> {
    const canvas = makeDemoImage() as HTMLCanvasElement;
    const blob = await canvasToBlob(canvas);
    await this.adoptImage(blob, 'Sample landscape');
  }

  private async loadImageFile(file: File): Promise<void> {
    this.setStatus('Reading image…');
    try {
      await this.adoptImage(file, file.name.replace(/\.[^.]+$/, ''));
    } catch (err) {
      this.setStatus(`Could not read that image: ${(err as Error).message}`);
    }
  }

  /** Decode, orient, downscale if necessary, store, and start a puzzle from an image. */
  private async adoptImage(blob: Blob, name: string): Promise<void> {
    // `from-image` applies the EXIF orientation tag, which DSLR and phone photos rely on.
    let bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });

    const longest = Math.max(bitmap.width, bitmap.height);
    if (longest > MAX_IMAGE_EDGE) {
      const scale = MAX_IMAGE_EDGE / longest;
      const resized = await createImageBitmap(bitmap, {
        resizeWidth: Math.round(bitmap.width * scale),
        resizeHeight: Math.round(bitmap.height * scale),
        resizeQuality: 'high',
      });
      bitmap.close();
      bitmap = resized;
    }

    const hash = await hashBlob(blob);
    const meta: StoredImage = {
      hash,
      blob,
      width: bitmap.width,
      height: bitmap.height,
      name,
      addedAt: Date.now(),
    };
    await putImage(meta).catch(() => undefined);

    this.session?.image.close();
    this.session = null;
    await this.startPuzzle(meta, bitmap, name);
  }

  private async startPuzzle(meta: StoredImage, image: ImageBitmap, title: string): Promise<void> {
    const requested = Number(this.els.pieces.value);
    const limits = pieceCountLimits(image.width, image.height);
    // Only the hard maximum is enforced. Going past `comfortable` is the player's call.
    const target = Math.min(requested, limits.maximum);
    const { rows, cols } = chooseGrid(image.width, image.height, target);
    const seed = randomSeed();

    const state = createPuzzle({
      seed,
      rows,
      cols,
      imageWidth: image.width,
      imageHeight: image.height,
      settings: { rotationEnabled: this.els.rotateOn.checked },
      ...GEOMETRY_OPTIONS,
    });
    scatter(state, seed, this.scatterArea(image.width, image.height), {
      avoid: { x: 0, y: 0, w: image.width, h: image.height },
    });
    this.clearSelection();

    const record: PuzzleRecord = {
      id: `p_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`,
      title,
      imageHash: meta.hash,
      saved: null,
      pieceCount: rows * cols,
      createdAt: Date.now(),
      lastPlayed: Date.now(),
      completedAt: null,
      progress: 0,
      thumbnail: makeThumbnail(image, image.width, image.height),
    };

    this.session = { record, state, image, imageMeta: meta };
    this.renderer.invalidateGeometry();
    this.renderer.setImage(image, image.width, image.height);
    this.els.title.value = title;
    this.updateRotationUi();
    this.drawReference();
    this.fitBoard();
    this.playingSince = performance.now();
    setLastOpened(record.id);
    await this.save();

    const made = rows * cols;
    const edge = Math.round(pieceEdgePixels(image.width, image.height, made));
    if (requested > limits.maximum) {
      this.setStatus(
        `${made} pieces. ${requested} is more than this ${image.width}×${image.height} image can carry — ` +
          `the pieces would be almost entirely tab and no picture.`,
      );
    } else if (made > limits.comfortable) {
      this.setStatus(
        `${made} pieces, about ${edge}px each — soft and low-detail from a ${image.width}×${image.height} image, ` +
          `but perfectly playable if that is the challenge you want.`,
      );
    } else {
      this.setStatus(`${made} pieces, about ${edge}px each.`);
    }
  }

  private async openRecord(record: PuzzleRecord): Promise<boolean> {
    const meta = await getImage(record.imageHash);
    if (!meta || !record.saved) return false;

    let bitmap = await createImageBitmap(meta.blob, { imageOrientation: 'from-image' });
    if (bitmap.width !== meta.width || bitmap.height !== meta.height) {
      const resized = await createImageBitmap(bitmap, {
        resizeWidth: meta.width,
        resizeHeight: meta.height,
        resizeQuality: 'high',
      });
      bitmap.close();
      bitmap = resized;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { state, viewport } = deserialize(record.saved as any);
    this.session?.image.close();
    this.session = { record, state, image: bitmap, imageMeta: meta };
    this.renderer.invalidateGeometry();
    this.renderer.setImage(bitmap, bitmap.width, bitmap.height);
    this.els.title.value = record.title;
    this.els.pieces.value = String(
      PIECE_CHOICES.reduce((best, n) =>
        Math.abs(n - record.pieceCount) < Math.abs(best - record.pieceCount) ? n : best,
      ),
    );
    this.clearSelection();
    this.updateRotationUi();
    // Records written before thumbnails existed get one now, so the library is not
    // permanently full of blank cards for older puzzles.
    if (!record.thumbnail) {
      record.thumbnail = makeThumbnail(bitmap, bitmap.width, bitmap.height);
      await putPuzzle(record).catch(() => undefined);
    }
    this.drawReference();
    if (viewport) this.viewport = viewport;
    else this.fitBoard();
    this.playingSince = performance.now();
    this.dirty = true;
    this.setStatus(`Resumed “${record.title}”`);
    return true;
  }

  private async newPuzzle(): Promise<void> {
    if (!this.session) return void this.useDemoImage();
    const { imageMeta, image, record } = this.session;
    // Reuse the already-decoded bitmap rather than re-reading it from storage.
    const clone = await createImageBitmap(image);
    this.session = null;
    await this.startPuzzle(imageMeta, clone, record.title);
  }

  private shuffle(): void {
    if (!this.session) return;
    const { state, image } = this.session;
    const seed = randomSeed();
    // Rebuild from geometry so already-joined clusters are broken apart too.
    const fresh = stateFromGeometry(
      generateGeometry(
        state.geometry.seed,
        state.geometry.rows,
        state.geometry.cols,
        state.geometry.imageWidth,
        state.geometry.imageHeight,
        GEOMETRY_OPTIONS,
      ),
      { ...DEFAULT_SETTINGS, rotationEnabled: state.settings.rotationEnabled },
    );
    scatter(fresh, seed, this.scatterArea(image.width, image.height), {
      avoid: { x: 0, y: 0, w: image.width, h: image.height },
    });
    this.session.state = fresh;
    this.clearSelection();
    this.fitBoard();
    void this.save();
  }

  /**
   * The ring the loose pieces are scattered into.
   *
   * Sized from the area the pieces actually need, not a fixed fraction of the board.
   * Every piece together covers roughly the image area whatever the piece count, so a
   * ring of about 2.5x that gives room to lay them out. The old 0.62 margin made the
   * whole content five times the board area, and since the app opened by fitting all of
   * it, a 500-piece puzzle arrived on screen with 28-pixel pieces.
   */
  private scatterArea(w: number, h: number): { x: number; y: number; w: number; h: number } {
    const margin = 0.5;
    const mx = w * margin;
    const my = h * margin;
    return { x: -mx, y: -my, w: w + mx * 2, h: h + my * 2 };
  }

  /** Fit the picture area. The default for a new puzzle: pieces stay legible. */
  private fitBoard(): void {
    if (!this.session) return;
    const g = this.session.state.geometry;
    this.viewport = fitTo(this.renderer.size, {
      x: 0,
      y: 0,
      w: g.imageWidth,
      h: g.imageHeight,
    });
    this.dirty = true;
  }

  /** Fit everything, loose pieces included. The overview, on request. */
  private fitAll(): void {
    if (!this.session) return;
    this.viewport = fitTo(this.renderer.size, this.renderer.contentBounds(this.session.state));
    this.dirty = true;
  }

  private zoomBy(factor: number): void {
    const size = this.renderer.size;
    this.viewport = zoomAbout(
      this.viewport,
      size,
      { x: size.width / 2, y: size.height / 2 },
      factor,
    );
    this.dirty = true;
  }

  /** On-screen size in CSS pixels of one piece at the current zoom. */
  private pieceScreenPx(): number {
    if (!this.session) return 0;
    const g = this.session.state.geometry;
    return Math.min(g.cellWidth, g.cellHeight) * this.viewport.zoom;
  }

  // --- Reference panel ------------------------------------------------------

  private toggleTool(): void {
    this.tool = this.tool === 'move' ? 'select' : 'move';
    this.els.tool.textContent = this.tool === 'move' ? 'Move' : 'Select';
    this.els.tool.classList.toggle('on', this.tool === 'select');
    this.setStatus(
      this.tool === 'select'
        ? 'Select mode — drag the board to lasso pieces. Shift+drag does this in Move mode too.'
        : 'Move mode — drag the board to pan.',
    );
  }

  private updateRotationUi(): void {
    const on = this.session?.state.settings.rotationEnabled ?? false;
    this.els.rotateOn.checked = on;
    for (const btn of this.root.querySelectorAll<HTMLButtonElement>('.rot')) btn.disabled = !on;
  }

  private clearSelection(): void {
    if (this.selection.size === 0) return;
    this.selection.clear();
    this.renderer.selection = this.selection;
    this.dirty = true;
  }

  /**
   * Reference panel placement and size.
   *
   * The first version used CSS `resize: horizontal` on the panel. That grows the element
   * to the *right*, past the edge of the window, so on a wide monitor the panel ended up
   * off-screen and reachable only via the page scrollbar. A real splitter that moves the
   * boundary between the two panes, with the size clamped to the window, is the fix.
   */
  private setReferenceMode(mode: RefMode): void {
    this.refMode = mode;
    this.els.stage.dataset['ref'] = mode;
    this.els.refMode.value = mode;
    try {
      localStorage.setItem('ojs:refMode', mode);
    } catch {
      /* storage disabled; the panel simply starts hidden next time */
    }
    this.applyReferenceSize();
    this.drawReference();
    this.dirty = true;
  }

  private applyReferenceSize(): void {
    const horizontal = this.refMode === 'right';
    const available = horizontal ? window.innerWidth : window.innerHeight;
    // Never let the panel take the whole window, and never let it shrink to nothing.
    const size = Math.max(140, Math.min(this.refSize, Math.round(available * 0.7)));
    this.refSize = size;
    this.els.stage.style.setProperty('--ref-size', `${size}px`);
  }

  private setupSplitter(): void {
    const el = this.els.splitter;
    let dragging = false;

    el.addEventListener('pointerdown', (e) => {
      if (this.refMode === 'off') return;
      dragging = true;
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        // Throws if the pointer is already gone; the drag still works via the events.
      }
      el.classList.add('active');
      e.preventDefault();
    });

    el.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const rect = this.els.stage.getBoundingClientRect();
      this.refSize =
        this.refMode === 'right' ? rect.right - e.clientX : rect.bottom - e.clientY;
      this.applyReferenceSize();
      this.drawReference();
      this.dirty = true;
    });

    const stop = (e: PointerEvent): void => {
      if (!dragging) return;
      dragging = false;
      el.classList.remove('active');
      try {
        if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
      try {
        localStorage.setItem('ojs:refSize', String(Math.round(this.refSize)));
      } catch {
        /* storage disabled; size resets next session */
      }
    };
    el.addEventListener('pointerup', stop);
    el.addEventListener('pointercancel', stop);

    // Double-click the splitter to reset to a sensible width.
    el.addEventListener('dblclick', () => {
      this.refSize = 300;
      this.applyReferenceSize();
      this.drawReference();
      this.dirty = true;
    });
  }

  private drawReference(): void {
    if (!this.session || this.refMode === 'off') return;
    const { image } = this.session;
    const el = this.els.referenceImg;
    const box = this.els.reference.getBoundingClientRect();
    const padding = 20;
    const maxW = Math.max(40, box.width - padding);
    const maxH = Math.max(40, box.height - padding - 24);
    const scale = Math.min(maxW / image.width, maxH / image.height);
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));
    el.width = width;
    el.height = height;
    el.style.width = `${width}px`;
    el.style.height = `${height}px`;
    el.getContext('2d')?.drawImage(image, 0, 0, width, height);
  }

  // --- Library --------------------------------------------------------------

  private async openLibrary(): Promise<void> {
    await this.save();
    const records = await listPuzzles().catch(() => [] as PuzzleRecord[]);
    const list = this.els.libList;
    list.innerHTML = '';

    if (records.length === 0) {
      list.innerHTML = '<p class="lib-empty">No saved puzzles yet.</p>';
    }

    for (const record of records) {
      const card = document.createElement('div');
      card.className = 'lib-card';
      if (this.session?.record.id === record.id) card.classList.add('current');

      const pct = Math.round(record.progress * 100);
      const state = record.completedAt
        ? 'Completed'
        : pct > 0
          ? `${pct}% connected`
          : 'Not started';

      card.innerHTML = `
        <div class="lib-thumb">${
          record.thumbnail ? `<img alt="" src="${record.thumbnail}" />` : '<span>no preview</span>'
        }</div>
        <div class="lib-meta">
          <div class="lib-title"></div>
          <div class="lib-sub">${record.pieceCount} pieces · ${state}</div>
          <div class="lib-sub">Last played ${formatWhen(record.lastPlayed)}</div>
        </div>
        <div class="lib-actions">
          <button class="btn lib-open">Open</button>
          <button class="btn lib-delete" title="Delete this puzzle">Delete</button>
        </div>`;
      // Set the title as text, never as HTML: it is user input.
      card.querySelector<HTMLElement>('.lib-title')!.textContent = record.title;

      card.querySelector<HTMLButtonElement>('.lib-open')!.addEventListener('click', () => {
        void this.openFromLibrary(record);
      });
      card.querySelector<HTMLButtonElement>('.lib-delete')!.addEventListener('click', (e) => {
        void this.deleteFromLibrary(record, e.currentTarget as HTMLButtonElement);
      });
      list.append(card);
    }

    this.els.library.hidden = false;
  }

  private closeLibrary(): void {
    this.els.library.hidden = true;
  }

  private async openFromLibrary(record: PuzzleRecord): Promise<void> {
    this.closeLibrary();
    if (this.session?.record.id === record.id) return;
    const ok = await this.openRecord(record).catch(() => false);
    if (!ok) this.setStatus(`Could not reopen “${record.title}” — its image is missing.`);
    else setLastOpened(record.id);
  }

  private async deleteFromLibrary(record: PuzzleRecord, button: HTMLButtonElement): Promise<void> {
    // Two-step rather than a confirm() dialog: a modal dialog would block the canvas.
    if (button.dataset['armed'] !== 'yes') {
      button.dataset['armed'] = 'yes';
      button.textContent = 'Really delete?';
      button.classList.add('danger');
      window.setTimeout(() => {
        button.dataset['armed'] = '';
        button.textContent = 'Delete';
        button.classList.remove('danger');
      }, 4000);
      return;
    }

    await deletePuzzle(record.id).catch(() => undefined);
    await pruneOrphanImages().catch(() => 0);
    if (this.session?.record.id === record.id) {
      this.session.image.close();
      this.session = null;
      await this.useDemoImage();
    }
    await this.openLibrary();
  }

  // --- Saving ---------------------------------------------------------------

  private async save(): Promise<void> {
    if (!this.session) return;
    const { record, state } = this.session;
    state.elapsedMs += performance.now() - this.playingSince;
    this.playingSince = performance.now();

    record.saved = serialize(state, GEOMETRY_OPTIONS, this.viewport);
    record.lastPlayed = Date.now();
    record.progress = progress(state);
    if (isComplete(state) && record.completedAt === null) record.completedAt = Date.now();
    await putPuzzle(record).catch(() => undefined);
  }

  private scheduleSave(): void {
    if (this.saveTimer !== null) return;
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.save();
    }, AUTOSAVE_MS);
  }

  // --- Frame loop -----------------------------------------------------------

  private loop = (): void => {
    if (this.renderer.resize()) this.dirty = true;
    if (this.dirty && this.session) {
      this.renderer.draw(this.session.state, this.viewport);
      this.dirty = false;
      this.updateStats();
    }
    this.scheduleSave();
    requestAnimationFrame(this.loop);
  };

  private updateStats(): void {
    if (!this.session) return;
    const s = this.renderer.stats;
    const mb = (s.bakedBytes / (1024 * 1024)).toFixed(1);
    const piecePx = Math.round(this.pieceScreenPx());

    this.els.zoomReadout.textContent = `${Math.round(this.viewport.zoom * 100)}%`;
    this.els.zoomReadout.title = `Pieces are about ${piecePx}px on screen`;
    // Flag a zoom where pieces have become genuinely hard to see.
    this.els.zoomReadout.classList.toggle('tight', piecePx < 34);

    this.els.stats.textContent =
      `${this.session.state.geometry.pieces.length} pieces · ` +
      `~${piecePx}px on screen · ` +
      `${s.piecesDrawn} drawn, ${s.piecesCulled} culled · ` +
      `${s.medianFrameMs.toFixed(1)} ms/frame · ${mb} MB baked · ` +
      `${this.session.state.clusters.size} groups`;
  }

  private updateStatus(): void {
    if (!this.session) return;
    if (isComplete(this.session.state)) {
      const mins = Math.round(this.session.state.elapsedMs / 60000);
      this.setStatus(`Complete — ${mins} minute${mins === 1 ? '' : 's'}`);
      return;
    }
    const pct = Math.round(progress(this.session.state) * 100);
    if (this.selection.size > 0) {
      let pieces = 0;
      for (const id of this.selection) {
        pieces += this.session.state.clusters.get(id)?.pieces.length ?? 0;
      }
      this.setStatus(
        `${this.selection.size} selected (${pieces} piece${pieces === 1 ? '' : 's'}) · ${pct}% connected`,
      );
    } else {
      this.setStatus(`${pct}% connected`);
    }
  }

  private setStatus(text: string): void {
    this.els.status.textContent = text;
  }
}
