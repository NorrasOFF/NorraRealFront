// @vitest-environment node
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  decayElo,
  placementAward,
  RANKED_START_ELO,
  RANKED_WEEK_MS,
  RANKED_WINNER_ELO,
  RankedRatingsStore,
} from "../../src/server/ranking/RankedRatings";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "ranked-ratings-test-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const alice = { publicId: "alice-account", username: "Alice" };
const bob = { publicId: "bob-account", username: "Bob" };
const carol = { publicId: "carol-account", username: "Carol" };
const dave = { publicId: "dave-account", username: "Dave" };

function places(
  entries: [string, number][],
  teamSize: (publicId: string) => number = () => 1,
) {
  return entries.map(([publicId, place]) => ({
    publicId,
    place,
    teamSize: teamSize(publicId),
  }));
}

describe("placementAward", () => {
  test("falls by 5% of the winner constant per place", () => {
    expect(RANKED_WINNER_ELO).toBe(100);
    expect(placementAward(1)).toBe(100);
    expect(placementAward(2)).toBe(95);
    expect(placementAward(15)).toBe(30);
    expect(placementAward(21)).toBe(0);
  });
});

describe("RankedRatingsStore", () => {
  test("awards placement points and counts the match", async () => {
    const store = new RankedRatingsStore(dir);
    const applied = await store.applyMatch({
      gameId: "game-1",
      participants: [alice, bob, carol, dave],
      winnerPublicIds: [alice.publicId],
      placements: places([
        [alice.publicId, 1],
        [bob.publicId, 2],
        [carol.publicId, 3],
        [dave.publicId, 4],
      ]),
    });

    expect(applied).toBe(true);
    expect((await store.player(alice.publicId))?.elo).toBe(
      RANKED_START_ELO + 100,
    );
    expect((await store.player(bob.publicId))?.elo).toBe(RANKED_START_ELO + 95);
    expect((await store.player(carol.publicId))?.elo).toBe(
      RANKED_START_ELO + 90,
    );
    expect((await store.player(dave.publicId))?.elo).toBe(
      RANKED_START_ELO + 85,
    );
    expect((await store.player(alice.publicId))?.games).toBe(1);
    expect((await store.player(alice.publicId))?.peakElo).toBe(
      RANKED_START_ELO + 100,
    );
  });

  test("splits a team's place award equally between teammates", async () => {
    const store = new RankedRatingsStore(dir);
    await store.applyMatch({
      gameId: "team-game",
      participants: [alice, bob, carol, dave],
      winnerPublicIds: [alice.publicId, bob.publicId],
      placements: places(
        [
          [alice.publicId, 1],
          [bob.publicId, 1],
          [carol.publicId, 3],
          [dave.publicId, 3],
        ],
        () => 2,
      ),
    });

    // A two-player team win pays each member half of first place.
    expect((await store.player(alice.publicId))?.elo).toBe(
      RANKED_START_ELO + 50,
    );
    expect((await store.player(bob.publicId))?.elo).toBe(RANKED_START_ELO + 50);
    expect((await store.player(carol.publicId))?.elo).toBe(
      RANKED_START_ELO + 45,
    );
    expect((await store.player(dave.publicId))?.elo).toBe(
      RANKED_START_ELO + 45,
    );
  });

  test("falls back to winner first and the rest in join order", async () => {
    const store = new RankedRatingsStore(dir);
    await store.applyMatch({
      gameId: "game-1",
      participants: [alice, bob],
      winnerPublicIds: [alice.publicId],
    });

    expect((await store.player(alice.publicId))?.elo).toBe(
      RANKED_START_ELO + 100,
    );
    expect((await store.player(bob.publicId))?.elo).toBe(RANKED_START_ELO + 95);
  });

  test("is idempotent by game id", async () => {
    const store = new RankedRatingsStore(dir);
    const match = {
      gameId: "game-1",
      participants: [alice, bob],
      winnerPublicIds: [alice.publicId],
    };
    expect(await store.applyMatch(match)).toBe(true);
    expect(await store.applyMatch(match)).toBe(false);
    expect((await store.player(alice.publicId))?.games).toBe(1);
  });

  test("persists ratings and the applied-match log across instances", async () => {
    const first = new RankedRatingsStore(dir);
    await first.applyMatch({
      gameId: "game-1",
      participants: [alice, bob],
      winnerPublicIds: [bob.publicId],
    });

    const second = new RankedRatingsStore(dir);
    expect((await second.player(bob.publicId))?.elo).toBe(
      RANKED_START_ELO + 100,
    );
    // The reloaded store still knows game-1 was applied.
    expect(
      await second.applyMatch({
        gameId: "game-1",
        participants: [alice, bob],
        winnerPublicIds: [bob.publicId],
      }),
    ).toBe(false);
  });

  test("returns one ranked ladder ordered by Elo", async () => {
    const store = new RankedRatingsStore(dir);
    await store.applyMatch({
      gameId: "game-1",
      participants: [alice, bob],
      winnerPublicIds: [alice.publicId],
    });
    await store.applyMatch({
      gameId: "game-2",
      participants: [bob, carol],
      winnerPublicIds: [bob.publicId],
    });

    const ladder = await store.leaderboard();
    // Alice 1300, Bob 1295 + 100 = 1395, Carol 1295.
    expect(ladder.map((entry) => entry.public_id)).toEqual([
      bob.publicId,
      alice.publicId,
      carol.publicId,
    ]);
    expect(ladder.map((entry) => entry.rank)).toEqual([1, 2, 3]);
    expect(ladder[1].total).toBe(1);
    expect(ladder[1].accountUsername).toBe("Alice");
  });

  test("pages the ladder", async () => {
    const store = new RankedRatingsStore(dir);
    for (let i = 0; i < 3; i++) {
      await store.applyMatch({
        gameId: `game-${i}`,
        participants: [
          { publicId: `a${i}`, username: `A${i}` },
          { publicId: `b${i}`, username: `B${i}` },
        ],
        winnerPublicIds: [`a${i}`],
      });
    }
    const page2 = await store.leaderboard(2, 2);
    expect(page2).toHaveLength(2);
    expect(page2.map((entry) => entry.rank)).toEqual([3, 4]);
  });

  test("uses a replaceable rating algorithm", async () => {
    const store = new RankedRatingsStore(dir, () => {
      return new Map([[alice.publicId, 2000]]);
    });
    await store.applyMatch({
      gameId: "game-1",
      participants: [alice, bob],
      winnerPublicIds: [alice.publicId],
    });
    expect((await store.player(alice.publicId))?.elo).toBe(2000);
    // The algorithm returns no value for Bob, so his rating is unchanged but
    // the match is still counted.
    expect((await store.player(bob.publicId))?.elo).toBe(RANKED_START_ELO);
    expect((await store.player(bob.publicId))?.games).toBe(1);
  });

  test("ignores winnerless matches and single-participant matches", async () => {
    const store = new RankedRatingsStore(dir);
    expect(
      await store.applyMatch({
        gameId: "no-winner",
        participants: [alice, bob],
        winnerPublicIds: [],
      }),
    ).toBe(false);
    expect(
      await store.applyMatch({
        gameId: "solo",
        participants: [alice],
        winnerPublicIds: [alice.publicId],
      }),
    ).toBe(false);
    expect(await store.player(alice.publicId)).toBeNull();
  });
});

