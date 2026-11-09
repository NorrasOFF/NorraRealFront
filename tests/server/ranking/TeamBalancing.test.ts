import { describe, expect, test } from "vitest";
import {
  balanceTeams,
  type TeamBalanceEntry,
} from "../../../src/server/ranking/TeamBalancing";

function entries(points: number[]): TeamBalanceEntry[] {
  return points.map((p, i) => ({ clientID: `p${i}`, points: p }));
}

function teamOf(pins: Map<string, number>, index: number): number {
  const team = pins.get(`p${index}`);
  if (team === undefined) throw new Error(`no pin for p${index}`);
  return team;
}

// Exhaustive optimum for small rosters: every assignment whose team sizes are
// as equal as possible.
function bruteForceSpread(points: number[], teams: number): number {
  const n = points.length;
  const max = Math.ceil(n / teams);
  const sums = new Array<number>(teams).fill(0);
  const counts = new Array<number>(teams).fill(0);
  let best = Infinity;
  const walk = (i: number) => {
    if (i === n) {
      best = Math.min(best, Math.max(...sums) - Math.min(...sums));
      return;
    }
    for (let team = 0; team < teams; team++) {
      if (counts[team] >= max) continue;
      counts[team] += 1;
      sums[team] += points[i];
      walk(i + 1);
      sums[team] -= points[i];
      counts[team] -= 1;
    }
  };
  walk(0);
  return best;
}

// Small deterministic LCG so failures are reproducible.
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

describe("balanceTeams", () => {
  test("pairs the strongest with the weakest for two teams", () => {
    const { pins, teamSums, spread } = balanceTeams(
      entries([1200, 1800, 1100, 1700]),
      2,
    );

    expect(spread).toBe(0);
    expect([...teamSums].sort((a, b) => a - b)).toEqual([2900, 2900]);
    // Strongest (p1) is not with the second strongest (p3).
    expect(teamOf(pins, 1)).not.toBe(teamOf(pins, 3));
    // Equal team sizes.
    const sizes = [0, 0];
    for (let i = 0; i < 4; i++) sizes[teamOf(pins, i)] += 1;
    expect(sizes).toEqual([2, 2]);
  });

  test("reaches the true optimum on small random lobbies", () => {
    const random = rng(20261109);
    for (let trial = 0; trial < 120; trial++) {
      const teams = 2 + Math.floor(random() * 2); // 2 or 3
      const n = 4 + Math.floor(random() * 6); // 4..9 (brute force stays cheap)
      const points = Array.from({ length: n }, () =>
        Math.round(800 + random() * 2200),
      );
      const { spread } = balanceTeams(entries(points), teams);
      const optimal = bruteForceSpread(points, teams);
      expect(spread, `points=${points.join(",")} teams=${teams}`).toBe(optimal);
    }
  });

  test("keeps team sizes within one player", () => {
    const { pins } = balanceTeams(entries([10, 9, 8, 7, 6, 5, 4]), 3);
    const sizes = [0, 0, 0];
    for (let i = 0; i < 7; i++) sizes[teamOf(pins, i)] += 1;
    expect([...sizes].sort((a, b) => a - b)).toEqual([2, 2, 3]);
  });

  test("is deterministic and independent of input order", () => {
    const points = [1520, 1210, 1990, 1000, 1450, 1750];
    const first = balanceTeams(entries(points), 2);
    const reversed = balanceTeams([...entries(points)].reverse(), 2);
    const shuffled = balanceTeams(
      [3, 0, 5, 1, 4, 2].map((i) => ({ clientID: `p${i}`, points: points[i] })),
      2,
    );
    expect([...reversed.pins].sort()).toEqual([...first.pins].sort());
    expect([...shuffled.pins].sort()).toEqual([...first.pins].sort());
    expect(reversed.teamSums).toEqual(first.teamSums);
  });

  test("clamps the team count to the roster", () => {
    const { pins, teamSums } = balanceTeams(entries([1500, 1100]), 4);
    expect(teamSums).toEqual([1500, 1100]);
    expect(new Set(pins.values()).size).toBe(2);
  });

  test("treats non-finite points as zero", () => {
    const { pins, teamSums } = balanceTeams(
      [
        { clientID: "a", points: Number.NaN },
        { clientID: "b", points: 1000 },
      ],
      2,
    );
    expect(teamSums).toEqual([1000, 0]);
    expect(pins.size).toBe(2);
  });

  test("handles an empty roster", () => {
    const { pins, teamSums, spread } = balanceTeams([], 3);
    expect(pins.size).toBe(0);
    expect(teamSums).toEqual([]);
    expect(spread).toBe(0);
  });

  test("balances a large lobby with equal-size teams", () => {
    const random = rng(7);
    const points = Array.from({ length: 64 }, () =>
      Math.round(1000 + random() * 1000),
    );
    const { pins, teamSums, spread } = balanceTeams(entries(points), 8);
    const sizes = new Array<number>(8).fill(0);
    for (let i = 0; i < 64; i++) sizes[teamOf(pins, i)] += 1;
    expect(sizes).toEqual([8, 8, 8, 8, 8, 8, 8, 8]);
    // A greedy draft is within one strongest player of optimal here; the
    // local search must at least beat a trivial spread.
    expect(spread).toBeLessThanOrEqual(
      Math.max(...points) - Math.min(...points),
    );
    expect(Math.max(...teamSums) - Math.min(...teamSums)).toBe(spread);
  });
});
