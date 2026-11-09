// Points-based team split for ranked lobbies.
//
// A listed private lobby is a ranked lobby (see GameServer.isRanked). Its host
// does not pick teams: the server stamps a team slot on every player at start
// (the same `teamIndex` pin the matchmaker uses). This module picks those slots
// from the players' ranked ladder points so the sums of the teams end up as
// close together as possible.
//
// The objective is the spread of the team point sums: first minimize
// `max(sum) - min(sum)` ("difference in points between teams"), then minimize
// the sum of squared deviations from the mean. Team sizes stay balanced
// (every team gets floor(n/teams) or ceil(n/teams) players), because a team
// with a free extra slot is a different game, not a fairer one.
//
// Two solvers:
//  - `exactSplit` is a branch-and-bound search over all equal-size splits for
//    small lobbies (<= EXACT_LIMIT players). It returns the true optimum.
//  - `greedySplit` + `localSearch` is the deterministic fallback for big
//    lobbies: fill the emptiest/lightest team, then repeatedly apply the
//    best-improving swap or move until no change improves the objective.
//
// Everything here is pure and deterministic: ties are broken by sorted input
// order, then by team index, so the server and any audit of a start message
// agree.

export interface TeamBalanceEntry {
  clientID: string;
  points: number;
}

export interface BalancedTeams {
  // clientID -> zero-based team slot.
  pins: Map<string, number>;
  // Σ points per team slot; the same order as the slots in `pins`.
  teamSums: number[];
  // Largest minus smallest team sum (the value the split minimizes).
  spread: number;
}

// Above this roster size the exact search is skipped. 16 covers every normal
// ranked lobby; larger ones use the greedy + local-search split, which is
// deterministic and typically optimal for 2 teams.
export const EXACT_SPLIT_LIMIT = 16;
// Safety valve for pathological point distributions; the best split found so
// far is kept when the search hits it.
const MAX_EXACT_NODES = 400_000;
const MAX_LOCAL_SEARCH_PASSES = 100;

interface SplitScore {
  spread: number;
  variance: number;
}

interface SplitState {
  assign: number[];
  sums: number[];
  counts: number[];
}

function score(sums: readonly number[], total: number): SplitScore {
  let min = Infinity;
  let max = -Infinity;
  let variance = 0;
  const mean = total / sums.length;
  for (const sum of sums) {
    if (sum < min) min = sum;
    if (sum > max) max = sum;
    const delta = sum - mean;
    variance += delta * delta;
  }
  return { spread: max - min, variance };
}

function isBetter(candidate: SplitScore, best: SplitScore): boolean {
  if (candidate.spread !== best.spread) return candidate.spread < best.spread;
  return candidate.variance < best.variance - 1e-9;
}

// Fill the teams round-robin, always picking the team with the fewest players
// (so sizes stay balanced) and then the lowest point sum. Deterministic and
// already close to optimal for equal-size teams.
function greedySplit(
  points: readonly number[],
  teamCount: number,
  maxTeamSize: number,
): SplitState {
  const sums = new Array<number>(teamCount).fill(0);
  const counts = new Array<number>(teamCount).fill(0);
  const assign = new Array<number>(points.length).fill(0);
  for (let i = 0; i < points.length; i++) {
    let best = -1;
    for (let team = 0; team < teamCount; team++) {
      if (counts[team] >= maxTeamSize) continue;
      if (
        best === -1 ||
        counts[team] < counts[best] ||
        (counts[team] === counts[best] && sums[team] < sums[best])
      ) {
        best = team;
      }
    }
    if (best === -1) {
      // Unreachable: maxTeamSize * teamCount >= points.length by construction.
      best = 0;
    }
    assign[i] = best;
    counts[best] += 1;
    sums[best] += points[i];
  }
  return { assign, sums, counts };
}

function membersOf(assign: readonly number[], teamCount: number): number[][] {
  const members: number[][] = Array.from({ length: teamCount }, () => []);
  assign.forEach((team, index) => members[team].push(index));
  return members;
}

