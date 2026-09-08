/** Core engine types. Headless: nothing here may reference the DOM. */

export interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * A path command in image space. Deliberately minimal and renderer-agnostic:
 * Canvas2D turns these into a Path2D, and a future WebGL renderer flattens and
 * triangulates them. Neither representation is baked into the engine.
 */
export type PathCommand =
  | { readonly kind: 'move'; readonly to: Point }
  | { readonly kind: 'cubic'; readonly c1: Point; readonly c2: Point; readonly to: Point }
  | { readonly kind: 'close' };

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Which side of a piece an edge sits on. */
export type Side = 'top' | 'right' | 'bottom' | 'left';

/**
 * Geometry for one piece, in *image space* (pixels of the source image).
 *
 * `outline` is closed and expressed relative to `bounds.x/y`, so that a renderer
 * can bake the piece into a bitmap of exactly `bounds.w x bounds.h` without
 * further arithmetic. `bounds` doubles as the UV rect into the source image.
 */
export interface PieceGeometry {
  readonly id: number;
  readonly row: number;
  readonly col: number;
  /** Bounding box in image space, including tab overhang. Also the UV rect. */
  readonly bounds: Rect;
  /** Closed outline, relative to bounds.x/y. */
  readonly outline: readonly PathCommand[];
  /**
   * The piece's position when solved: the image-space coordinate its bounds
   * top-left occupies in the completed picture. Equal to bounds.x/y — kept as a
   * separate field because "where this piece belongs" and "how big its bitmap
   * is" are different concepts and will diverge if we ever pad bitmaps.
   */
  readonly solved: Point;
  /**
   * Neighbour piece ids by side, or -1 at the puzzle border.
   *
   * Only meaningful for the classic cut, where a piece is exactly one grid cell and
   * therefore has exactly four sides. A polyomino piece has as many boundary segments as
   * its silhouette needs — eight for an L, twelve for a cross — so anything that asks
   * "what is next to this piece" must use `adjacent`, not this. Kept because the
   * shared-edge tests address a specific side, and because it costs nothing.
   */
  readonly neighbours: Readonly<Record<Side, number>>;
  /**
   * Every piece that shares a boundary with this one, in ascending id order.
   *
   * The general form of `neighbours`, and the only adjacency the rest of the engine is
   * allowed to consult. Snapping, hints, edge selection and edges-only display all run
   * off this, which is what let a second cut exist without touching any of them.
   */
  readonly adjacent: readonly number[];
  /** True when any part of this piece lies on the outside of the picture. */
  readonly isBorder: boolean;
  /**
   * Grid cells this piece occupies. One cell for a classic piece, several for a
   * polyomino. Colour sampling needs it: the bounding box of an L includes a large
   * rectangle of the *neighbouring* piece's picture, so averaging over the box would
   * read the wrong colours entirely.
   */
  readonly cells: readonly { readonly row: number; readonly col: number }[];
  /**
   * How many cubic commands each side contributes to `outline`, in the order
   * top, right, bottom, left (following the leading `move`). Lets a consumer address
   * one side of a piece without re-deriving the geometry — used by the edge-matching
   * tests today, and by edge-only mode and neighbour highlighting later.
   */
  readonly sideSegmentCounts: Readonly<Record<Side, number>>;
}

export interface PuzzleGeometry {
  readonly seed: number;
  readonly rows: number;
  readonly cols: number;
  readonly imageWidth: number;
  readonly imageHeight: number;
  readonly pieces: readonly PieceGeometry[];
  /** Nominal cell size, before tabs and vertex jitter. Used for snap tolerance. */
  readonly cellWidth: number;
  readonly cellHeight: number;
  /**
   * Which generator produced these pieces. Absent means classic, so every geometry made
   * before a second cut existed still reads correctly.
   */
  readonly cut?: 'classic' | 'polyomino';
  /** Recorded so a save can regenerate the identical tiling. */
  readonly polyominoOptions?: Readonly<Record<string, unknown>>;
}

/** A connected group of pieces that moves as one unit. */
export interface Cluster {
  id: number;
  /** Piece ids in this cluster. Always sorted ascending. */
  pieces: number[];
  /** World-space translation of the cluster pivot. */
  x: number;
  y: number;
  /** Rotation in radians, about the pivot. */
  rotation: number;
  /** Image-space centroid of the cluster's pieces' solved positions. */
  pivotX: number;
  pivotY: number;
  /** User-assigned name. Null for ordinary connected groups; set for named groups. */
  name: string | null;
}

/**
 * A named holding area for loose pieces — the digital equivalent of tipping the sky
 * pieces into a box lid.
 *
 * A tray holds *clusters*, not pieces, so a group you have already joined can be parked
 * without coming apart. It is deliberately not itself a cluster: a cluster is rigid at
 * its members' solved offsets, whereas a tray packs unrelated pieces into a tidy grid
 * with no relationship to where they belong in the picture.
 *
 * Collapsing is the point of the feature. On a 2560px monitor, 500 pieces at a legible
 * size cover most of the screen, so tidying them is not enough — a collapsed tray stops
 * rendering and hit-testing its contents entirely, turning fifty pieces into one tile.
 */
export interface Tray {
  id: number;
  name: string;
  /** World position of the tray's top-left corner, including its header. */
  x: number;
  y: number;
  collapsed: boolean;
  /** Cluster ids held, in packing order. */
  clusters: number[];
  /** Target inner width in world units; packing wraps to this. */
  width: number;
}

export interface Viewport {
  /** World coordinate at the centre of the screen. */
  x: number;
  y: number;
  /** Screen pixels per world unit. */
  zoom: number;
}

export interface PuzzleSettings {
  readonly rotationEnabled: boolean;
  /** Snap distance as a fraction of the smaller cell dimension. */
  readonly snapTolerance: number;
  /** Snap angle tolerance in radians. Ignored when rotation is disabled. */
  readonly angleTolerance: number;
}

export const DEFAULT_SETTINGS: PuzzleSettings = {
  rotationEnabled: false,
  snapTolerance: 0.28,
  angleTolerance: 0.18,
};
