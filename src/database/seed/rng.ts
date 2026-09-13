/**
 * Deterministic seeded PRNG (mulberry32) plus small helpers. Every relational/structural
 * choice the seed makes (which archetype an order gets, SKU categories, quantities, damage
 * flags, ...) is drawn from this so re-running the generator always produces the same shape
 * and distribution — only absolute timestamps move, because they are anchored to real
 * "now" by design (see resolveSimulationTime in ./time.ts). That is what "idempotent" means
 * for this seed: same structure and counts every run, not byte-identical clock values.
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Next float in [0, 1). */
  next(): number {
    this.state |= 0;
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  /** Float in [min, max), rounded to `decimals` places. */
  float(min: number, max: number, decimals = 2): number {
    const v = this.next() * (max - min) + min;
    const factor = 10 ** decimals;
    return Math.round(v * factor) / factor;
  }

  /** True with probability `p` (0-1). */
  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(arr: readonly T[]): T {
    return arr[this.int(0, arr.length - 1)] as T;
  }

  /** Weighted pick: entries are [value, weight]. Weights need not sum to 1. */
  weighted<T>(entries: ReadonlyArray<readonly [T, number]>): T {
    const total = entries.reduce((sum, [, w]) => sum + w, 0);
    let r = this.next() * total;
    for (const [value, w] of entries) {
      r -= w;
      if (r <= 0) return value;
    }
    return entries[entries.length - 1]![0];
  }

  shuffle<T>(arr: T[]): T[] {
    const copy = [...arr];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
    }
    return copy;
  }
}

/** Fixed seed so the same code always produces the same structural dataset. */
export const SEED = 20260904;