type LocalChoice = {
  score: SplitScore;
  a: number;
  b: number;
  i: number;
  j: number;
  move: boolean;
};

// Best-improvement local search over swaps (size preserving) and moves
// (between teams that can give up a player without dropping below minSize).
function localSearch(
  points: readonly number[],
  teamCount: number,
  minTeamSize: number,
  maxTeamSize: number,
  start: SplitState,
): SplitState {
  const total = points.reduce((acc, p) => acc + p, 0);
  let { assign, sums, counts } = start;
  for (let pass = 0; pass < MAX_LOCAL_SEARCH_PASSES; pass++) {
    const current = score(sums, total);
    const members = membersOf(assign, teamCount);
    // Collected rather than mutated through a callback: TypeScript's control
    // flow does not track assignments made inside closures, which would leave
    // the "best" variable narrowed to null below.
    const candidates: LocalChoice[] = [];

    const consider = (
      nextSums: number[],
      a: number,
      b: number,
      i: number,
      j: number,
      move: boolean,
    ) => {
      const candidate = score(nextSums, total);
      if (!isBetter(candidate, current)) return;
      candidates.push({ score: candidate, a, b, i, j, move });
    };

    for (let a = 0; a < teamCount; a++) {
      for (let b = a + 1; b < teamCount; b++) {
        for (const i of members[a]) {
          for (const j of members[b]) {
            const delta = points[j] - points[i];
            if (delta === 0) continue;
            const nextSums = sums.slice();
            nextSums[a] += delta;
            nextSums[b] -= delta;
            consider(nextSums, a, b, i, j, false);
          }
        }
      }
    }

    for (let a = 0; a < teamCount; a++) {
      if (counts[a] <= minTeamSize) continue;
      for (let b = 0; b < teamCount; b++) {
        if (a === b || counts[b] >= maxTeamSize) continue;
        for (const i of members[a]) {
          const nextSums = sums.slice();
          nextSums[a] -= points[i];
          nextSums[b] += points[i];
          consider(nextSums, a, b, i, -1, true);
        }
      }
    }

    let best: LocalChoice | null = null;
    for (const candidate of candidates) {
      if (best === null || isBetter(candidate.score, best.score))
        best = candidate;
    }
    if (best === null) break;
    const choice = best;
    if (choice.move) {
      const p = points[choice.i];
      sums = sums.slice();
      sums[choice.a] -= p;
      sums[choice.b] += p;
      counts = counts.slice();
      counts[choice.a] -= 1;
      counts[choice.b] += 1;
      assign = assign.slice();
      assign[choice.i] = choice.b;
    } else {
      const delta = points[choice.j] - points[choice.i];
      sums = sums.slice();
      sums[choice.a] += delta;
      sums[choice.b] -= delta;
      assign = assign.slice();
      assign[choice.i] = choice.b;
      assign[choice.j] = choice.a;
    }
  }
  return { assign, sums, counts };
}