describe("inactivity decay", () => {
  test("drops 10% of the excess over the start Elo per full week", () => {
    // 2000 is 800 above the start.
    expect(decayElo(2000, 0, RANKED_WEEK_MS)).toBe(1920);
    expect(decayElo(2000, 0, 2 * RANKED_WEEK_MS)).toBeCloseTo(1848, 2);
    // No full week has passed.
    expect(decayElo(2000, 0, 6 * 24 * 60 * 60 * 1000)).toBe(2000);
    // At or below the start value, nothing moves.
    expect(decayElo(RANKED_START_ELO, 0, 10 * RANKED_WEEK_MS)).toBe(
      RANKED_START_ELO,
    );
    expect(decayElo(1000, 0, 10 * RANKED_WEEK_MS)).toBe(1000);
  });

  test("decays before the next award is applied", async () => {
    const now = Date.now();
    await fs.writeFile(
      path.join(dir, "ranked-ratings.json"),
      JSON.stringify({
        version: 1,
        players: {
          [alice.publicId]: {
            ...alice,
            elo: 2000,
            peakElo: 2000,
            games: 5,
            updatedAt: now - 2 * RANKED_WEEK_MS,
          },
          [bob.publicId]: {
            ...bob,
            elo: 1300,
            peakElo: 1300,
            games: 2,
            updatedAt: now,
          },
        },
        appliedMatches: [],
      }),
    );

    const store = new RankedRatingsStore(dir);
    await store.applyMatch({
      gameId: "after-break",
      participants: [alice, bob],
      winnerPublicIds: [alice.publicId],
      placements: places([
        [alice.publicId, 2],
        [bob.publicId, 1],
      ]),
    });

    // 1200 + 800 * 0.9^2 = 1848, then +95 for second place.
    expect((await store.player(alice.publicId))?.elo).toBe(1943);
    expect((await store.player(bob.publicId))?.elo).toBe(1300 + 100);
  });

  test("leaderboard orders by the decayed rating", async () => {
    const now = Date.now();
    await fs.writeFile(
      path.join(dir, "ranked-ratings.json"),
      JSON.stringify({
        version: 1,
        players: {
          [alice.publicId]: {
            ...alice,
            elo: 2000,
            peakElo: 2000,
            games: 10,
            updatedAt: now - 4 * RANKED_WEEK_MS,
          },
          [bob.publicId]: {
            ...bob,
            elo: 1900,
            peakElo: 1900,
            games: 10,
            updatedAt: now,
          },
        },
        appliedMatches: [],
      }),
    );

    const store = new RankedRatingsStore(dir);
    const ladder = await store.leaderboard();
    expect(ladder.map((entry) => entry.public_id)).toEqual([
      bob.publicId,
      alice.publicId,
    ]);
    // Alice: 1200 + 800 * 0.9^4 = 1724.88.
    expect(ladder[1].elo).toBeCloseTo(1724.88, 2);
    expect(ladder[0].elo).toBe(1900);
  });
});
