import { describe, expect, it } from 'vitest';
import { GLYPHS } from '../glyphs.js';
import {
  challengeName,
  challengeUrl,
  decodeChallenge,
  encodeChallenge,
  type Challenge,
} from '../challenge.js';

const base: Challenge = {
  seed: 20260906,
  rows: 6,
  cols: 8,
  shapeSet: 'pentominoes',
  silhouette: 'diamond',
  targetCells: 5,
  flatEdges: true,
  rules: 'anyfit',
  rotate: true,
};

describe('challenge codes', () => {
  it('survives a round trip', () => {
    expect(decodeChallenge(encodeChallenge(base))).toEqual(base);
  });

  it('survives a round trip for every combination of settings', () => {
    const sets = ['mixed', 'tetrominoes', 'pentominoes'] as const;
    const shapes = ['rectangle', 'diamond', 'ellipse', 'cross', 'frame'] as const;
    for (const shapeSet of sets) {
      for (const silhouette of shapes) {
        for (const flatEdges of [true, false]) {
          for (const rules of ['match', 'anyfit'] as const) {
            for (const rotate of [true, false]) {
              for (const targetCells of [1, 3, 5]) {
                const challenge: Challenge = {
                  ...base,
                  shapeSet,
                  silhouette,
                  flatEdges,
                  rules,
                  rotate,
                  targetCells,
                };
                expect(decodeChallenge(encodeChallenge(challenge))).toEqual(challenge);
              }
            }
          }
        }
      }
    }
  });

  it('is short enough to write down', () => {
    // A teacher reading this off a whiteboard is the whole use case; twenty-four
    // characters is about the limit of what survives being copied by hand.
    expect(encodeChallenge(base).length).toBeLessThanOrEqual(24);
  });

  it('reads a code out of a pasted URL', () => {
    const url = challengeUrl('https://example.github.io/open-jigsaw-studio/', base);
    expect(decodeChallenge(url)).toEqual(base);
    expect(url).toContain('#');
  });

  it('ignores case and surrounding whitespace', () => {
    const code = encodeChallenge(base);
    expect(decodeChallenge(`  ${code.toUpperCase()}  `)).toEqual(base);
  });

  it('replaces an existing fragment rather than appending to it', () => {
    const url = challengeUrl('https://example.com/app#stale', base);
    expect(url.split('#').length).toBe(2);
    expect(decodeChallenge(url)).toEqual(base);
  });
});

describe('rejecting bad codes', () => {
  /**
   * The one that matters. A mistyped character would otherwise decode cleanly into a
   * *different* board, and one student would spend the lesson on a puzzle nobody else
   * can see -- wrong quietly, which is the failure mode this codebase keeps meeting.
   */
  it('rejects every single-character change to a valid code', () => {
    const code = encodeChallenge(base);
    const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let accepted = 0;
    let tried = 0;
    for (let i = 0; i < code.length; i++) {
      if (code[i] === '-' || code[i] === 'x') continue;
      for (const ch of alphabet) {
        if (ch === code[i]) continue;
        tried++;
        const typo = code.slice(0, i) + ch + code.slice(i + 1);
        if (decodeChallenge(typo) !== null) accepted++;
      }
    }
    expect(tried).toBeGreaterThan(200);
    // The checksum has 36 values, so a wrong code has a 1-in-36 chance of passing it by
    // luck. Anything much above that would mean the checksum is not doing its job.
    expect(accepted / tried).toBeLessThan(0.04);
  });

  it('rejects a transposition', () => {
    const code = encodeChallenge(base);
    const i = code.indexOf('-') + 1;
    const swapped = code.slice(0, i) + code[i + 1]! + code[i]! + code.slice(i + 2);
    if (code[i] !== code[i + 1]) expect(decodeChallenge(swapped)).toBeNull();
  });

  it.each([
    ['', 'empty'],
    ['nonsense', 'not a code'],
    ['2-abc-6x8-pd5fa-9', 'a future version'],
    ['1-abc-0x8-pd5fa-9', 'a zero dimension'],
    ['1-abc-600x8-pd5fa-9', 'an absurd dimension'],
    ['1-abc-6x8-zz5fa-9', 'an unknown shape set'],
    ['1-abc-6x8-pd9fa-9', 'a size outside the dial'],
    ['1-abc-6x8-pd5xa-9', 'an unknown edge style'],
    ['1--6x8-pd5fa-9', 'a missing seed'],
  ])('rejects %s (%s)', (code) => {
    expect(decodeChallenge(code)).toBeNull();
  });
});

describe('challengeName', () => {
  it('names a board in words a person can say out loud', () => {
    expect(challengeName(base, 12)).toBe('Diamond of 12');
    expect(challengeName({ ...base, silhouette: 'rectangle' }, 20)).toBe(
      'Pentomino board of 20',
    );
  });

  it('gives the same name to the same code for everyone', () => {
    const decoded = decodeChallenge(encodeChallenge(base))!;
    expect(challengeName(decoded, 12)).toBe(challengeName(base, 12));
  });
});

describe('glyph outlines in codes', () => {
  const glyphOf = (name: string): Challenge => ({ ...base, silhouette: `glyph:${name}` });

  it('round-trips every glyph', () => {
    for (const name of Object.keys(GLYPHS)) {
      const challenge = glyphOf(name);
      expect(decodeChallenge(encodeChallenge(challenge))).toEqual(challenge);
    }
  });

  it('stays short enough to write down', () => {
    const longest = Object.keys(GLYPHS)
      .map((n) => encodeChallenge(glyphOf(n)).length)
      .reduce((a, b) => Math.max(a, b));
    expect(longest).toBeLessThanOrEqual(32);
  });

  /**
   * Codes are the one thing here that other people already hold — somebody has written
   * one on a whiteboard. Adding the glyph field must not change how a code without one
   * parses, so this pins an exact string rather than a round trip.
   */
  it('leaves codes issued before glyphs existed untouched', () => {
    expect(encodeChallenge({ ...base, silhouette: 'diamond' })).toBe('1-c29ey-6x8-pd5far-g');
    expect(decodeChallenge('1-c29ey-6x8-pd5far-g')?.silhouette).toBe('diamond');
  });

  it('rejects a glyph flag with no name, and a name with no flag', () => {
    const code = encodeChallenge(glyphOf('5'));
    const withoutName = code.split('-').filter((_, i) => i !== 4).join('-');
    expect(decodeChallenge(withoutName)).toBeNull();

    const plain = encodeChallenge({ ...base, silhouette: 'diamond' }).split('-');
    plain.splice(4, 0, '5');
    expect(decodeChallenge(plain.join('-'))).toBeNull();
  });

  it('rejects a glyph that does not exist', () => {
    const parts = encodeChallenge(glyphOf('5')).split('-');
    parts[4] = 'wombat';
    // Recomputed checksum, so this is a *valid-looking* code naming a missing glyph --
    // the case that would otherwise sail through and produce an empty board.
    const payload = parts.slice(0, -1).join('-');
    let total = 0;
    for (let i = 0; i < payload.length; i++) total += payload.charCodeAt(i) * (i + 1);
    expect(decodeChallenge(`${payload}-${(total % 36).toString(36)}`)).toBeNull();
  });

  it('names a glyph board in words a teacher can say', () => {
    expect(challengeName(glyphOf('5'), 9)).toBe('“5” in 9 pieces');
    expect(challengeName(glyphOf('triangle'), 6)).toBe('Triangle in 6 pieces');
  });
});
