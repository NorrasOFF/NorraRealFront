/**
 * Maps Node's cluster worker id to the logical `WORKER_ID` that
 * `ServerEnv.workerIndex`/`workerPath` use for shard routing.
 *
 * The cluster `exit` event hands back a `Worker`, but `worker.process` is null
 * once the worker has exited, so `WORKER_ID` cannot be read from
 * `worker.process.env` at that point. Doing so made the exit handler bail out
 * with "worker crashed could not find id", leaving the dead worker registered
 * forever: the master then re-killed it on every lobby broadcast (twice a
 * second) and every `/wN` request 502'd until the machine was restarted by
 * hand. Record the id when the worker is forked instead.
 */
export class ClusterWorkerIds {
  private readonly byClusterId = new Map<number, number>();

  /** Remember which logical worker a forked cluster worker serves. */
  set(clusterWorkerId: number, logicalWorkerId: number): void {
    this.byClusterId.set(clusterWorkerId, logicalWorkerId);
  }

  /**
   * Resolve (and forget) a cluster worker's logical id. Returns undefined when
   * the worker was never registered, e.g. an exit raced the fork bookkeeping.
   */
  take(clusterWorkerId: number): number | undefined {
    const logicalWorkerId = this.byClusterId.get(clusterWorkerId);
    this.byClusterId.delete(clusterWorkerId);
    return logicalWorkerId;
  }

  has(clusterWorkerId: number): boolean {
    return this.byClusterId.has(clusterWorkerId);
  }

  /** Logical ids of every worker currently recorded as forked. */
  logicalIds(): number[] {
    return [...this.byClusterId.values()];
  }

  get size(): number {
    return this.byClusterId.size;
  }
}
