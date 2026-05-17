/**
 * Task P2.12 — tiny in-memory LRU with TTL.
 *
 * Used by `/api/optimize/portfolio` to cache MIP solves by
 * `(budgets, cohort_hash)` so repeated what-if presses don't re-spawn
 * Python. Per-process only (no Redis): on Vercel Fluid Compute warm
 * reuse, this gives a real hit rate for back-to-back identical solves;
 * cold starts pay the spawn cost once.
 *
 * Behavior:
 *   - capacity-bounded (oldest by last-access evicted)
 *   - TTL-bounded (entries expire after `ttlMs` regardless of access)
 *   - `get` is treated as a "touch" for recency
 *   - `set` overwrites in place and refreshes the timestamp
 *
 * We intentionally avoid an LRU library — the surface here is small,
 * the dep would not pull its weight, and the tests want to drive eviction
 * deterministically.
 */
export class TTLCache<V> {
  private store = new Map<string, { value: V; expiresAt: number }>();
  private now: () => number;

  constructor(
    private capacity: number,
    private ttlMs: number,
    now?: () => number,
  ) {
    if (capacity <= 0) throw new Error('capacity must be > 0');
    if (ttlMs <= 0) throw new Error('ttlMs must be > 0');
    this.now = now ?? (() => Date.now());
  }

  get(key: string): V | undefined {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= this.now()) {
      this.store.delete(key);
      return undefined;
    }
    // Touch for LRU recency by re-inserting at the tail of the iteration order.
    this.store.delete(key);
    this.store.set(key, hit);
    return hit.value;
  }

  set(key: string, value: V): void {
    if (this.store.has(key)) this.store.delete(key);
    this.store.set(key, { value, expiresAt: this.now() + this.ttlMs });
    // Evict by oldest insertion order.
    while (this.store.size > this.capacity) {
      const oldest = this.store.keys().next();
      if (oldest.done) break;
      this.store.delete(oldest.value);
    }
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  clear(): void {
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }
}
