import type { GameCheckpoint } from "../../core/Checkpoint";
import type { SavedLobbySeat } from "../../core/Schemas";

/**
 * ClientIDs that were still alive in a host checkpoint. A human is dead once
 * the simulation stamped `deathPosition` in the stats record; players without
 * stats have simply not done anything yet and are alive. Bots/nations have a
 * null clientID and are skipped (they can never rejoin).
 */
export function aliveClientIdsFromCheckpoint(
  checkpoint: GameCheckpoint,
): string[] {
  const alive = new Set<string>();
  for (const player of checkpoint.players) {
    const clientID = player.playerInfo.clientID;
    if (clientID === null || clientID === undefined) continue;
    if (checkpoint.stats?.[clientID]?.deathPosition !== undefined) continue;
    alive.add(clientID);
  }
  return [...alive].sort();
}

/**
 * Which saved seats must be reclaimed for a resumed ranked game to stay rated.
 * Prefers the checkpoint's alive set. Saves written before that field existed
 * (or saves without a checkpoint) fall back to every non-spectator seat, which
 * is the stricter rule: a reduced field must never rate.
 */
export function rankedResumeRequiredSeats(
  seats: readonly SavedLobbySeat[],
  aliveClientIDs: readonly string[] | undefined,
): string[] {
  const alive =
    aliveClientIDs === undefined ? undefined : new Set(aliveClientIDs);
  return seats
    .filter(
      (seat) =>
        seat.spectator !== true &&
        (alive === undefined || alive.has(seat.clientID)),
    )
    .map((seat) => seat.clientID);
}
