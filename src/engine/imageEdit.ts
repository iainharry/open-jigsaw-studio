/**
 * Image preparation: the maths.
 *
 * An edit is stored as *parameters*, never as a new image. The original photograph stays
 * in storage deduplicated by content hash, and the prepared version is re-derived when a
 * puzzle opens. Six puzzles from one photograph still cost one copy of the photograph,
 * a `.jigsaw` file still carries the original, and a crop is never destructive.
 *
 * Everything here is pure geometry over numbers, so it tests in Node. The canvas work
 * that actually paints the result lives in `src/render/applyEdit.ts`.
 */

/** Quarter turns applied before anything else. */
export type QuarterTurns = 0 | 1 | 2 | 3;

export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ImageEdit {
  /** Quarter turns clockwise. */
  turns: QuarterTurns;
  /** Fine rotation in degrees, for wonky horizons. Positive is clockwise. */
  straighten: number;
  flipH: boolean;
  /**
   * Crop in the coordinate space *after* turns and straightening, or null for the whole
   * usable area. Storing it post-rotation is what lets the crop box stay put while you
   * nudge the straighten slider.
   */
  crop: CropRect | null;
  /** -100..100, 0 = unchanged. */
  brightness: number;
  contrast: number;
  saturation: number;
}

export const DEFAULT_EDIT: ImageEdit = {
  turns: 0,
  straighten: 0,
  flipH: false,
  crop: null,
  brightness: 0,
  contrast: 0,
  saturation: 0,
};

export function isUneditedImage(edit: ImageEdit): boolean {
  return (
    edit.turns === 0 &&
    edit.straighten === 0 &&
    !edit.flipH &&
    edit.crop === null &&
    edit.brightness === 0 &&
    edit.contrast === 0 &&
    edit.saturation === 0
  );
}

/** Dimensions after quarter turns, before straightening or cropping. */
export function turnedSize(
  width: number,
  height: number,
  turns: QuarterTurns,
): { width: number; height: number } {
  return turns % 2 === 1 ? { width: height, height: width } : { width, height };
}

/**
 * Largest axis-aligned rectangle that fits inside a rotated rectangle.
 *
 * This is what stops a straighten leaving transparent wedges in the corners. Rotating a
 * photo by three degrees and cropping to the full frame would include four triangles of
 * nothing; the usable area is strictly smaller, and every crop has to live inside it.
 *
 * Standard result — see the well-known "largest rotated rect" derivation.
 */
export function largestInscribedRect(
  width: number,
  height: number,
  angleRadians: number,
): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: 0, height: 0 };
  const sinA = Math.abs(Math.sin(angleRadians));
  const cosA = Math.abs(Math.cos(angleRadians));
  if (sinA < 1e-12) return { width, height };

  const widthIsLonger = width >= height;
  const sideLong = widthIsLonger ? width : height;
  const sideShort = widthIsLonger ? height : width;

  if (sideShort <= 2 * sinA * cosA * sideLong || Math.abs(sinA - cosA) < 1e-10) {
    // Half-constrained: the rectangle touches the long sides.
    const x = 0.5 * sideShort;
    return widthIsLonger
      ? { width: x / sinA, height: x / cosA }
      : { width: x / cosA, height: x / sinA };
  }

  const cos2a = cosA * cosA - sinA * sinA;
  return {
    width: (width * cosA - height * sinA) / cos2a,
    height: (height * cosA - width * sinA) / cos2a,
  };
}

/** The rectangle a crop may live inside, given the turns and straighten. */
export function usableArea(
  width: number,
  height: number,
  edit: Pick<ImageEdit, 'turns' | 'straighten'>,
): CropRect {
  const turned = turnedSize(width, height, edit.turns);
  const inner = largestInscribedRect(
    turned.width,
    turned.height,
    (edit.straighten * Math.PI) / 180,
  );
  return {
    x: (turned.width - inner.width) / 2,
    y: (turned.height - inner.height) / 2,
    w: inner.width,
    h: inner.height,
  };
}

/** Keep a crop inside its bounds, preserving its size where possible. */
export function clampCrop(crop: CropRect, bounds: CropRect, minSize = 16): CropRect {
  const w = Math.max(minSize, Math.min(crop.w, bounds.w));
  const h = Math.max(minSize, Math.min(crop.h, bounds.h));
  return {
    x: Math.max(bounds.x, Math.min(crop.x, bounds.x + bounds.w - w)),
    y: Math.max(bounds.y, Math.min(crop.y, bounds.y + bounds.h - h)),
    w,
    h,
  };
}

/**
 * Reshape a crop to an aspect ratio, keeping its centre and staying inside bounds.
 * `aspect` is width / height; null leaves the shape alone.
 */
export function applyAspect(crop: CropRect, aspect: number | null, bounds: CropRect): CropRect {
  if (!aspect || aspect <= 0) return clampCrop(crop, bounds);

  const cx = crop.x + crop.w / 2;
  const cy = crop.y + crop.h / 2;

  // Largest rectangle of this aspect that fits the bounds, then shrink to the current size.
  let w = Math.min(crop.w, bounds.w, bounds.h * aspect);
  let h = w / aspect;
  if (h > bounds.h) {
    h = bounds.h;
    w = h * aspect;
  }
  return clampCrop({ x: cx - w / 2, y: cy - h / 2, w, h }, bounds);
}

/** The crop actually in force — the stored one, or the whole usable area. */
export function effectiveCrop(width: number, height: number, edit: ImageEdit): CropRect {
  const bounds = usableArea(width, height, edit);
  return edit.crop ? clampCrop(edit.crop, bounds) : bounds;
}

/**
 * Final pixel dimensions of the prepared image.
 *
 * `maxEdge` caps the long side on import; a crop makes the image smaller, so a heavily
 * cropped 24-megapixel photo may come in well under the cap.
 */
export function editedSize(
  width: number,
  height: number,
  edit: ImageEdit,
  maxEdge: number,
): { width: number; height: number } {
  const crop = effectiveCrop(width, height, edit);
  const scale = Math.min(1, maxEdge / Math.max(crop.w, crop.h));
  return {
    width: Math.max(1, Math.round(crop.w * scale)),
    height: Math.max(1, Math.round(crop.h * scale)),
  };
}

/** CSS filter string for the colour adjustments, or '' when there is nothing to do. */
export function editFilter(edit: Pick<ImageEdit, 'brightness' | 'contrast' | 'saturation'>): string {
  const parts: string[] = [];
  if (edit.brightness !== 0) parts.push(`brightness(${(100 + edit.brightness) / 100})`);
  if (edit.contrast !== 0) parts.push(`contrast(${(100 + edit.contrast) / 100})`);
  if (edit.saturation !== 0) parts.push(`saturate(${(100 + edit.saturation) / 100})`);
  return parts.join(' ');
}

export const ASPECT_PRESETS: ReadonlyArray<{ label: string; value: number | null }> = [
  { label: 'Free', value: null },
  { label: '16:9', value: 16 / 9 },
  { label: '3:2', value: 3 / 2 },
  { label: '4:3', value: 4 / 3 },
  { label: 'Square', value: 1 },
  { label: '3:4', value: 3 / 4 },
];
