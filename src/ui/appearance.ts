/**
 * Appearance and behaviour preferences.
 *
 * These belong to the person and the device, not to a puzzle, so they live in
 * localStorage rather than in a puzzle record: a puzzle carried to another machine on a
 * `.jigsaw` file should look the way *that* machine is set up, not the way the machine it
 * came from was.
 *
 * The values are data rather than CSS so the canvas can use them too. The board is
 * painted by the renderer, which knows nothing about stylesheets, so a table colour has
 * to exist as a number a canvas can fill with — and the same value then drives the CSS
 * custom properties for the surrounding chrome.
 */

export type ThemeName = 'dark' | 'light';
export type TableName = 'slate' | 'felt' | 'oak' | 'ink';
/** How pronounced the moulded edge baked into each piece is. */
export type EdgeStrength = 'off' | 'subtle' | 'strong';

export interface Appearance {
  theme: ThemeName;
  table: TableName;
  edges: EdgeStrength;
  /**
   * Milliseconds between autosaves, or 0 for "only when pieces join".
   *
   * Zero is not "never saved": a save always follows a merge, and one follows any change
   * to the library. The interval only governs the *idle* save that catches pieces moved
   * around without being joined to anything.
   */
  autosaveMs: number;
}

export const DEFAULT_APPEARANCE: Appearance = {
  theme: 'dark',
  table: 'slate',
  edges: 'subtle',
  autosaveMs: 20_000,
};

/** The surface pieces are laid out on, and the tint of the picture area within it. */
export const TABLES: Readonly<
  Record<TableName, { label: string; background: string; boardTint: string }>
> = {
  slate: { label: 'Slate', background: '#14161a', boardTint: 'rgba(255,255,255,0.05)' },
  felt: { label: 'Green felt', background: '#123227', boardTint: 'rgba(255,255,255,0.06)' },
  oak: { label: 'Oak', background: '#3a2c1e', boardTint: 'rgba(255,255,255,0.07)' },
  ink: { label: 'Near black', background: '#08090b', boardTint: 'rgba(255,255,255,0.04)' },
};

export const EDGE_SCALE: Readonly<Record<EdgeStrength, number>> = {
  off: 0,
  subtle: 1,
  strong: 1.9,
};

export const AUTOSAVE_CHOICES: ReadonlyArray<{ label: string; value: number }> = [
  { label: 'Every 10 seconds', value: 10_000 },
  { label: 'Every 20 seconds', value: 20_000 },
  { label: 'Every minute', value: 60_000 },
  { label: 'Only when pieces join', value: 0 },
];

const KEY = 'ojs:appearance';

function isTable(v: unknown): v is TableName {
  return typeof v === 'string' && v in TABLES;
}

function isEdges(v: unknown): v is EdgeStrength {
  return v === 'off' || v === 'subtle' || v === 'strong';
}

/**
 * Read the stored preferences, field by field.
 *
 * Deliberately not a blind `{...DEFAULT, ...parsed}`: this comes out of localStorage,
 * which is user-writable and survives across versions, so a stale or hand-edited value
 * would otherwise become an unrecognised table name and a black board with no explanation.
 */
export function loadAppearance(): Appearance {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_APPEARANCE };
    const parsed = JSON.parse(raw) as Partial<Appearance>;
    return {
      theme: parsed.theme === 'light' ? 'light' : 'dark',
      table: isTable(parsed.table) ? parsed.table : DEFAULT_APPEARANCE.table,
      edges: isEdges(parsed.edges) ? parsed.edges : DEFAULT_APPEARANCE.edges,
      autosaveMs:
        typeof parsed.autosaveMs === 'number' &&
        AUTOSAVE_CHOICES.some((c) => c.value === parsed.autosaveMs)
          ? parsed.autosaveMs
          : DEFAULT_APPEARANCE.autosaveMs,
    };
  } catch {
    return { ...DEFAULT_APPEARANCE };
  }
}

export function saveAppearance(appearance: Appearance): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(appearance));
  } catch {
    /* private browsing, or storage disabled -- the app still works, it just forgets */
  }
}

/** How long ago something happened, for a save readout. */
export function formatAgo(ms: number): string {
  const secs = Math.max(0, Math.round(ms / 1000));
  if (secs < 5) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  return mins < 60 ? `${mins} min ago` : `${Math.round(mins / 60)}h ago`;
}
