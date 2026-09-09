/**
 * Watching someone use the app, when you cannot be in the room.
 *
 * Every fault found in this project so far has been found the same way: someone played
 * it and something did not work. The hints that were drawn at two and a half pixels, the
 * name field that opened behind the footer, the group that turned out to be a tray — all
 * of them passed the whole test suite, because the suite asks whether the code does what
 * it was told and never whether a person can find it. Two hundred and forty-eight tests
 * have not caught one of these.
 *
 * So this records the things a suite structurally cannot see, from a real session:
 *
 * **Stalls.** A stretch where the player is clearly working — pointer events, drags —
 * and nothing joins, fits or moves into place. That is the shape of being stuck, and it
 * is invisible from the outside.
 *
 * **Hunting.** A menu opened and closed without a choice, a panel opened and closed
 * without an action. Somebody looking for something that is not there, or is not called
 * what they expected.
 *
 * **Asking.** Every control queried in help mode, which is a direct list of what was not
 * self-explanatory.
 *
 * Three rules, and they are not negotiable.
 *
 * **Off unless deliberately switched on.** No default-on telemetry, no "improve the
 * product" framing, no exceptions.
 *
 * **It never leaves the device by itself.** There is no endpoint, no fetch, no
 * background anything. The log is written to a file the tester hands over — or does not.
 *
 * **It records the app, not the person.** Control names, timings, counts. No picture, no
 * puzzle content, no title, no filename, no text typed anywhere. What goes in the file is
 * exactly what someone would be comfortable reading over the tester's shoulder, because
 * that is what will happen.
 */

export interface PlaytestEvent {
  /** Milliseconds since the recording started. */
  readonly at: number;
  readonly kind: 'start' | 'press' | 'menu' | 'asked' | 'stall' | 'progress' | 'done' | 'note';
  /** A control name or short label. Never user text. */
  readonly what: string;
  readonly detail?: string;
}

const KEY = 'ojs:playtest';
const MAX_EVENTS = 4000;

/**
 * How long without progress counts as being stuck.
 *
 * Twenty seconds of *active* trying, not twenty seconds of anything. Sitting looking at
 * a puzzle is playing it; twenty seconds of dragging pieces that never land is not.
 */
const STALL_MS = 20_000;

export class Playtest {
  private events: PlaytestEvent[] = [];
  private started = 0;
  private lastProgressAt = 0;
  private activeSince = 0;
  private stallReported = false;
  private on = false;

  constructor() {
    this.on = this.readFlag();
    if (this.on) this.restore();
  }

  get recording(): boolean {
    return this.on;
  }

  get count(): number {
    return this.events.length;
  }

  private readFlag(): boolean {
    try {
      return localStorage.getItem(`${KEY}:on`) === '1';
    } catch {
      return false;
    }
  }

  /**
   * Turning it on starts a fresh log; turning it off keeps what was recorded.
   *
   * Deliberately asymmetric. Restarting on a new session is what makes each recording
   * one sitting rather than an accumulating pile, and discarding the log on the way out
   * would throw away the very thing the tester is about to hand over — most likely by
   * pressing the wrong button of two that sit next to each other.
   */
  setRecording(on: boolean): void {
    this.on = on;
    try {
      localStorage.setItem(`${KEY}:on`, on ? '1' : '0');
    } catch {
      /* storage disabled; recording still works for this session */
    }
    if (on) {
      this.events = [];
      this.started = Date.now();
      this.lastProgressAt = this.started;
      this.activeSince = 0;
      this.stallReported = false;
      this.add('start', 'recording started', new Date().toISOString().slice(0, 16));
      this.persist();
    }
  }

  add(kind: PlaytestEvent['kind'], what: string, detail?: string): void {
    if (!this.on) return;
    if (this.events.length >= MAX_EVENTS) return;
    const event: PlaytestEvent = {
      at: Date.now() - this.started,
      kind,
      what,
      ...(detail === undefined ? {} : { detail }),
    };
    this.events.push(event);
    this.persist();
  }

  /**
   * Called on every pointer interaction, whether or not anything came of it.
   *
   * The stall is reported once per episode rather than every frame, and the clock is
   * reset by progress rather than by activity: the question being asked is "how long has
   * this person been trying without getting anywhere", and resetting on activity would
   * answer the opposite question.
   */
  sawActivity(): void {
    if (!this.on) return;
    const now = Date.now();
    if (this.activeSince === 0) this.activeSince = now;
    if (!this.stallReported && now - this.lastProgressAt > STALL_MS) {
      this.stallReported = true;
      this.add('stall', 'working with nothing landing', `${Math.round((now - this.lastProgressAt) / 1000)}s`);
    }
  }

  /** Called whenever a piece joins, fits or is put away — anything that is getting on. */
  sawProgress(what: string, detail?: string): void {
    if (!this.on) return;
    this.lastProgressAt = Date.now();
    this.stallReported = false;
    this.activeSince = 0;
    this.add('progress', what, detail);
  }

  private persist(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify({ started: this.started, events: this.events }));
    } catch {
      /* a full or disabled store loses the log on reload, and nothing else */
    }
  }

  private restore(): void {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) {
        this.started = Date.now();
        this.lastProgressAt = this.started;
        return;
      }
      const parsed = JSON.parse(raw) as { started?: number; events?: PlaytestEvent[] };
      this.started = typeof parsed.started === 'number' ? parsed.started : Date.now();
      this.events = Array.isArray(parsed.events) ? parsed.events.slice(0, MAX_EVENTS) : [];
      this.lastProgressAt = Date.now();
    } catch {
      this.started = Date.now();
      this.lastProgressAt = this.started;
    }
  }

  /**
   * The log as text.
   *
   * Plain text rather than JSON on purpose: the person handing this over should be able
   * to read every line of it first and decide whether they are happy to. A format they
   * cannot read is a format they have to take on trust, and nobody should have to.
   */
  report(): string {
    const mmss = (ms: number): string => {
      const s = Math.round(ms / 1000);
      return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    };
    const lines = this.events.map(
      (e) => `${mmss(e.at)}  ${e.kind.padEnd(8)} ${e.what}${e.detail ? ` — ${e.detail}` : ''}`,
    );

    const stalls = this.events.filter((e) => e.kind === 'stall').length;
    const asked = this.events.filter((e) => e.kind === 'asked').map((e) => e.what);
    const hunted = this.events.filter((e) => e.kind === 'menu').map((e) => e.what);
    const summary = [
      'Open Jigsaw Studio — playtest log',
      `Length: ${mmss(this.events.at(-1)?.at ?? 0)}`,
      `Times stuck (20s of trying with nothing landing): ${stalls}`,
      `Controls asked about in help mode: ${asked.length ? [...new Set(asked)].join(', ') : 'none'}`,
      `Opened and closed without choosing: ${hunted.length ? [...new Set(hunted)].join(', ') : 'none'}`,
      '',
      'This file contains control names and timings only — no picture, no puzzle, no typing.',
      '',
    ];
    return [...summary, ...lines].join('\n');
  }

  clear(): void {
    this.events = [];
    this.started = Date.now();
    this.lastProgressAt = this.started;
    this.persist();
  }
}