// Branch-and-bound over every equal-size split of `points` into `teamCount`
// unlabeled teams. Teams with identical (count, sum) are interchangeable, so
// only one of them is expanded at each depth. Seeded with a greedy split so
// the node cap, if it is ever hit, degrades to "at least as good as greedy".
function exactSplit(
  points: readonly number[],
  teamCount: number,
  minTeamSize: number,
  maxTeamSize: number,
  seed: SplitState,
): SplitState {
  const n = points.length;
  const total = points.reduce((acc, p) => acc + p, 0);
  const average = total / teamCount;
  const lowerBoundMax = Math.ceil(average);
  const upperBoundMin = Math.floor(average);

  let bestScore = score(seed.sums, total);
  let bestAssign = seed.assign.slice();
  const sums = new Array<number>(teamCount).fill(0);
  const counts = new Array<number>(teamCount).fill(0);
  const assign = new Array<number>(n).fill(0);
  let nodes = 0;

  const dfs = (index: number): void => {
    if (nodes++ > MAX_EXACT_NODES) return;
    if (index === n) {
      const candidate = score(sums, total);
      if (isBetter(candidate, bestScore)) {
        bestScore = candidate;
        bestAssign = assign.slice();
      }
      return;
    }

    // Every team needs minTeamSize players eventually, and no team may exceed
    // maxTeamSize. Prune when the remaining players cannot fill both bounds.
    const remaining = n - index;
    let needed = 0;
    let capacity = 0;
    for (let team = 0; team < teamCount; team++) {
      if (counts[team] < minTeamSize) needed += minTeamSize - counts[team];
      capacity += maxTeamSize - counts[team];
    }
    if (remaining < needed || remaining > capacity) return;

    // Lower bound on the final spread: the best possible max is at least the
    // current maximum and at least the average; the best possible min is at
    // most the average (a minimum can never exceed it).
    let currentMax = -Infinity;
    for (const sum of sums) if (sum > currentMax) currentMax = sum;
    const lowerBoundSpread =
      Math.max(currentMax, lowerBoundMax) - upperBoundMin;
    if (lowerBoundSpread > bestScore.spread) return;

    const point = points[index];
    const tried = new Set<string>();
    for (let team = 0; team < teamCount; team++) {
      if (counts[team] >= maxTeamSize) continue;
      const signature = `${counts[team]}:${sums[team]}`;
      if (tried.has(signature)) continue;
      tried.add(signature);
      counts[team] += 1;
      sums[team] += point;
      assign[index] = team;
      dfs(index + 1);
      counts[team] -= 1;
      sums[team] -= point;
    }
  };

  dfs(0);
  return {
    assign: bestAssign,
    sums: sumsOf(bestAssign, points, teamCount),
    counts: countsOf(bestAssign, teamCount),
  };
}

function sumsOf(
  assign: readonly number[],
  points: readonly number[],
  teamCount: number,
): number[] {
  const sums = new Array<number>(teamCount).fill(0);
  assign.forEach((team, index) => (sums[team] += points[index]));
  return sums;
}

function countsOf(assign: readonly number[], teamCount: number): number[] {
  const counts = new Array<number>(teamCount).fill(0);
  for (const team of assign) counts[team] += 1;
  return counts;
}

/**
 * Split players into `teamCount` teams so the team point sums differ as
 * little as possible. Team sizes are as equal as possible. Missing/NaN points
 * count as 0. When `teamCount` exceeds the roster the number of teams is
 * clamped to the roster size.
 */
export function balanceTeams(
  entries: readonly TeamBalanceEntry[],
  teamCount: number,
): BalancedTeams {
  const pins = new Map<string, number>();
  const n = entries.length;
  if (n === 0) return { pins, teamSums: [], spread: 0 };

  const teams = Math.max(1, Math.min(Math.floor(teamCount), n));
  const ordered = [...entries].sort((a, b) => {
    const byPoints = sanitizePoints(b.points) - sanitizePoints(a.points);
    if (byPoints !== 0) return byPoints;
    return a.clientID < b.clientID ? -1 : a.clientID > b.clientID ? 1 : 0;
  });

  if (teams === 1) {
    for (const entry of ordered) pins.set(entry.clientID, 0);
    return {
      pins,
      teamSums: [ordered.reduce((acc, e) => acc + sanitizePoints(e.points), 0)],
      spread: 0,
    };
  }

  const points = ordered.map((entry) => sanitizePoints(entry.points));
  const total = points.reduce((acc, p) => acc + p, 0);
  const minTeamSize = Math.floor(n / teams);
  const maxTeamSize = Math.ceil(n / teams);

  const greedy = greedySplit(points, teams, maxTeamSize);
  const local = localSearch(points, teams, minTeamSize, maxTeamSize, greedy);
  const split =
    n <= EXACT_SPLIT_LIMIT
      ? exactSplit(points, teams, minTeamSize, maxTeamSize, local)
      : local;

  ordered.forEach((entry, index) =>
    pins.set(entry.clientID, split.assign[index]),
  );
  const finalScore = score(split.sums, total);
  return { pins, teamSums: split.sums, spread: finalScore.spread };
}

function sanitizePoints(points: number): number {
  return Number.isFinite(points) ? points : 0;
}
