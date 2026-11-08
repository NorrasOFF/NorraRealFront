// @vitest-environment node
import { describe, expect, test, vi } from "vitest";
import { TokenPayload } from "../../src/core/ApiSchemas";
import type { RankedMatch } from "../../src/server/ranking/RankedRatings";
import {
  cid,
  makeClient,
  makeGame,
  mockWsOf,
  startGame,
} from "../util/GameServerHarness";

const signedIn = { role: null } as unknown as TokenPayload;

describe("ranked lobbies", () => {
  test("listing a private lobby marks it ranked", () => {
    const game = makeGame();
    expect(game.isRanked()).toBe(false);
    game.setListed(true);
    expect(game.isRanked()).toBe(true);
    // A server-side delist (duplicate creator / cap overflow) happens before
    // start, and must clear the marker again.
    game.setListed(false);
    expect(game.isRanked()).toBe(false);
  });

  test("anonymous clients cannot join a ranked lobby", () => {
    const game = makeGame();
    game.setListed(true);

    expect(game.joinClient(makeClient())).toBe("not_authenticated");
    expect(
      game.joinClient(
        makeClient({ publicId: "signed-account", claims: signedIn }),
      ),
    ).toBe("joined");
  });

  test("a finished ranked lobby is reported to the rating store", async () => {
    const ranked = vi.fn(async (_match: RankedMatch) => true);
    const game = makeGame({ deps: { ranked } });
    game.setListed(true);

    const winner = makeClient({
      clientID: cid("winner"),
      publicId: "winner-account",
      username: "Winner",
      ip: "10.0.0.1",
      claims: signedIn,
    });
    const loser = makeClient({
      clientID: cid("loser"),
      publicId: "loser-account",
      username: "Loser",
      ip: "10.0.0.2",
      claims: signedIn,
    });
    expect(game.joinClient(winner)).toBe("joined");
    expect(game.joinClient(loser)).toBe("joined");
    startGame(game);

    const vote = {
      type: "winner" as const,
      winner: ["player", winner.clientID] as ["player", string],
      allPlayersStats: {},
    };
    await mockWsOf(winner).emit(vote);
    await mockWsOf(loser).emit(vote);

    expect(ranked).toHaveBeenCalledTimes(1);
    const match = ranked.mock.calls[0][0];
    expect(match.gameId).toBe(game.id);
    expect(match.winnerPublicIds).toEqual(["winner-account"]);
    expect(match.placements).toEqual([
      { publicId: "winner-account", place: 1, teamSize: 1 },
      { publicId: "loser-account", place: 2, teamSize: 1 },
    ]);
    expect(match.participants).toEqual(
      expect.arrayContaining([
        { publicId: "winner-account", username: "Winner" },
        { publicId: "loser-account", username: "Loser" },
      ]),
    );
  });

  test("places finishers from the game's archived stats", async () => {
    const ranked = vi.fn(async (_match: RankedMatch) => true);
    const game = makeGame({ deps: { ranked } });
    game.setListed(true);

    const make = (name: string, ip: string) =>
      makeClient({
        clientID: cid(name),
        publicId: `${name}-account`,
        username: name,
        ip,
        claims: signedIn,
      });
    const winner = make("winner", "10.0.1.1");
    const survivor = make("survivor", "10.0.1.2");
    const third = make("third", "10.0.1.3");
    const fourth = make("fourth", "10.0.1.4");
    for (const client of [winner, survivor, third, fourth]) {
      expect(game.joinClient(client)).toBe("joined");
    }
    startGame(game);

    const vote = {
      type: "winner" as const,
      winner: ["player", winner.clientID] as ["player", string],
      allPlayersStats: {
        [winner.clientID]: { finalTiles: 1000n },
        [survivor.clientID]: { finalTiles: 500n },
        [third.clientID]: { deathPosition: 2 },
        [fourth.clientID]: { deathPosition: 3 },
      },
    };
    for (const client of [winner, survivor, third, fourth]) {
      await mockWsOf(client).emit(vote);
    }

    expect(ranked).toHaveBeenCalledTimes(1);
    const match = ranked.mock.calls[0][0];
    expect(match.placements).toEqual([
      { publicId: "winner-account", place: 1, teamSize: 1 },
      { publicId: "survivor-account", place: 2, teamSize: 1 },
      { publicId: "third-account", place: 3, teamSize: 1 },
      { publicId: "fourth-account", place: 4, teamSize: 1 },
    ]);
  });

  test("an unranked lobby never reports a rating", async () => {
    const ranked = vi.fn(async (_match: RankedMatch) => true);
    const game = makeGame({ deps: { ranked } });

    const winner = makeClient({
      clientID: cid("plainWin"),
      publicId: "plain-winner",
      ip: "10.0.0.3",
      claims: signedIn,
    });
    const loser = makeClient({
      clientID: cid("plainL"),
      publicId: "plain-loser",
      ip: "10.0.0.4",
      claims: signedIn,
    });
    expect(game.joinClient(winner)).toBe("joined");
    expect(game.joinClient(loser)).toBe("joined");
    startGame(game);

    const vote = {
      type: "winner" as const,
      winner: ["player", winner.clientID] as ["player", string],
      allPlayersStats: {},
    };
    await mockWsOf(winner).emit(vote);
    await mockWsOf(loser).emit(vote);

    expect(ranked).not.toHaveBeenCalled();
  });
});
