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
  borderPieceIds,
  edgeClusters,
  generateGeometry,
  DEFAULT_EDIT,
  isUneditedImage,
  type ImageEdit,
  groupByColour,
  liveMembers,
  neighbourClusters,
  oklabToRgb,
  type ColourGroup,
  isComplete,
  pieceCountLimits,
  pieceEdgePixels,
  progress,
  randomSeed,
  scatter,
  serialize,
  stateFromGeometry,
  createTray,
  defaultTrayWidth,
  deleteTray,
  renameTray,
  setTrayCollapsed,
  trayBounds,
  trayMetrics,
  trayPieceCount,
  DEFAULT_SETTINGS,
  type GeometryOptions,
  type PuzzleState,
  type Viewport,
} from '../engine/index.js';
import { PointerInput, type Tool } from '../input/pointer.js';
import { PrepareView } from './prepare.js';
import { renderEdited } from '../render/applyEdit.js';
import { Renderer } from '../render/renderer.js';
import { samplePieceColours } from '../render/pieceColours.js';
import { fitTo, screenToWorld, worldToScreen, zoomAbout } from '../render/viewport.js';
import { canvasToBlob, makeDemoImage } from './demoImage.js';
import {
  backupSupported,
  chooseFolder,
  folderPermission,
  forgetFolder,
  getStoredFolder,
  writeBackup,
} from './backupFolder.js';
import { buildPuzzleFile, puzzleFileToBlob, readPuzzleFile, safeFileName } from './puzzleFile.js';
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
  storedImageHashes,
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
  /** The prepared picture the puzzle is cut from. */
  image: ImageBitmap;
  /** The untouched original, kept so preparation can be reopened non-destructively. */
  original: ImageBitmap;
  imageMeta: StoredImage;
  edit: ImageEdit;
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
  /** True once a save has failed, so the warning is given once rather than every autosave. */
  private saveFailed = false;
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
    trayList: HTMLSelectElement;
    trayRename: HTMLInputElement;
    tip: HTMLElement;
    colourNav: HTMLElement;
    colourLabel: HTMLElement;
    colourCount: HTMLSelectElement;
    swatch: HTMLElement;
    importFile: HTMLInputElement;
    libNote: HTMLElement;
    ghost: HTMLInputElement;
    hints: HTMLButtonElement;
    edgesOnly: HTMLButtonElement;
  };

  /** Folder that receives a .jigsaw copy on every save, if one has been chosen. */
  private backupHandle: Awaited<ReturnType<typeof getStoredFolder>> = null;

  /** Colour groups being stepped through, and where we are in them. */
  private colourGroups: ColourGroup[] | null = null;
  private colourIndex = 0;
  /** Per-piece mean colours, sampled once per image. */
  private pieceColours: Float32Array | null = null;

  /**
   * Help mode. Hover tooltips cover a mouse, but a tablet has no hover at all, so
   * pointing at a control can never explain it there. In help mode a tap shows the
   * explanation instead of pressing the button, which is the only way to make the same
   * help reachable by touch without shipping a separate manual.
   */
  private helpMode = false;
  private tipTimer: number | null = null;

  /** Tray the toolbar acts on. Set by tapping a tray or creating one. */
  private activeTray: number | null = null;

  /** Cluster ids the player has selected. Interaction state, never saved. */
  private readonly selection = new Set<number>();
  /** Assistance: outline the neighbours of whatever is selected. */
  private hintsOn = false;
  /** Assistance: hide every piece that is not part of the border. */
  private edgesOnly = false;
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
        this.syncSelection();
        this.updateStatus();
        this.dirty = true;
      },
      onDrop: (result) => {
        if (result.merges > 0) void this.save();
        this.updateStatus();
      },
      onTrayChange: () => {
        this.refreshTrayUi();
        void this.save();
      },
      onTrayActivate: (trayId) => {
        this.activeTray = trayId;
        this.refreshTrayUi();
        this.beginTrayRename(trayId);
      },
    });
    this.syncSelection();

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

    void getStoredFolder().then((handle) => {
      this.backupHandle = handle;
      this.refreshBackupButton();
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
          <label class="field name-field" data-help="The puzzle's name. Click here and type to rename it; it shows in My puzzles.">Name
            <input class="title" type="text" placeholder="Untitled puzzle" title="Rename this puzzle" />
          </label>
          <button class="btn" data-act="library" data-help="Every puzzle you have made is saved here. Reopen one where you left off, or delete ones you have finished with.">My puzzles</button>
          <label class="btn file-btn" data-help="Choose a picture from this computer. It stays on your machine; nothing is uploaded.">Load image<input type="file" accept="image/*" hidden /></label>
          <label class="field" data-help="How many pieces to cut the picture into. Press New puzzle to apply it. Very high counts on a small picture make soft, low-detail pieces.">Pieces
            <select class="pieces"></select>
          </label>
          <button class="btn" data-act="prepare" data-help="Crop, straighten and adjust the picture, then cut it into a new puzzle. Your original photo is never changed.">Prepare…</button>
          <button class="btn" data-act="new" data-help="Cut the same picture again into the number of pieces chosen above. Your current progress on it is replaced.">New puzzle</button>
          <button class="btn" data-act="shuffle" data-help="Break everything apart and scatter it again. The picture and piece count stay the same.">Shuffle</button>
          <span class="group">
            <button class="btn zoom" data-act="zoom-out" data-help="Make pieces smaller so you can see more at once. Keyboard: −" title="Zoom out (−)">&minus;</button>
            <span class="zoom-readout" data-help="Current zoom, and how big one piece is on screen. It turns amber when pieces get too small to see comfortably." title="Zoom, and how big a piece is on screen">100%</span>
            <button class="btn zoom" data-act="zoom-in" data-help="Make pieces bigger. The number to the left shows how big a piece is on screen. Keyboard: +" title="Zoom in (+)">+</button>
            <button class="btn" data-act="fit-board" data-help="Zoom so the whole picture area fits the window. This is where a new puzzle starts. Keyboard: 0" title="Fit the picture area (0)">Fit board</button>
            <button class="btn" data-act="fit-all" data-help="Zoom out far enough to see every loose piece as well as the board. Keyboard: 9" title="Fit everything including loose pieces (9)">Fit all</button>
          </span>
          <label class="field" data-help="Show the finished picture beside or below the board so you can see what you are building. Drag the bar between the two to resize.">Reference
            <select class="ref-mode">
              <option value="right">Side</option>
              <option value="bottom">Below</option>
              <option value="off">Hidden</option>
            </select>
          </label>
          <span class="divider"></span>
          <span class="group">
            <button class="btn" data-act="select-edges" data-help="Select every edge and corner piece. Press New tray straight after to gather them all in one place.">Edges</button>
            <button class="btn" data-act="colour-sort" data-help="Group the loose pieces by colour and step through the groups one at a time. Each group is selected for you; press New tray to keep it, or skip to the next.">Sort by colour</button>
            <button class="btn" data-act="new-tray" data-help="Put the selected pieces into a new tray. With nothing selected you get an empty tray to drag pieces into. Keyboard: T" title="Put the selected pieces in a new tray (T)">New tray</button>
            <select class="tray-list" data-help="Jump the view to one of your trays, and choose which tray the Collapse and Empty buttons act on." title="Jump to a tray"><option value="">Trays…</option></select>
            <button class="btn tray-only" data-act="collapse-tray" data-help="Shrink the selected tray to a single bar, hiding its pieces so they stop cluttering the board. Press again to open it." title="Collapse or expand the selected tray">Collapse</button>
            <button class="btn tray-only" data-act="empty-tray" data-help="Remove the selected tray. Its pieces are tipped back onto the board, not deleted." title="Tip the tray out onto the board and remove it">Empty</button>
          </span>
          <span class="colour-nav group" hidden>
            <button class="btn zoom" data-act="colour-prev" data-help="Show the previous colour group.">&#9664;</button>
            <span class="swatch"></span>
            <span class="colour-label"></span>
            <button class="btn zoom" data-act="colour-next" data-help="Show the next colour group.">&#9654;</button>
            <label class="field" data-help="How many colour groups to split the pieces into. Changing it re-sorts straight away.">Groups
              <select class="colour-count">
                <option>4</option><option selected>6</option><option>8</option><option>10</option>
              </select>
            </label>
            <button class="btn" data-act="colour-done" data-help="Stop stepping through colour groups.">Done</button>
          </span>
          <span class="divider"></span>
          <span class="group">
            <button class="btn tool" data-act="tool" data-help="Move: dragging the background pans the board. Select: dragging the background lassoes pieces instead. On a PC, Shift and drag always lassoes." title="Drag the board to pan, or to rubber-band select (Shift+drag always selects)">Move</button>
            <label class="field" data-help="Start pieces at random quarter turns, so they must be turned as well as placed. Turning this off straightens everything again.">
              <input type="checkbox" class="rotate-on" /> Rotation
            </label>
            <button class="btn rot" data-act="rotl" data-help="Turn the selected pieces a quarter turn anticlockwise. Needs Rotation switched on. Keyboard: Shift+R" title="Rotate selection anticlockwise (Shift+R)">&#8634;</button>
            <button class="btn rot" data-act="rotr" data-help="Turn the selected pieces a quarter turn clockwise. Needs Rotation switched on. Keyboard: R" title="Rotate selection clockwise (R)">&#8635;</button>
          </span>
          <span class="divider"></span>
          <span class="group">
            <label class="field" data-help="Show the finished picture faintly on the board, to lay pieces over. Drag left for no help at all; drag right to make it clearer.">Ghost
              <input type="range" class="ghost" min="0" max="45" step="1" value="0" />
            </label>
            <button class="btn" data-act="hints" data-help="Outline the pieces that belong beside whatever you have selected. It shows you where to look; it does not place anything for you.">Hints</button>
            <button class="btn" data-act="edges-only" data-help="Hide every piece that is not part of the border, so you can build the frame without the rest in the way. Nothing is lost — switch it off to bring them back.">Edges only</button>
          </span>
          <button class="btn help-toggle" data-act="help" data-help="Turn on help mode, then point at or tap any control to read what it does.">?</button>
          <span class="spacer"></span>
          <span class="status"></span>
        </header>
        <main class="stage" data-ref="off">
          <canvas class="board"></canvas>
          <input class="tray-rename" type="text" hidden maxlength="40" />
          <div class="splitter" title="Drag to resize the reference image"></div>
          <aside class="reference">
            <div class="ref-head">Reference</div>
            <canvas class="ref-img"></canvas>
          </aside>
        </main>
        <footer class="foot"><span class="stats"></span></footer>
        <div class="tip" hidden></div>
        <div class="library" hidden>
          <div class="lib-panel">
            <div class="lib-head">
              <strong>My puzzles</strong>
              <span class="lib-head-actions">
                <label class="btn" data-help="Open a .jigsaw file: the picture and your progress come back exactly as they were.">Import…<input type="file" class="import-file" accept=".jigsaw,application/json" hidden /></label>
                <button class="btn backup-btn" data-act="backup-folder">Backup folder…</button>
                <button class="btn" data-act="close-library">Close</button>
              </span>
            </div>
            <p class="lib-note"></p>
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
      trayList: q<HTMLSelectElement>('.tray-list'),
      trayRename: q<HTMLInputElement>('.tray-rename'),
      tip: q<HTMLElement>('.tip'),
      colourNav: q<HTMLElement>('.colour-nav'),
      colourLabel: q<HTMLElement>('.colour-label'),
      colourCount: q<HTMLSelectElement>('.colour-count'),
      swatch: q<HTMLElement>('.swatch'),
      importFile: q<HTMLInputElement>('.import-file'),
      libNote: q<HTMLElement>('.lib-note'),
      ghost: q<HTMLInputElement>('.ghost'),
      hints: q<HTMLButtonElement>('[data-act="hints"]'),
      edgesOnly: q<HTMLButtonElement>('[data-act="edges-only"]'),
    };
    this.setupHelp();

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
      else if (act === 'hints') this.toggleHints();
      else if (act === 'edges-only') this.toggleEdgesOnly();
      else if (act === 'prepare') void this.prepareImage();
      else if (act === 'shuffle') this.shuffle();
      else if (act === 'fit-board') this.fitBoard();
      else if (act === 'fit-all') this.fitAll();
      else if (act === 'zoom-in') this.zoomBy(1.25);
      else if (act === 'zoom-out') this.zoomBy(1 / 1.25);
      else if (act === 'tool') this.toggleTool();
      else if (act === 'library') void this.openLibrary();
      else if (act === 'close-library') this.closeLibrary();
      else if (act === 'backup-folder') void this.chooseBackupFolder();
      else if (act === 'help') this.setHelpMode(!this.helpMode);
      else if (act === 'select-edges') this.selectEdges();
      else if (act === 'colour-sort') this.startColourSort();
      else if (act === 'colour-prev') this.stepColourGroup(-1);
      else if (act === 'colour-next') this.stepColourGroup(1);
      else if (act === 'colour-done') this.endColourSort();
      else if (act === 'new-tray') this.newTray();
      else if (act === 'collapse-tray') this.toggleActiveTray();
      else if (act === 'empty-tray') this.emptyActiveTray();
      else if (act === 'rotl') this.input.rotateSelection(-Math.PI / 2);
      else if (act === 'rotr') this.input.rotateSelection(Math.PI / 2);
    });

    this.els.ghost.addEventListener('input', () => {
      // The slider tops out at 45% deliberately. Past roughly that the board reads as the
      // finished picture with pieces scattered on it, and placing a piece stops being a
      // judgement about the picture -- it becomes tracing.
      this.setGhost(Number(this.els.ghost.value));
      try {
        localStorage.setItem('ojs:ghost', this.els.ghost.value);
      } catch {
        /* storage disabled; the ghost simply starts off next time */
      }
    });
    try {
      const saved = localStorage.getItem('ojs:ghost');
      if (saved !== null) {
        this.els.ghost.value = saved;
        this.setGhost(Number(saved));
      }
    } catch {
      /* storage disabled; start with no ghost */
    }

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

    this.els.importFile.addEventListener('change', () => {
      const file = this.els.importFile.files?.[0];
      if (file) void this.importPuzzleFile(file);
      this.els.importFile.value = '';
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
      else if (e.key === 't' || e.key === 'T') this.newTray();
      else return;
      e.preventDefault();
    });

    this.els.colourCount.addEventListener('change', () => {
      if (this.colourGroups) this.startColourSort();
    });

    this.els.trayList.addEventListener('change', () => {
      const value = this.els.trayList.value;
      if (value) this.jumpToTray(Number(value));
    });

    this.els.trayRename.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.commitTrayRename(true);
      else if (e.key === 'Escape') this.commitTrayRename(false);
      e.stopPropagation();
    });
    this.els.trayRename.addEventListener('blur', () => this.commitTrayRename(true));

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
    try {
      await this.adoptImage(blob, 'Sample landscape');
    } catch (err) {
      // Boot must not die on a storage failure: the sample puzzle is a convenience.
      this.setStatus(`Could not start the sample puzzle: ${(err as Error).message}`);
    }
  }

  /**
   * Release the bitmaps a session owns.
   *
   * `image` and `original` are the *same object* on an unedited puzzle, which is the
   * common case, so the distinct-object check is what stops a double close.
   */
  private closeSession(): void {
    if (!this.session) return;
    if (this.session.image !== this.session.original) this.session.image.close();
    this.session.original.close();
    this.session = null;
  }

  /**
   * The picture a puzzle is actually cut from.
   *
   * Returns the original itself when there is nothing to apply. Copying it instead would
   * be tidier — every session would own two independent bitmaps — but it would also hold
   * a second full-size decode of every photograph for the overwhelming majority of
   * puzzles, which have no edit at all. At the 5000px import cap that is another ~66 MB
   * of RGBA per session, on hardware where the bake cache is already budgeted at 96 MB.
   * The alias is cheap; the ownership rule lives in `closeSession()`.
   */
  private async deriveImage(original: ImageBitmap, edit: ImageEdit): Promise<ImageBitmap> {
    if (isUneditedImage(edit)) return original;
    const out = await renderEdited(original, original.width, original.height, edit, MAX_IMAGE_EDGE);
    return out.bitmap;
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
    // Deliberately not swallowed. If the picture does not reach storage, the puzzle
    // record written a moment later will outlive it and the library gets a card that
    // cannot be opened — better to refuse the import and say why.
    try {
      await putImage(meta);
    } catch (err) {
      throw new Error(
        `the picture could not be saved (${(err as Error).message}), so the puzzle was not created`,
      );
    }

    this.closeSession();
    await this.startPuzzle(meta, bitmap, name, DEFAULT_EDIT);
  }

  /**
   * Cut a new puzzle. `original` is the picture as stored; `edit` says how to prepare it
   * first, and the cut is made from the prepared result.
   */
  private async startPuzzle(
    meta: StoredImage,
    original: ImageBitmap,
    title: string,
    edit: ImageEdit,
  ): Promise<void> {
    const image = await this.deriveImage(original, edit);
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
      edit: isUneditedImage(edit) ? null : edit,
    };

    this.session = { record, state, image, original, imageMeta: meta, edit };
    // Colours are per piece, so a different cut or a different picture invalidates them.
    this.pieceColours = null;
    this.endColourSort();
    this.renderer.invalidateGeometry();
    this.renderer.setImage(image, image.width, image.height);
    this.els.title.value = title;
    this.activeTray = null;
    this.reapplyAssistance();
    this.updateRotationUi();
    this.refreshTrayUi();
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
    // The prepared picture is re-derived from the original every time, which is why the
    // crop could be stored as parameters instead of as a second copy of the photograph.
    const edit: ImageEdit = record.edit ?? DEFAULT_EDIT;
    const image = await this.deriveImage(bitmap, edit);
    this.closeSession();
    this.session = { record, state, image, original: bitmap, imageMeta: meta, edit };
    this.pieceColours = null;
    this.endColourSort();
    this.renderer.invalidateGeometry();
    this.renderer.setImage(image, image.width, image.height);
    this.els.title.value = record.title;
    this.els.pieces.value = String(
      PIECE_CHOICES.reduce((best, n) =>
        Math.abs(n - record.pieceCount) < Math.abs(best - record.pieceCount) ? n : best,
      ),
    );
    this.clearSelection();
    this.activeTray = null;
    this.reapplyAssistance();
    this.updateRotationUi();
    this.refreshTrayUi();
    // Records written before thumbnails existed get one now, so the library is not
    // permanently full of blank cards for older puzzles.
    if (!record.thumbnail) {
      record.thumbnail = makeThumbnail(image, image.width, image.height);
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
    const { imageMeta, original, image, record, edit } = this.session;
    // The original is handed straight to the next puzzle rather than copied: decoding a
    // 5000px photograph twice to cut the same picture again would be pure waste. Only
    // the derived working image, which is about to be rebuilt, is released.
    if (image !== original) image.close();
    this.session = null;
    await this.startPuzzle(imageMeta, original, record.title, edit);
  }

  /**
   * Reopen preparation for the current picture and cut a fresh puzzle from the result.
   *
   * Preparation always starts from the untouched original, so a crop can be widened as
   * easily as narrowed and adjustments never compound. Cutting is unavoidable: the piece
   * outlines are laid out over a picture of a particular size, so changing the picture
   * changes the puzzle.
   */
  private async prepareImage(): Promise<void> {
    if (!this.session) return;
    const { original, imageMeta, record, edit } = this.session;

    const view = new PrepareView(this.root, {
      image: original,
      edit,
      pieceCount: Number(this.els.pieces.value),
      maxEdge: MAX_IMAGE_EDGE,
      title: record.title,
    });
    const next = await view.open();
    if (!next) {
      this.setStatus('Preparation cancelled — the puzzle is untouched.');
      return;
    }

    // Same ownership handover as `newPuzzle()`: the original carries across untouched.
    const title = record.title;
    const stale = this.session?.image;
    if (stale && stale !== original) stale.close();
    this.session = null;
    await this.startPuzzle(imageMeta, original, title, next);
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

  /**
   * Push the selection to the renderer, and recompute the hint outlines with it.
   *
   * Hints are derived from the selection rather than tracked separately, so they cannot
   * drift out of step with it: every path that changes what is selected comes through
   * here, and there is no second place to forget.
   */
  private syncSelection(): void {
    this.renderer.selection = this.selection;
    this.refreshHints();
  }

  /**
   * Re-derive the assistance state for a newly opened puzzle.
   *
   * The border-piece set belongs to one puzzle's geometry, so carrying it across to
   * another would hide the wrong pieces. The switches themselves stay as the user left
   * them — having to turn hints back on for every puzzle would be its own annoyance.
   */
  private reapplyAssistance(): void {
    this.renderer.onlyPieces =
      this.edgesOnly && this.session ? borderPieceIds(this.session.state) : null;
    this.els.edgesOnly.classList.toggle('on', this.edgesOnly);
    this.els.hints.classList.toggle('on', this.hintsOn);
    this.refreshHints();
  }

  private refreshHints(): void {
    if (!this.hintsOn || !this.session) {
      this.renderer.hintClusters = null;
      return;
    }
    const ids = new Set<number>();
    for (const clusterId of this.selection) {
      for (const id of neighbourClusters(this.session.state, clusterId)) ids.add(id);
    }
    this.renderer.hintClusters = ids;
  }

  /**
   * Hints outline the clusters that belong beside the selection.
   *
   * Deliberately tied to a selection rather than shown for everything at once: outlining
   * every neighbour of every piece would light up the whole board and tell you nothing.
   * You ask about the piece in your hand.
   */
  private toggleHints(): void {
    this.hintsOn = !this.hintsOn;
    this.els.hints.classList.toggle('on', this.hintsOn);
    this.refreshHints();
    this.dirty = true;
    if (!this.hintsOn) this.setStatus('Hints off.');
    else if (this.selection.size === 0) {
      this.setStatus('Hints on — select a piece and its neighbours will be outlined.');
    } else {
      this.setStatus(`Hints on — ${this.renderer.hintClusters?.size ?? 0} neighbours outlined.`);
    }
  }

  /**
   * Edges-only hides every interior piece.
   *
   * Nothing is moved or lost: it is a display filter over the same state, so switching it
   * off brings everything back exactly where it was. The pieces are made ungrabbable as
   * well as invisible, since an invisible piece that still catches the pointer is worse
   * than no filter at all.
   */
  private toggleEdgesOnly(): void {
    if (!this.session) return;
    this.edgesOnly = !this.edgesOnly;
    this.els.edgesOnly.classList.toggle('on', this.edgesOnly);
    if (this.edgesOnly) {
      const border = borderPieceIds(this.session.state);
      this.renderer.onlyPieces = border;
      // A selection may contain interior pieces that are about to vanish; keeping it
      // would let a rotate or a drag act on pieces that cannot be seen.
      this.clearSelection();
      const total = this.session.state.geometry.pieces.length;
      this.setStatus(`Edges only — showing ${border.size} border pieces of ${total}.`);
    } else {
      this.renderer.onlyPieces = null;
      this.setStatus('Showing every piece again.');
    }
    this.dirty = true;
  }

  private setGhost(percent: number): void {
    this.renderer.ghost = Math.min(45, Math.max(0, percent)) / 100;
    this.dirty = true;
  }

  private clearSelection(): void {
    if (this.selection.size === 0) return;
    this.selection.clear();
    this.syncSelection();
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

  // --- Help -----------------------------------------------------------------

  private setupHelp(): void {
    const bar = this.root.querySelector<HTMLElement>('.bar')!;

    const target = (e: Event): HTMLElement | null =>
      (e.target as HTMLElement).closest<HTMLElement>('[data-help]');

    bar.addEventListener('pointerover', (e) => {
      const el = target(e);
      if (!el) return;
      // A short delay so sweeping the mouse across the toolbar does not flash tooltips.
      if (this.tipTimer !== null) window.clearTimeout(this.tipTimer);
      this.tipTimer = window.setTimeout(() => this.showTip(el), this.helpMode ? 0 : 350);
    });

    bar.addEventListener('pointerout', (e) => {
      if (!target(e)) return;
      if (this.tipTimer !== null) window.clearTimeout(this.tipTimer);
      if (!this.helpMode) this.hideTip();
    });

    // Keyboard users get the same text on focus.
    bar.addEventListener('focusin', (e) => {
      const el = target(e);
      if (el) this.showTip(el);
    });
    bar.addEventListener('focusout', () => this.hideTip());

    // In help mode a press explains rather than acts. Both events have to be caught:
    // swallowing `pointerdown` alone still lets the browser deliver the `click` that the
    // toolbar's own handler listens for, so the button fired anyway. A `change` on a
    // select would likewise act without ever producing a click.
    const intercept = (e: Event): void => {
      if (!this.helpMode) return;
      const el = target(e);
      if (!el || el.matches('.help-toggle')) return;
      e.preventDefault();
      e.stopPropagation();
      this.showTip(el);
    };
    bar.addEventListener('pointerdown', intercept, true);
    bar.addEventListener('click', intercept, true);
    bar.addEventListener('change', intercept, true);

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (this.helpMode) this.setHelpMode(false);
        else if (this.colourGroups) this.endColourSort();
      }
    });
  }

  private setHelpMode(on: boolean): void {
    this.helpMode = on;
    const toggle = this.root.querySelector<HTMLButtonElement>('.help-toggle');
    toggle?.classList.toggle('on', on);
    if (on) {
      this.setStatus('Help mode — point at or tap any control to see what it does. Esc to leave.');
    } else {
      this.hideTip();
      this.updateStatus();
    }
  }

  private showTip(el: HTMLElement): void {
    const text = el.dataset['help'];
    if (!text) return;
    const tip = this.els.tip;
    tip.textContent = text;
    tip.hidden = false;

    const box = el.getBoundingClientRect();
    const rootBox = this.root.getBoundingClientRect();
    // Measure after filling, then clamp so a tooltip near the right edge stays on screen.
    const width = tip.offsetWidth;
    const left = Math.max(
      8,
      Math.min(box.left - rootBox.left + box.width / 2 - width / 2, rootBox.width - width - 8),
    );
    tip.style.left = `${left}px`;
    tip.style.top = `${box.bottom - rootBox.top + 8}px`;
  }

  private hideTip(): void {
    this.els.tip.hidden = true;
  }

  // --- Trays ----------------------------------------------------------------

  /**
   * Make a tray from whatever is selected, placed clear of the board.
   *
   * Created empty when nothing is selected, so a player can set up "sky", "edges" and
   * "buildings" before sorting anything into them — which is how people actually work.
   */
  private newTray(): void {
    if (!this.session) return;
    const state = this.session.state;
    const ids = [...this.selection].filter((id) => state.clusters.has(id));

    const spot = this.findTraySpot(state);
    const tray = createTray(state, { x: spot.x, y: spot.y, clusters: ids });

    this.activeTray = tray.id;
    this.clearSelection();
    this.refreshTrayUi();
    this.dirty = true;
    this.setStatus(
      ids.length > 0
        ? `“${tray.name}” holds ${trayPieceCount(state, tray)} pieces. Click its title to rename.`
        : `“${tray.name}” created. Drag pieces onto it, or click its title to rename.`,
    );
    this.beginTrayRename(tray.id);
    void this.save();

    // Mid-sort, filing a group should advance to the next one rather than leaving the
    // player to press the arrow after every single tray.
    if (this.colourGroups) this.stepColourGroup(1);
  }

  /**
   * Where to put a new tray.
   *
   * Down the left of whatever the player is looking at, rather than at the centre of the
   * view: a tray dropped in the middle covers the board, which is the one place it must
   * not be. Existing trays are stepped over so a second tray does not land on the first.
   */
  private findTraySpot(state: PuzzleState): { x: number; y: number } {
    const size = this.renderer.size;
    const view = {
      tl: screenToWorld(this.viewport, size, { x: 0, y: 0 }),
      br: screenToWorld(this.viewport, size, { x: size.width, y: size.height }),
    };
    const width = defaultTrayWidth(state);
    const gap = trayMetrics(state).header * 0.5;

    let x = view.tl.x + (view.br.x - view.tl.x) * 0.03;
    const y0 = view.tl.y + (view.br.y - view.tl.y) * 0.05;
    let y = y0;

    // Step past anything already occupying the column, then wrap to a second column.
    for (let guard = 0; guard < 40; guard++) {
      let clash = false;
      for (const other of state.trays.values()) {
        const b = trayBounds(state, other);
        const overlaps =
          x < b.x + b.w + gap && x + width + gap > b.x && y < b.y + b.h + gap && y + gap > b.y - b.h;
        if (overlaps) {
          y = b.y + b.h + gap;
          clash = true;
          break;
        }
      }
      if (!clash) break;
      if (y > view.br.y) {
        y = y0;
        x += width + gap;
      }
    }
    return { x, y };
  }

  /** Select every edge and corner piece — the first move in solving any real puzzle. */
  private selectEdges(): void {
    if (!this.session) return;
    const ids = edgeClusters(this.session.state);
    this.selection.clear();
    for (const id of ids) this.selection.add(id);
    this.syncSelection();
    this.updateStatus();
    this.dirty = true;
    this.setStatus(
      `${ids.length} edge piece${ids.length === 1 ? '' : 's'} selected. Press New tray to gather them.`,
    );
  }

  // --- Colour sorting -------------------------------------------------------

  /**
   * Group the loose pieces by colour and start stepping through the groups.
   *
   * Groups are computed once and worked through, rather than being turned into trays
   * automatically. The algorithm can tell that these pieces are similar; it cannot know
   * whether you wanted "sky" and "sea" together or apart, and guessing wrong makes more
   * work than it saves.
   */
  private startColourSort(): void {
    if (!this.session) return;
    const { state, image } = this.session;

    if (!this.pieceColours) {
      this.setStatus('Reading the picture\u2026');
      this.pieceColours = samplePieceColours(image, image.width, image.height, state.geometry);
    }

    const groups = groupByColour(state, this.pieceColours, {
      groups: Number(this.els.colourCount.value),
    });

    if (groups.length === 0) {
      this.setStatus('Nothing left to sort \u2014 every piece is already in a tray.');
      return;
    }

    this.colourGroups = groups;
    this.colourIndex = 0;
    this.els.colourNav.hidden = false;
    this.showColourGroup();
  }

  private endColourSort(): void {
    this.colourGroups = null;
    this.els.colourNav.hidden = true;
    this.clearSelection();
    this.updateStatus();
  }

  private stepColourGroup(delta: number): void {
    if (!this.colourGroups) return;
    const n = this.colourGroups.length;
    this.colourIndex = (this.colourIndex + delta + n) % n;
    this.showColourGroup();
  }

  /** Select the current group, skipping any emptied since the sort was computed. */
  private showColourGroup(attempts = 0): void {
    if (!this.session || !this.colourGroups) return;
    const group = this.colourGroups[this.colourIndex];
    if (!group) return;

    const members = liveMembers(this.session.state, group);
    if (members.length === 0) {
      // Every group can be empty once the last is filed; stop rather than spin.
      if (attempts >= this.colourGroups.length) {
        this.setStatus('All the colour groups have been put away.');
        this.endColourSort();
        return;
      }
      this.colourIndex = (this.colourIndex + 1) % this.colourGroups.length;
      this.showColourGroup(attempts + 1);
      return;
    }

    this.selection.clear();
    for (const id of members) this.selection.add(id);
    this.syncSelection();
    this.dirty = true;

    const [r, g, b] = oklabToRgb(group.centre);
    this.els.swatch.style.background = `rgb(${r},${g},${b})`;
    let pieces = 0;
    for (const id of members) pieces += this.session.state.clusters.get(id)?.pieces.length ?? 0;
    this.els.colourLabel.textContent =
      `${this.colourIndex + 1}/${this.colourGroups.length} \u00b7 ${pieces} pieces`;
    this.setStatus(
      `Colour group ${this.colourIndex + 1} of ${this.colourGroups.length}: ${pieces} pieces selected. ` +
        `Press New tray to keep it, or the arrow to skip.`,
    );
  }

  private toggleActiveTray(): void {
    if (!this.session || this.activeTray === null) return;
    const tray = this.session.state.trays.get(this.activeTray);
    if (!tray) return;
    setTrayCollapsed(this.session.state, tray.id, !tray.collapsed);
    this.refreshTrayUi();
    this.dirty = true;
    void this.save();
  }

  private emptyActiveTray(): void {
    if (!this.session || this.activeTray === null) return;
    const state = this.session.state;
    const tray = state.trays.get(this.activeTray);
    if (!tray) return;
    const n = trayPieceCount(state, tray);
    deleteTray(state, tray.id);
    this.activeTray = null;
    this.refreshTrayUi();
    this.dirty = true;
    this.setStatus(`Tray removed. ${n} piece${n === 1 ? '' : 's'} left on the board.`);
    void this.save();
  }

  private refreshTrayUi(): void {
    const state = this.session?.state;
    const trays = state ? [...state.trays.values()] : [];

    if (this.activeTray !== null && !state?.trays.has(this.activeTray)) this.activeTray = null;
    this.renderer.selectedTray = this.activeTray;

    const list = this.els.trayList;
    const previous = this.activeTray === null ? '' : String(this.activeTray);
    list.innerHTML = '';
    const head = document.createElement('option');
    head.value = '';
    head.textContent = trays.length === 0 ? 'No trays' : `Trays (${trays.length})`;
    list.append(head);
    for (const tray of trays) {
      const opt = document.createElement('option');
      opt.value = String(tray.id);
      // textContent, not innerHTML: tray names are user input.
      opt.textContent = `${tray.name} · ${trayPieceCount(state!, tray)}`;
      list.append(opt);
    }
    list.value = previous;
    list.disabled = trays.length === 0;

    const active = this.activeTray === null ? null : (state?.trays.get(this.activeTray) ?? null);
    for (const btn of this.root.querySelectorAll<HTMLButtonElement>('.tray-only')) {
      btn.disabled = active === null;
    }
    const collapseBtn = this.root.querySelector<HTMLButtonElement>('[data-act="collapse-tray"]');
    if (collapseBtn) collapseBtn.textContent = active?.collapsed ? 'Expand' : 'Collapse';
    this.dirty = true;
  }

  private jumpToTray(trayId: number): void {
    if (!this.session) return;
    const state = this.session.state;
    const tray = state.trays.get(trayId);
    if (!tray) return;
    const b = trayBounds(state, tray);
    this.activeTray = trayId;
    this.viewport = { ...this.viewport, x: b.x + b.w / 2, y: b.y + b.h / 2 };
    this.refreshTrayUi();
    this.dirty = true;
  }

  /** Float a text input over the tray's title bar so it can be renamed in place. */
  private beginTrayRename(trayId: number): void {
    if (!this.session) return;
    const state = this.session.state;
    const tray = state.trays.get(trayId);
    if (!tray) return;

    const b = trayBounds(state, tray);
    const { header } = trayMetrics(state);
    const canvasBox = this.canvas.getBoundingClientRect();
    const stageBox = this.els.stage.getBoundingClientRect();
    const tl = worldToScreen(this.viewport, this.renderer.size, { x: b.x, y: b.y });

    const input = this.els.trayRename;
    input.value = tray.name;
    input.dataset['trayId'] = String(trayId);
    input.hidden = false;
    input.style.left = `${canvasBox.left - stageBox.left + tl.x + 2}px`;
    input.style.top = `${canvasBox.top - stageBox.top + tl.y + 2}px`;
    input.style.width = `${Math.max(90, b.w * this.viewport.zoom - 4)}px`;
    input.style.height = `${Math.max(20, header * this.viewport.zoom - 4)}px`;
    input.focus();
    input.select();
  }

  private commitTrayRename(save: boolean): void {
    const input = this.els.trayRename;
    if (input.hidden) return;
    const trayId = Number(input.dataset['trayId']);
    input.hidden = true;
    if (!save || !this.session) return;
    renameTray(this.session.state, trayId, input.value);
    this.refreshTrayUi();
    this.dirty = true;
    void this.save();
  }

  // --- Library --------------------------------------------------------------

  private async openLibrary(): Promise<void> {
    await this.save();
    const records = await listPuzzles().catch(() => [] as PuzzleRecord[]);
    // One read for the whole library rather than one per card.
    const haveImage = await storedImageHashes().catch(() => null);
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
      // `null` means the check itself failed; only a definite miss is reported as one.
      const orphaned = haveImage !== null && !haveImage.has(record.imageHash);
      if (orphaned) card.classList.add('orphaned');

      card.innerHTML = `
        <div class="lib-thumb">${
          record.thumbnail ? `<img alt="" src="${record.thumbnail}" />` : '<span>no preview</span>'
        }</div>
        <div class="lib-meta">
          <div class="lib-title"></div>
          <div class="lib-sub">${record.pieceCount} pieces · ${state}</div>
          <div class="lib-sub">${
            orphaned
              ? '<span class="lib-warn">Picture missing — relink it to open this puzzle</span>'
              : `Last played ${formatWhen(record.lastPlayed)}`
          }</div>
        </div>
        <div class="lib-actions">
          ${
            orphaned
              ? '<button class="btn on lib-relink" title="Choose the original picture file again. It must be the same file the puzzle was made from.">Relink picture…</button>'
              : '<button class="btn lib-open">Open</button>'
          }
          <button class="btn lib-export" title="Save as a .jigsaw file">Export</button>
          <button class="btn lib-delete" title="Delete this puzzle">Delete</button>
        </div>`;
      // Set the title as text, never as HTML: it is user input.
      card.querySelector<HTMLElement>('.lib-title')!.textContent = record.title;

      card.querySelector<HTMLButtonElement>('.lib-open')?.addEventListener('click', () => {
        void this.openFromLibrary(record);
      });
      card.querySelector<HTMLButtonElement>('.lib-relink')?.addEventListener('click', () => {
        this.relinkPicture(record);
      });
      card.querySelector<HTMLButtonElement>('.lib-export')!.addEventListener('click', () => {
        void this.exportPuzzle(record);
      });
      card.querySelector<HTMLButtonElement>('.lib-delete')!.addEventListener('click', (e) => {
        void this.deleteFromLibrary(record, e.currentTarget as HTMLButtonElement);
      });
      list.append(card);
    }

    this.refreshBackupButton();
    this.els.library.hidden = false;
  }

  // --- Files and backup -----------------------------------------------------

  /** Download a puzzle as a self-contained `.jigsaw` file. */
  private async exportPuzzle(record: PuzzleRecord): Promise<void> {
    try {
      const image = await getImage(record.imageHash);
      if (!image) throw new Error('the picture for this puzzle is missing');
      const blob = puzzleFileToBlob(await buildPuzzleFile(record, image));

      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = safeFileName(record.title);
      link.click();
      // Revoke on the next turn of the event loop; revoking immediately can cancel the
      // download in some browsers before it has started reading the blob.
      setTimeout(() => URL.revokeObjectURL(url), 10_000);

      this.setLibraryNote(`Saved \u201c${record.title}\u201d as a .jigsaw file.`);
    } catch (err) {
      this.setLibraryNote(`Could not export: ${(err as Error).message}`);
    }
  }

  private async importPuzzleFile(file: File): Promise<void> {
    this.setLibraryNote('Reading\u2026');
    try {
      const { record, image } = await readPuzzleFile(await file.text());
      // Give it a preview now rather than leaving a blank card in the library until the
      // puzzle happens to be opened.
      try {
        const bitmap = await createImageBitmap(image.blob, { imageOrientation: 'from-image' });
        // An imported puzzle may have been cut from a prepared picture, so the card has
        // to show the prepared version — otherwise a cropped puzzle previews uncropped.
        const shown = await this.deriveImage(bitmap, record.edit ?? DEFAULT_EDIT);
        record.thumbnail = makeThumbnail(shown, shown.width, shown.height);
        if (shown !== bitmap) shown.close();
        bitmap.close();
      } catch {
        /* an unreadable picture still imports; the card just shows no preview */
      }
      await putImage(image);
      await putPuzzle(record);
      this.setLibraryNote(`Imported \u201c${record.title}\u201d.`);
      await this.openLibrary();
    } catch (err) {
      this.setLibraryNote((err as Error).message);
    }
  }

  private setLibraryNote(text: string): void {
    this.els.libNote.textContent = text;
    this.els.libNote.hidden = text.length === 0;
  }

  /**
   * Choose a folder that receives a .jigsaw copy of every save.
   *
   * Point it at OneDrive or Google Drive and the desktop sync client does the uploading:
   * backup and rough cross-device transfer with no account, no OAuth and no server. Only
   * possible on desktop Chromium; every mobile browser lacks the API entirely.
   */
  private async chooseBackupFolder(): Promise<void> {
    if (!backupSupported()) {
      this.setLibraryNote(
        'This browser cannot link a folder. Use Export instead, and save the file into ' +
          'your OneDrive or Google Drive folder yourself.',
      );
      return;
    }
    if (this.backupHandle) {
      await forgetFolder();
      this.backupHandle = null;
      this.refreshBackupButton();
      this.setLibraryNote('Backup folder disconnected.');
      return;
    }
    const handle = await chooseFolder();
    if (!handle) return;
    this.backupHandle = handle;
    this.refreshBackupButton();
    this.setLibraryNote(
      `Backing up to \u201c${handle.name}\u201d. Every save writes a .jigsaw file there; ` +
        `if that folder is synced by OneDrive or Google Drive, your puzzles go with it.`,
    );
    await this.writeBackupCopy();
  }

  private refreshBackupButton(): void {
    const btn = this.root.querySelector<HTMLButtonElement>('.backup-btn');
    if (!btn) return;
    const supported = backupSupported();
    btn.disabled = false;
    btn.textContent = this.backupHandle ? `Backup: ${this.backupHandle.name}` : 'Backup folder\u2026';
    btn.classList.toggle('on', Boolean(this.backupHandle));
    btn.dataset['help'] = supported
      ? 'Write a .jigsaw copy of every save into a folder you choose. Point it at your OneDrive or Google Drive folder and your sync client backs the puzzles up for you. Press again to disconnect.'
      : 'This browser cannot link a folder \u2014 that only works in Chrome or Edge on a computer. Use Export instead and save the file into your synced folder.';
  }

  /**
   * Copy the current puzzle into the backup folder.
   *
   * Never prompts: a browser only shows the permission dialog during a user gesture, so
   * asking here would fail silently during an autosave and look like a bug. If the grant
   * has lapsed the copy is skipped until the next time the folder is chosen by hand.
   */
  private async writeBackupCopy(): Promise<void> {
    if (!this.backupHandle || !this.session) return;
    const { record } = this.session;
    try {
      if ((await folderPermission(this.backupHandle)) !== 'granted') return;
      const image = await getImage(record.imageHash);
      if (!image) return;
      const blob = puzzleFileToBlob(await buildPuzzleFile(record, image));
      await writeBackup(this.backupHandle, safeFileName(record.title), blob);
    } catch {
      // A backup that fails must never interrupt play.
    }
  }

  private closeLibrary(): void {
    this.els.library.hidden = true;
  }

  /**
   * A failure here used to be reported as "its image is missing" whatever went wrong,
   * which was a guess dressed as a diagnosis. The three cases are genuinely different and
   * only one of them is recoverable, so they are told apart before anything is said.
   */
  private async openFromLibrary(record: PuzzleRecord): Promise<void> {
    this.closeLibrary();
    if (this.session?.record.id === record.id) return;
    try {
      if (await this.openRecord(record)) {
        setLastOpened(record.id);
        return;
      }
      const meta = await getImage(record.imageHash).catch(() => undefined);
      this.setStatus(
        meta
          ? `Could not reopen “${record.title}” — its saved progress is unreadable.`
          : `Could not reopen “${record.title}” — its picture is no longer in storage. ` +
            `Open My puzzles and press Relink picture… to point it back at the original file.`,
      );
    } catch (err) {
      this.setStatus(`Could not reopen “${record.title}”: ${(err as Error).message}`);
    }
  }

  /**
   * Give an orphaned puzzle its picture back.
   *
   * Images are keyed by the SHA-256 of their bytes, which makes this exact rather than a
   * guess: the chosen file either hashes to what the puzzle is asking for or it does not,
   * and if it does the record simply starts working again with its progress intact.
   */
  private relinkPicture(record: PuzzleRecord): void {
    const picker = document.createElement('input');
    picker.type = 'file';
    picker.accept = 'image/*';
    picker.addEventListener('change', () => {
      const file = picker.files?.[0];
      if (file) void this.applyRelink(record, file);
    });
    picker.click();
  }

  private async applyRelink(record: PuzzleRecord, file: File): Promise<void> {
    this.setLibraryNote('Checking that picture…');
    try {
      const hash = await hashBlob(file);
      if (hash !== record.imageHash) {
        this.setLibraryNote(
          `That is not the picture “${record.title}” was made from. The pieces were cut ` +
            `from one exact file, so a resaved or edited copy will not fit — it has to be ` +
            `the original.`,
        );
        return;
      }

      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      // The stored dimensions have to be the ones the puzzle was cut against, which for a
      // photograph over the import cap is the downscaled size, not the file's own. Get
      // this wrong and the picture reopens at a different scale from its pieces.
      const longest = Math.max(bitmap.width, bitmap.height);
      const scale = longest > MAX_IMAGE_EDGE ? MAX_IMAGE_EDGE / longest : 1;
      await putImage({
        hash,
        blob: file,
        width: Math.round(bitmap.width * scale),
        height: Math.round(bitmap.height * scale),
        name: file.name.replace(/\.[^.]+$/, ''),
        addedAt: Date.now(),
      });
      bitmap.close();
      this.setLibraryNote(`Picture restored — “${record.title}” will open again.`);
      await this.openLibrary();
    } catch (err) {
      this.setLibraryNote(`Could not relink that picture: ${(err as Error).message}`);
    }
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
      this.closeSession();
      await this.useDemoImage();
    }
    await this.openLibrary();
  }

  // --- Saving ---------------------------------------------------------------

  /**
   * A failed save must be visible.
   *
   * This is the most important write in the application — an autosave failing quietly
   * means losing hours of a 2,000-piece puzzle and being told nothing. It used to be
   * `.catch(() => undefined)`, the same swallow that let a puzzle outlive its picture.
   * The failure is now reported, and reported once rather than every twenty seconds,
   * because a storage problem does not fix itself between autosaves.
   */
  private async save(): Promise<void> {
    if (!this.session) return;
    const { record, state } = this.session;
    state.elapsedMs += performance.now() - this.playingSince;
    this.playingSince = performance.now();

    record.saved = serialize(state, GEOMETRY_OPTIONS, this.viewport);
    record.lastPlayed = Date.now();
    record.progress = progress(state);
    if (isComplete(state) && record.completedAt === null) record.completedAt = Date.now();

    try {
      await putPuzzle(record);
      if (this.saveFailed) {
        this.saveFailed = false;
        this.setStatus('Saving again — your progress is stored.');
      }
    } catch (err) {
      if (!this.saveFailed) {
        this.saveFailed = true;
        this.setStatus(
          `Your progress is NOT being saved: ${(err as Error).message}. ` +
            `Use Export in My puzzles to save this puzzle to a file before closing.`,
        );
      }
    }
    void this.writeBackupCopy();
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
