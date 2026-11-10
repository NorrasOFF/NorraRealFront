import { describe, expect, it } from "vitest";
import { ClusterWorkerIds } from "../../src/server/ClusterWorkerIds";

// Regression: the cluster "exit" handler used to read WORKER_ID out of
// `worker.process.env`, but `worker.process` is null by then, so the master
// logged "worker crashed could not find id" and never restarted the shard.
// Every /wN request then answered 502 until the machine was restarted.
describe("ClusterWorkerIds", () => {
  it("remembers a forked worker's logical id until it exits", () => {
    const ids = new ClusterWorkerIds();
    ids.set(7, 2);
    expect(ids.has(7)).toBe(true);
    expect(ids.take(7)).toBe(2);
    // An exit is consumed once, so a duplicate exit cannot restart the shard
    // twice.
    expect(ids.take(7)).toBeUndefined();
    expect(ids.has(7)).toBe(false);
  });

  it("keeps logical ids for live workers only", () => {
    const ids = new ClusterWorkerIds();
    ids.set(1, 0);
    ids.set(2, 1);
    ids.set(3, 2);
    ids.take(2);
    expect(ids.logicalIds().sort()).toEqual([0, 2]);
    expect(ids.size).toBe(2);
  });

  it("can hand the same logical id to a replacement cluster worker", () => {
    const ids = new ClusterWorkerIds();
    ids.set(1, 0);
    expect(ids.take(1)).toBe(0);
    // Restarted shard gets a new cluster id but the same logical WORKER_ID.
    ids.set(2, 0);
    expect(ids.take(2)).toBe(0);
  });
});
