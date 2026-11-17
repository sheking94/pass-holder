// Hybrid logical clock: timestamps ordered by (ms, c, d) that keep growing
// even when the wall clock goes backwards.

/** Short field names, because they are stored in every entry (the JSON keys are part of the format). */
export interface Hlc {
  /** Wall clock in milliseconds, never lower than the last timestamp this device saw. */
  ms: number;
  /** Counter that orders events within the same ms. */
  c: number;
  /** Device id: breaks the remaining ties, so two devices never produce equal timestamps. */
  d: string;
}

export const MAX_DEVICE_ID_LENGTH = 64;

export function compareHlc(a: Hlc, b: Hlc): -1 | 0 | 1 {
  if (a.ms !== b.ms) return a.ms < b.ms ? -1 : 1;
  if (a.c !== b.c) return a.c < b.c ? -1 : 1;
  // UTF-16 code unit order, same as Kotlin's String.compareTo.
  if (a.d !== b.d) return a.d < b.d ? -1 : 1;
  return 0;
}

export function parseHlc(value: unknown): Hlc {
  if (typeof value !== "object" || value === null) throw new Error("Invalid HLC");
  const { ms, c, d } = value as Record<string, unknown>;
  if (
    typeof ms !== "number" ||
    !Number.isSafeInteger(ms) ||
    ms < 0 ||
    typeof c !== "number" ||
    !Number.isSafeInteger(c) ||
    c < 0 ||
    typeof d !== "string" ||
    d.length === 0 ||
    d.length > MAX_DEVICE_ID_LENGTH
  )
    throw new Error("Invalid HLC");
  return { ms, c, d };
}

export class HlcClock {
  #last: Hlc | undefined;
  readonly #deviceId: string;
  readonly #now: () => number;

  constructor(deviceId: string, now: () => number = Date.now, last?: Hlc) {
    this.#deviceId = deviceId;
    this.#now = now;
    this.#last = last && { ...last };
  }

  get last(): Hlc | undefined {
    return this.#last && { ...this.#last };
  }

  /** An independent copy with the same state, to try out a tick without moving this clock. */
  clone(): HlcClock {
    return new HlcClock(this.#deviceId, this.#now, this.#last);
  }

  tick(): Hlc {
    const last = this.#last;
    const wall = this.#now();
    const ms = last ? Math.max(last.ms, wall) : wall;
    const c = last && ms === last.ms ? last.c + 1 : 0;
    this.#last = { ms, c, d: this.#deviceId };
    return { ...this.#last };
  }

  // Remember a remote clock that runs ahead, without ticking.
  observe(remote: Hlc): void {
    const last = this.#last;
    if (!last || remote.ms > last.ms || (remote.ms === last.ms && remote.c > last.c)) {
      this.#last = { ms: remote.ms, c: remote.c, d: this.#deviceId };
    }
  }
}
