// @vitest-environment node
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  RANKED_K_FACTOR,
  RANKED_START_ELO,
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

describe("RankedRatingsStore", () => {
  test("applies the provisional Elo and counts the match", async () => {
    const store = new RankedRatingsStore(dir);
    const applied = await store.applyMatch({
      gameId: "game-1",
      participants: [alice, bob],
      winnerPublicIds: [alice.publicId],
    });

    expect(applied).toBe(true);
    const winner = await store.player(alice.publicId);
    const loser = await store.player(bob.publicId);
    expect(winner?.elo).toBe(RANKED_START_ELO + RANKED_K_FACTOR / 2);
    expect(winner?.peakElo).toBe(winner?.elo);
    expect(winner?.games).toBe(1);
    expect(loser?.elo).toBe(RANKED_START_ELO - RANKED_K_FACTOR / 2);
    expect(loser?.games).toBe(1);
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
      RANKED_START_ELO + RANKED_K_FACTOR / 2,
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
    expect(ladder.map((entry) => entry.public_id)).toEqual([
      alice.publicId,
      bob.publicId,
      carol.publicId,
    ]);
    expect(ladder.map((entry) => entry.rank)).toEqual([1, 2, 3]);
    expect(ladder[0].total).toBe(1);
    expect(ladder[0].accountUsername).toBe("Alice");
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
