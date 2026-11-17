// @vitest-environment node
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  placementAward,
  RANKED_START_ELO,
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

const alice = {
  publicId: "alice-account",
  username: "Alice",
  verifiedName: "Alice",
};
const bob = { publicId: "bob-account", username: "Bob", verifiedName: "Bob" };
const carol = {
  publicId: "carol-account",
  username: "Carol",
  verifiedName: "Carol",
};
const dave = {
  publicId: "dave-account",
  username: "Dave",
  verifiedName: "Dave",
};

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

  test("divides the base by team size before the place reduction", () => {
    // (100 / 2) * (1 - 0.05 * (place - 1))
    expect(placementAward(1, 2)).toBe(50);
    expect(placementAward(3, 2)).toBe(45);
    expect(placementAward(1, 3)).toBe(33.33);
    expect(placementAward(10, 4)).toBe(13.75);
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
          { publicId: `a${i}`, username: `A${i}`, verifiedName: `A${i}` },
          { publicId: `b${i}`, username: `B${i}`, verifiedName: `B${i}` },
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

describe("verified names only", () => {
  function written(
    rating: { publicId: string; username: string },
    elo: number,
    verifiedName?: string | null,
  ) {
    const base = {
      publicId: rating.publicId,
      username: rating.username,
      elo,
      peakElo: elo,
      games: 4,
      updatedAt: Date.now(),
    };
    return verifiedName === undefined ? base : { ...base, verifiedName };
  }

  async function writeLadder(players: Record<string, Record<string, unknown>>) {
    await fs.writeFile(
      path.join(dir, "ranked-ratings.json"),
      JSON.stringify({ version: 1, players, appliedMatches: [] }),
    );
  }

  test("hides unverified entries but keeps their points and true ranks", async () => {
    await writeLadder({
      [alice.publicId]: written(alice, 1200, "Alice"),
      [carol.publicId]: written(carol, 2100, null),
      [bob.publicId]: written(bob, 1100, "Bob"),
      // A dotted name is not a verified (bare) account name.
      [dave.publicId]: written(dave, 1000, "dave.1234"),
    });
    const store = new RankedRatingsStore(dir);

    const ladder = await store.leaderboard();
    expect(ladder.map((entry) => entry.public_id)).toEqual([
      alice.publicId,
      bob.publicId,
    ]);
    // The ladder positions are untouched: no renumbering around hidden rows.
    expect(ladder.map((entry) => entry.rank)).toEqual([2, 3]);
    expect(ladder.map((entry) => entry.accountUsername)).toEqual([
      "Alice",
      "Bob",
    ]);

    // Nothing was reset or dropped for the hidden players.
    expect((await store.player(carol.publicId))?.elo).toBe(2100);
    expect((await store.player(carol.publicId))?.games).toBe(4);
    expect((await store.player(dave.publicId))?.elo).toBe(1000);

    // Paging walks visible entries only, still reporting true ranks.
    const page2 = await store.leaderboard(2, 1);
    expect(page2.map((entry) => entry.public_id)).toEqual([bob.publicId]);
    expect(page2[0].rank).toBe(3);
  });

  test("a legacy file without verified names still loads and is backfilled", async () => {
    await writeLadder({
      [alice.publicId]: written(alice, 2000),
      [bob.publicId]: written(bob, 1900),
    });
    const store = new RankedRatingsStore(dir);

    // Old entries parse, keep their points, and are simply not listed yet.
    expect((await store.player(alice.publicId))?.verifiedName).toBeNull();
    expect((await store.player(alice.publicId))?.elo).toBe(2000);
    expect(await store.leaderboard()).toEqual([]);

    const labelled = await store.backfillVerifiedNames((publicId) =>
      publicId === alice.publicId ? "Alice" : "Bob",
    );
    expect(labelled).toBe(2);
    expect(await store.leaderboard()).toEqual([
      expect.objectContaining({
        rank: 1,
        public_id: alice.publicId,
        accountUsername: "Alice",
        total: 4,
      }),
      expect.objectContaining({
        rank: 2,
        public_id: bob.publicId,
        accountUsername: "Bob",
      }),
    ]);
    // Backfilling a name never touches the ranking itself.
    expect((await store.player(alice.publicId))?.elo).toBe(2000);
    expect((await store.player(bob.publicId))?.elo).toBe(1900);
    // Idempotent: an already-labelled entry is not resolved again.
    expect(await store.backfillVerifiedNames(() => "Changed")).toBe(0);
    expect((await store.player(alice.publicId))?.verifiedName).toBe("Alice");
  });

  test("a match records, clears and preserves the verified name", async () => {
    const store = new RankedRatingsStore(dir);

    await store.applyMatch({
      gameId: "verified-match",
      participants: [alice, bob],
      winnerPublicIds: [alice.publicId],
    });
    expect((await store.player(alice.publicId))?.verifiedName).toBe("Alice");

    // Playing under a typed-in name clears the stored verified name (that name
    // may not be shown on the topplist).
    await store.applyMatch({
      gameId: "custom-name-match",
      participants: [
        { ...alice, verifiedName: null },
        { ...bob, verifiedName: null },
      ],
      winnerPublicIds: [alice.publicId],
    });
    expect((await store.player(alice.publicId))?.verifiedName).toBeNull();

    // A caller with no name information (undefined) leaves the stored name be.
    await store.applyMatch({
      gameId: "verified-again",
      participants: [alice, bob],
      winnerPublicIds: [alice.publicId],
    });
    await store.applyMatch({
      gameId: "legacy-caller",
      participants: [
        { publicId: alice.publicId, username: "Ali" },
        { publicId: bob.publicId, username: "Bob" },
      ],
      winnerPublicIds: [alice.publicId],
    });
    expect((await store.player(alice.publicId))?.verifiedName).toBe("Alice");
  });
});

describe("zero baseline and no decay", () => {
  test("a new player starts at zero", () => {
    expect(RANKED_START_ELO).toBe(0);
  });

  test("keeps stored points after a long idle period", async () => {
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
            updatedAt: now - 365 * 24 * 60 * 60 * 1000,
          },
          [bob.publicId]: {
            ...bob,
            elo: 1900,
            peakElo: 1900,
            games: 5,
            updatedAt: now,
          },
        },
        appliedMatches: [],
      }),
    );

    const store = new RankedRatingsStore(dir);
    const ladder = await store.leaderboard();
    // The topplist says nothing about the rating; the ordering still comes from
    // it and the stored points are untouched.
    expect(ladder.map((entry) => entry.public_id)).toEqual([
      alice.publicId,
      bob.publicId,
    ]);
    expect(ladder[0]).not.toHaveProperty("elo");
    expect(ladder[0]).not.toHaveProperty("peakElo");
    expect((await store.player(alice.publicId))?.elo).toBe(2000);
    expect((await store.player(bob.publicId))?.elo).toBe(1900);
  });

  test("adds the next award to the full stored total", async () => {
    const now = Date.now();
    await fs.writeFile(
      path.join(dir, "ranked-ratings.json"),
      JSON.stringify({
        version: 1,
        players: {
          [alice.publicId]: {
            ...alice,
            elo: 500,
            peakElo: 500,
            games: 5,
            updatedAt: now - 365 * 24 * 60 * 60 * 1000,
          },
          [bob.publicId]: {
            ...bob,
            elo: 400,
            peakElo: 400,
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

    // No decay: 500 + 95 for second place.
    expect((await store.player(alice.publicId))?.elo).toBe(595);
    expect((await store.player(bob.publicId))?.elo).toBe(400 + 100);
  });
});
