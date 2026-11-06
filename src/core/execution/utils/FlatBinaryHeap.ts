import { TileRef } from "../../game/GameMap";

/**
 * Lightweight min-heap specialised for (tier:number, priority:number,
 * tile:TileRef) triples.
 * - priorities stored in a contiguous Float32Array
 * - tiers stored in a parallel Uint16Array
 * - tiles stored in a parallel object array
 *
 * Ordering is lexicographic: lower tier first, then lower priority. A tier
 * defaults to 0, so callers that do not use tiers keep the original
 * priority-only ordering exactly.
 */
export class FlatBinaryHeap {
  /** parallel arrays: pri[ i ] is the priority of tiles[ i ] */
  private pri: Float32Array;
  private tier: Uint16Array;
  private tiles: TileRef[];
  private len = 0; // current number of elements

  constructor(capacity = 1024) {
    this.pri = new Float32Array(capacity);
    this.tier = new Uint16Array(capacity);
    this.tiles = new Array<TileRef>(capacity);
  }

  /** remove every element without reallocating */
  clear(): void {
    this.len = 0;
  }

  /** current heap size */
  size(): number {
    return this.len;
  }

  /** true when slot `a` must be dequeued before slot `b` */
  private lessSlot(a: number, b: number): boolean {
    return (
      this.tier[a] < this.tier[b] ||
      (this.tier[a] === this.tier[b] && this.pri[a] < this.pri[b])
    );
  }

  //insert tiles
  enqueue(tile: TileRef, priority: number, tier: number = 0): void {
    if (this.len === this.pri.length) this.grow(); // ensure space
    let i = this.len++;

    /* sift-up */
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (
        tier > this.tier[parent] ||
        (tier === this.tier[parent] && priority >= this.pri[parent])
      ) {
        break;
      }
      this.pri[i] = this.pri[parent];
      this.tier[i] = this.tier[parent];
      this.tiles[i] = this.tiles[parent];
      i = parent;
    }
    this.pri[i] = priority;
    this.tier[i] = tier;
    this.tiles[i] = tile;
  }

  /** remove and return the lowest-(tier, priority) tile (no per-call allocation) */
  dequeue(): TileRef {
    if (this.len === 0) throw new Error("heap empty");

    const topTile = this.tiles[0];

    this.len--;
    if (this.len > 0) {
      this.pri[0] = this.pri[this.len];
      this.tier[0] = this.tier[this.len];
      this.tiles[0] = this.tiles[this.len];
      this.siftDown(0);
    }
    return topTile;
  }

  /**
   * Recompute the tier of every slot and rebuild the heap in O(H).
   *
   * Used when the defender's defense-post coverage changes: existing frontier
   * entries keep their tile/priority but may now belong to a different tier.
   */
  retier(tierForTile: (tile: TileRef) => number): void {
    for (let i = 0; i < this.len; i++) {
      this.tier[i] = tierForTile(this.tiles[i]);
    }
    // Linear bottom-up heapify.
    for (let i = (this.len >> 1) - 1; i >= 0; i--) {
      this.siftDown(i);
    }
  }

  /** sift the element at `start` down to its ordered position */
  private siftDown(start: number): void {
    const priority = this.pri[start];
    const tier = this.tier[start];
    const tile = this.tiles[start];
    let i = start;
    while (true) {
      const left = (i << 1) + 1;
      if (left >= this.len) break;
      const right = left + 1;
      const child =
        right < this.len && this.lessSlot(right, left) ? right : left;
      if (
        tier < this.tier[child] ||
        (tier === this.tier[child] && priority <= this.pri[child])
      ) {
        break;
      }
      this.pri[i] = this.pri[child];
      this.tier[i] = this.tier[child];
      this.tiles[i] = this.tiles[child];
      i = child;
    }
    this.pri[i] = priority;
    this.tier[i] = tier;
    this.tiles[i] = tile;
  }

  /** double the underlying storage */
  private grow(): void {
    const newCap = this.pri.length << 1;

    const newPri = new Float32Array(newCap);
    newPri.set(this.pri);
    this.pri = newPri;

    const newTier = new Uint16Array(newCap);
    newTier.set(this.tier);
    this.tier = newTier;

    this.tiles.length = newCap;
  }

  /**
   * B2: raw snapshot of the live heap slots. The array layout is preserved
   * (rather than re-enqueueing) so equal-priority tie-breaking and hence
   * dequeue order are identical after a restore.
   *
   * Non-zero tiers are stored sparsely as `[heapSlot, tier]` pairs, so an
   * undefended frontier costs no extra checkpoint bytes and missing `tiers`
   * restore as 0.
   */
  snapshot(): {
    priorities: number[];
    tiles: TileRef[];
    tiers?: [number, number][];
  } {
    const snapshot: {
      priorities: number[];
      tiles: TileRef[];
      tiers?: [number, number][];
    } = {
      priorities: Array.from(this.pri.subarray(0, this.len)),
      tiles: this.tiles.slice(0, this.len),
    };
    const tiers: [number, number][] = [];
    for (let i = 0; i < this.len; i++) {
      if (this.tier[i] !== 0) tiers.push([i, this.tier[i]]);
    }
    if (tiers.length > 0) snapshot.tiers = tiers;
    return snapshot;
  }

  /** B2: overwrite the heap from a snapshot() taken by the same build. */
  restore(snapshot: {
    priorities: number[];
    tiles: TileRef[];
    tiers?: [number, number][];
  }): void {
    const len = snapshot.tiles.length;
    if (this.pri.length < len) {
      this.pri = new Float32Array(len);
      this.tier = new Uint16Array(len);
      this.tiles.length = len;
    }
    for (let i = 0; i < len; i++) {
      this.pri[i] = snapshot.priorities[i];
      this.tier[i] = 0;
      this.tiles[i] = snapshot.tiles[i];
    }
    for (const [slot, tier] of snapshot.tiers ?? []) {
      if (slot >= 0 && slot < len) this.tier[slot] = tier;
    }
    this.len = len;
  }
}
