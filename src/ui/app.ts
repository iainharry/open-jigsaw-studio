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
  maxSensiblePieces,
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
import { fitTo } from '../render/viewport.js';
import { canvasToBlob, makeDemoImage } from './demoImage.js';
import {
  getImage,
  getLastOpened,
  getPuzzle,
  hashBlob,
  putImage,
  putPuzzle,
  setLastOpened,
  type PuzzleRecord,
  type StoredImage,
} from './storage.js';

const PIECE_CHOICES = [12, 20, 50, 100, 200, 300, 500, 1000, 2000];
const MAX_IMAGE_EDGE = 4000;
const AUTOSAVE_MS = 20_000;
const GEOMETRY_OPTIONS: GeometryOptions = { vertexJitter: 0.06, tabScale: 1, randomiseTabs: true };

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
  };

  /** Cluster ids the player has selected. Interaction state, never saved. */
  private readonly selection = new Set<number>();
  private tool: Tool = 'move';

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

    window.addEventListener('resize', () => {
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
          <input class="title" type="text" placeholder="Untitled puzzle" />
          <label class="btn file-btn">Load image<input type="file" accept="image/*" hidden /></label>
          <label class="field">Pieces
            <select class="pieces"></select>
          </label>
          <button class="btn" data-act="new">New puzzle</button>
          <button class="btn" data-act="shuffle">Shuffle</button>
          <button class="btn" data-act="fit">Fit</button>
          <button class="btn" data-act="ref">Reference</button>
          <span class="divider"></span>
          <button class="btn tool" data-act="tool" title="Drag the board to pan, or to rubber-band select (Shift+drag always selects)">Move</button>
          <label class="field">
            <input type="checkbox" class="rotate-on" /> Rotation
          </label>
          <button class="btn rot" data-act="rotl" title="Rotate selection anticlockwise (Shift+R)">&#8634;</button>
          <button class="btn rot" data-act="rotr" title="Rotate selection clockwise (R)">&#8635;</button>
          <span class="spacer"></span>
          <span class="status"></span>
        </header>
        <main class="stage">
          <canvas class="board"></canvas>
          <aside class="reference" hidden>
            <div class="ref-head">Reference</div>
            <canvas class="ref-img"></canvas>
          </aside>
        </main>
        <footer class="foot"><span class="stats"></span></footer>
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
      else if (act === 'fit') this.fit();
      else if (act === 'ref') this.toggleReference();
      else if (act === 'tool') this.toggleTool();
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
      this.session.record.title = this.els.title.value.trim() || 'Untitled puzzle';
      void this.save();
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
    const cap = maxSensiblePieces(image.width, image.height);
    const target = Math.min(requested, cap);
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
    };

    this.session = { record, state, image, imageMeta: meta };
    this.renderer.invalidateGeometry();
    this.renderer.setImage(image, image.width, image.height);
    this.els.title.value = title;
    this.updateRotationUi();
    this.drawReference();
    this.fit();
    this.playingSince = performance.now();
    setLastOpened(record.id);
    await this.save();

    if (requested > cap) {
      this.setStatus(
        `${rows * cols} pieces — ${requested} would make pieces too small for this image (${image.width}x${image.height}).`,
      );
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
    this.drawReference();
    if (viewport) this.viewport = viewport;
    else this.fit();
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
    this.fit();
    void this.save();
  }

  private scatterArea(w: number, h: number): { x: number; y: number; w: number; h: number } {
    // A generous margin around the board. Pieces land in the ring outside the board
    // (see the `avoid` option), so this needs enough room for every piece.
    const mx = w * 0.62;
    const my = h * 0.62;
    return { x: -mx, y: -my, w: w + mx * 2, h: h + my * 2 };
  }

  private fit(): void {
    if (!this.session) return;
    this.viewport = fitTo(this.renderer.size, this.renderer.contentBounds(this.session.state));
    this.dirty = true;
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

  private toggleReference(): void {
    this.els.reference.hidden = !this.els.reference.hidden;
    this.drawReference();
    this.dirty = true;
  }

  private drawReference(): void {
    if (!this.session || this.els.reference.hidden) return;
    const { image } = this.session;
    const el = this.els.referenceImg;
    const width = el.clientWidth || 260;
    const height = Math.round((width * image.height) / image.width);
    el.width = width;
    el.height = height;
    el.style.height = `${height}px`;
    el.getContext('2d')?.drawImage(image, 0, 0, width, height);
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
    this.els.stats.textContent =
      `${this.session.state.geometry.pieces.length} pieces · ` +
      `${s.piecesDrawn} drawn, ${s.piecesCulled} culled · ` +
      `${s.lastFrameMs.toFixed(1)} ms/frame · ${mb} MB baked · ` +
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
