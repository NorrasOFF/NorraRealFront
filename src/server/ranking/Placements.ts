// Finishing places for one ranked lobby. The core simulation already records
// everything needed: `deathPosition` is stamped when a player is eliminated
// (non-bot players still standing + 1), and `finalTiles` is snapshotted for
// every player at setWinner. This module turns those facts into dense places
// 1..N for the accounts that are actually rated, so a nation or bot in the
// lobby cannot shift everyone's award.

export interface RankedPlacement {
  publicId: string;
  place: number;
  // Number of distinct rated teammates sharing this place (1 in FFA). The
  // rating step divides the place award by this, so a team win pays each
  // member less and the per-player value falls as the team grows.
  teamSize: number;
}

export interface RankedPlacementParticipant {
  publicId: string;
  // Links the account to this game's per-player stats.
  clientID: string;
  // Server-pinned team slot; absent in ordinary (non-matchmade) lobbies.
  teamIndex?: number;
}

// The subset of PlayerStats this module reads. `finalTiles` is a bigint from
// BigIntStringSchema, but archived/older stats may carry a number/string.
export interface RankedPlacementStats {
  deathPosition?: number | null;
  finalTiles?: bigint | number | string | null;
}

interface PlacementRow {
  participant: RankedPlacementParticipant;
  isWinner: boolean;
  hasStats: boolean;
  alive: boolean;
  deathPosition: number;
  finalTiles: bigint;
}

function toBigInt(value: RankedPlacementStats["finalTiles"]): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    return Number.isFinite(value) ? BigInt(Math.trunc(value)) : 0n;
  }
  if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
  return 0n;
}

// Order: winners first, then players who were still standing (more tiles
// first), then eliminated players in elimination order, then anyone whose
// stats are missing (nobody can be ranked from them). The publicId tie-break
// keeps the result deterministic when two players share a key.
function compareRows(a: PlacementRow, b: PlacementRow): number {
  if (a.isWinner !== b.isWinner) return a.isWinner ? -1 : 1;
  if (a.hasStats !== b.hasStats) return a.hasStats ? -1 : 1;
  if (a.alive !== b.alive) return a.alive ? -1 : 1;
  if (a.alive) {
    if (a.finalTiles !== b.finalTiles) {
      return a.finalTiles > b.finalTiles ? -1 : 1;
    }
  } else if (a.deathPosition !== b.deathPosition) {
    return a.deathPosition - b.deathPosition;
  }
  return a.participant.publicId < b.participant.publicId
    ? -1
    : a.participant.publicId > b.participant.publicId
      ? 1
      : 0;
}

/**
 * Dense places 1..N for the distinct accounts in a finished ranked lobby.
 * Duplicate accounts (the same player joined twice) are collapsed to one
 * entry. Teammates share the best place reached by any member of the team, so
 * a winning 2v2 team both finish 1st instead of 1st and 2nd.
 */
export function computeRankedPlacements(
  participants: readonly RankedPlacementParticipant[],
  statsByClient: Readonly<
    Record<string, RankedPlacementStats | null | undefined>
  >,
  winnerPublicIds: readonly string[],
): RankedPlacement[] {
  const winners = new Set(winnerPublicIds);
  const seen = new Set<string>();
  const rows: PlacementRow[] = [];
  for (const participant of participants) {
    if (participant.publicId.length === 0) continue;
    if (seen.has(participant.publicId)) continue;
    seen.add(participant.publicId);

    const stats = statsByClient[participant.clientID];
    const deathPosition =
      typeof stats?.deathPosition === "number" &&
      Number.isFinite(stats.deathPosition)
        ? stats.deathPosition
        : Number.POSITIVE_INFINITY;
    const hasStats =
      stats !== null &&
      stats !== undefined &&
      (stats.deathPosition !== null && stats.deathPosition !== undefined
        ? true
        : stats.finalTiles !== null && stats.finalTiles !== undefined);

    rows.push({
      participant,
      isWinner: winners.has(participant.publicId),
      hasStats,
      alive: hasStats && !Number.isFinite(deathPosition),
      deathPosition,
      finalTiles: toBigInt(stats?.finalTiles),
    });
  }

  rows.sort(compareRows);

  const placeByPublicId = new Map<string, number>();
  rows.forEach((row, index) =>
    placeByPublicId.set(row.participant.publicId, index + 1),
  );

  // Teammates share the best place anyone on the team reached. In FFA lobbies
  // teamIndex is absent, so this is a no-op.
  const bestTeamPlace = new Map<number, number>();
  const teamSize = new Map<number, number>();
  for (const row of rows) {
    const teamIndex = row.participant.teamIndex;
    if (teamIndex === undefined) continue;
    teamSize.set(teamIndex, (teamSize.get(teamIndex) ?? 0) + 1);
    const place = placeByPublicId.get(row.participant.publicId)!;
    const best = bestTeamPlace.get(teamIndex);
    if (best === undefined || place < best) {
      bestTeamPlace.set(teamIndex, place);
    }
  }
  for (const row of rows) {
    const teamIndex = row.participant.teamIndex;
    if (teamIndex === undefined) continue;
    placeByPublicId.set(
      row.participant.publicId,
      bestTeamPlace.get(teamIndex)!,
    );
  }

  return rows
    .map((row) => ({
      publicId: row.participant.publicId,
      place: placeByPublicId.get(row.participant.publicId)!,
      teamSize:
        row.participant.teamIndex === undefined
          ? 1
          : (teamSize.get(row.participant.teamIndex) ?? 1),
    }))
    .sort((a, b) =>
      a.place !== b.place
        ? a.place - b.place
        : a.publicId < b.publicId
          ? -1
          : a.publicId > b.publicId
            ? 1
            : 0,
    );
}
