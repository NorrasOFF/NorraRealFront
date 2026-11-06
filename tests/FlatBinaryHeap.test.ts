import { FlatBinaryHeap } from "../src/core/execution/utils/FlatBinaryHeap";

describe("FlatBinaryHeap", () => {
  test("dequeues tiles in ascending priority order", () => {
    const heap = new FlatBinaryHeap();
    const entries: [number, number][] = [
      [100, 5.0],
      [200, 1.0],
      [300, 3.0],
      [400, 2.0],
      [500, 4.0],
    ];
    for (const [tile, pri] of entries) {
      heap.enqueue(tile, pri);
    }
    expect(heap.size()).toBe(5);
    expect(heap.dequeue()).toBe(200);
    expect(heap.dequeue()).toBe(400);
    expect(heap.dequeue()).toBe(300);
    expect(heap.dequeue()).toBe(500);
    expect(heap.dequeue()).toBe(100);
    expect(heap.size()).toBe(0);
  });

  test("throws when dequeuing an empty heap", () => {
    const heap = new FlatBinaryHeap();
    expect(() => heap.dequeue()).toThrow("heap empty");
  });

  test("clear empties the heap without breaking subsequent use", () => {
    const heap = new FlatBinaryHeap();
    heap.enqueue(1, 1);
    heap.enqueue(2, 2);
    heap.clear();
    expect(heap.size()).toBe(0);
    heap.enqueue(3, 3);
    expect(heap.dequeue()).toBe(3);
  });

  test("grows past its initial capacity and stays ordered", () => {
    const heap = new FlatBinaryHeap(4);
    // Insert in descending priority so every enqueue sifts up.
    const n = 1000;
    for (let i = 0; i < n; i++) {
      heap.enqueue(i, n - i);
    }
    expect(heap.size()).toBe(n);
    for (let i = 0; i < n; i++) {
      expect(heap.dequeue()).toBe(n - 1 - i);
    }
  });

  describe("defense tiers", () => {
    test("lower tiers dequeue first even with worse priorities", () => {
      const heap = new FlatBinaryHeap();
      heap.enqueue(1, 100, 2);
      heap.enqueue(2, 50, 1);
      heap.enqueue(3, 1, 0);
      expect(heap.dequeue()).toBe(3);
      expect(heap.dequeue()).toBe(2);
      expect(heap.dequeue()).toBe(1);
    });

    test("within a tier the priority order is unchanged", () => {
      const heap = new FlatBinaryHeap();
      heap.enqueue(1, 30, 1);
      heap.enqueue(2, 10, 1);
      heap.enqueue(3, 20, 1);
      heap.enqueue(4, 5, 0);
      expect(heap.dequeue()).toBe(4);
      expect(heap.dequeue()).toBe(2);
      expect(heap.dequeue()).toBe(3);
      expect(heap.dequeue()).toBe(1);
    });

    test("retier reorders entries, preserving their priorities and tiles", () => {
      const heap = new FlatBinaryHeap();
      heap.enqueue(1, 5, 0);
      heap.enqueue(2, 10, 0);
      heap.enqueue(3, 15, 0);

      // Tile 1 becomes heavily defended; the others stay undefended.
      heap.retier((tile) => (tile === 1 ? 2 : 0));

      expect(heap.size()).toBe(3);
      expect(heap.dequeue()).toBe(2);
      expect(heap.dequeue()).toBe(3);
      expect(heap.dequeue()).toBe(1);
    });

    test("retier is a no-op when every tier stays the same", () => {
      const heap = new FlatBinaryHeap();
      heap.enqueue(1, 20, 1);
      heap.enqueue(2, 10, 0);
      heap.enqueue(3, 30, 1);
      heap.retier(() => 0);
      expect(heap.dequeue()).toBe(2);
      expect(heap.dequeue()).toBe(1);
      expect(heap.dequeue()).toBe(3);
    });

    test("snapshot/restore keeps sparse tiers and order", () => {
      const heap = new FlatBinaryHeap();
      heap.enqueue(1, 5, 2);
      heap.enqueue(2, 10, 0);
      heap.enqueue(3, 15, 1);
      heap.enqueue(4, 20, 0);

      const snapshot = heap.snapshot();
      // Only non-zero tiers are stored, as [heapSlot, tier].
      expect(snapshot.tiers).toBeDefined();
      expect(snapshot.tiers!.length).toBe(2);
      expect(snapshot.tiers!.every(([, tier]) => tier !== 0)).toBe(true);

      const restored = new FlatBinaryHeap();
      restored.restore(snapshot);
      expect(restored.size()).toBe(4);
      expect(restored.dequeue()).toBe(2);
      expect(restored.dequeue()).toBe(4);
      expect(restored.dequeue()).toBe(3);
      expect(restored.dequeue()).toBe(1);
    });

    test("missing tiers restore as 0 (priority-only ordering)", () => {
      const source = new FlatBinaryHeap();
      source.enqueue(10, 5);
      source.enqueue(20, 1);
      source.enqueue(30, 3);
      const snapshot = source.snapshot();
      const { priorities, tiles } = snapshot;

      const restored = new FlatBinaryHeap();
      restored.restore({ priorities, tiles });
      expect(restored.dequeue()).toBe(20);
      expect(restored.dequeue()).toBe(30);
      expect(restored.dequeue()).toBe(10);
    });

    test("snapshot omits tiers when every entry is undefended", () => {
      const heap = new FlatBinaryHeap();
      heap.enqueue(1, 3);
      heap.enqueue(2, 1);
      const snapshot = heap.snapshot();
      expect(snapshot.tiers).toBeUndefined();
    });
  });
});
