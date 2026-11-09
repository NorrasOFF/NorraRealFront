// @vitest-environment node
import { describe, expect, test, vi } from "vitest";
import { TokenPayload } from "../../src/core/ApiSchemas";
import { GameMode } from "../../src/core/game/Game";
import { GameConfig } from "../../src/core/Schemas";
import { RANKED_START_ELO } from "../../src/server/ranking/RankedRatings";
import {
  cid,
  makeClient,
  makeGame,
  startGame,
} from "../util/GameServerHarness";

const signedIn = { role: null } as unknown as TokenPayload;
const HOST_PID = "host-pid";

interface LobbyOptions {
  points: Record<string, number>;
  config?: Partial<GameConfig>;
  matchmakingTeams?: string[][];
  ranked?: boolean;
}

// A private lobby with one signed-in client per entry in `points`, keyed by
// publicId. The ranked-points dependency reads the same map.
function makeLobby(opts: LobbyOptions) {
  const game = makeGame({
    creatorPersistentID: HOST_PID,
    config: {
      gameMode: GameMode.Team,
      playerTeams: 2,
      nations: "disabled",
      ...opts.config,
    },
    matchmakingTeams: opts.matchmakingTeams,
    deps: {
      rankedPoints: async (publicIds) =>
        new Map(
          publicIds.map((id) => [id, opts.points[id] ?? RANKED_START_ELO]),
        ),
    },
  });
  if (opts.ranked !== false) game.setListed(true);

  const publicIds = Object.keys(opts.points);
  const clients = publicIds.map((publicId, index) =>
    makeClient({
      clientID: cid(`p${index}`),
      persistentID: index === 0 ? HOST_PID : `guest-${index}-pid`,
      publicId,
      username: `Player${index}`,
      claims: signedIn,
    }),
  );
  for (const client of clients) {
    expect(game.joinClient(client)).toBe("joined");
  }
  return { game, clients, publicIds };
}

function startInfoPlayers(game: ReturnType<typeof makeGame>) {
  const snapshot = game.snapshot();
  expect(snapshot).not.toBeNull();
  const players = snapshot!.gameStartInfo?.players;
  expect(players).toBeDefined();
  return players!;
}

function teamSums(
  players: { publicId?: string; clientID: string; teamIndex?: number }[],
  clients: { clientID: string; publicId?: string }[],
  points: Record<string, number>,
): number[] {
  const sums = new Map<number, number>();
  for (const player of players) {
    if (player.teamIndex === undefined) continue;
    const client = clients.find((c) => c.clientID === player.clientID);
    const publicId = client?.publicId ?? player.publicId;
    const value =
      publicId === undefined
        ? RANKED_START_ELO
        : (points[publicId] ?? RANKED_START_ELO);
    sums.set(player.teamIndex, (sums.get(player.teamIndex) ?? 0) + value);
  }
  return [...sums.entries()].sort((a, b) => a[0] - b[0]).map(([, s]) => s);
}

describe("ranked lobbies balance teams by points", () => {
  test("stamps the split that minimizes the difference between team sums", async () => {
    const points = { alice: 2000, bob: 1900, carol: 1100, dave: 1000 };
    const { game, clients } = makeLobby({ points });

    await game.refreshRankedTeams();
    startGame(game);

    const players = startInfoPlayers(game);
    const sums = teamSums(players, clients, points);
    expect(sums).toEqual([3000, 3000]); // 2000+1000 vs 1900+1100
    // Strongest and second strongest are on opposite teams.
    const teamOf = (publicId: string) => {
      const client = clients.find((c) => c.publicId === publicId)!;
      return players.find((p) => p.clientID === client.clientID)?.teamIndex;
    };
    expect(teamOf("alice")).not.toBe(teamOf("bob"));
  });

  test("keeps team sizes within one player on an odd roster", async () => {
    const points = { a: 2000, b: 1900, c: 1800, d: 1200, e: 1100 };
    const { game, clients } = makeLobby({ points });

    await game.refreshRankedTeams();
    startGame(game);

    const players = startInfoPlayers(game);
    const sizes = new Map<number, number>();
    for (const player of players) {
      if (player.teamIndex === undefined) continue;
      sizes.set(player.teamIndex, (sizes.get(player.teamIndex) ?? 0) + 1);
    }
    expect([...sizes.values()].sort((x, y) => x - y)).toEqual([2, 3]);
    const sums = teamSums(players, clients, points);
    // Sizes are 3 vs 2, so 200 is the best possible spread here.
    expect(Math.max(...sums) - Math.min(...sums)).toBe(200);
  });

  test("publishes each player's ranked points in the lobby roster", async () => {
    const points = { alice: 2000, bob: 1875.4, carol: 1100, dave: 1000 };
    const { game, clients } = makeLobby({ points });

    await game.refreshRankedTeams();

    const roster = game.gameInfo().clients ?? [];
    const eloOf = (clientID: string) =>
      roster.find((c) => c.clientID === clientID)?.elo;
    expect(eloOf(clients[0].clientID)).toBe(2000);
    expect(eloOf(clients[1].clientID)).toBe(1875);
    // Unlisted players still have a points display in a ranked lobby.
    expect(eloOf(clients[3].clientID)).toBe(1000);
  });

  test("falls back to the normal assignment when every point total is equal", async () => {
    const points = { alice: 1200, bob: 1200, carol: 1200, dave: 1200 };
    const { game, clients } = makeLobby({ points });

    await game.refreshRankedTeams();
    startGame(game);

    const players = startInfoPlayers(game);
    // No pins: the unranked assignment path (team fill, clan/friend
    // grouping) is what should run, not an arbitrary frozen split.
    expect(players.every((p) => p.teamIndex === undefined)).toBe(true);
    // Points are still displayed.
    const roster = game.gameInfo().clients ?? [];
    expect(roster.find((c) => c.clientID === clients[0].clientID)?.elo).toBe(
      1200,
    );
  });

  test("does nothing for an unranked team lobby", async () => {
    const points = { alice: 2000, bob: 1900, carol: 1100, dave: 1000 };
    const { game } = makeLobby({ points, ranked: false });

    await game.refreshRankedTeams();
    startGame(game);

    const players = startInfoPlayers(game);
    expect(players.every((p) => p.teamIndex === undefined)).toBe(true);
    expect(
      (game.gameInfo().clients ?? []).every((c) => c.elo === undefined),
    ).toBe(true);
  });

  test("does nothing for a ranked FFA lobby (no teams to balance)", async () => {
    const points = { alice: 2000, bob: 1900, carol: 1100, dave: 1000 };
    const { game, clients } = makeLobby({
      points,
      config: { gameMode: GameMode.FFA },
    });

    await game.refreshRankedTeams();
    startGame(game);

    const players = startInfoPlayers(game);
    expect(players.every((p) => p.teamIndex === undefined)).toBe(true);
    // Points are still shown, though.
    const roster = game.gameInfo().clients ?? [];
    expect(roster.find((c) => c.clientID === clients[0].clientID)?.elo).toBe(
      2000,
    );
  });

  test("keeps the matchmaker's split when one is present", async () => {
    const points = { alice: 2000, bob: 1900, carol: 1100, dave: 1000 };
    const { game, clients } = makeLobby({
      points,
      matchmakingTeams: [
        ["alice", "bob"],
        ["carol", "dave"],
      ],
    });

    await game.refreshRankedTeams();
    startGame(game);

    const players = startInfoPlayers(game);
    const teamOf = (publicId: string) => {
      const client = clients.find((c) => c.publicId === publicId)!;
      return players.find((p) => p.clientID === client.clientID)?.teamIndex;
    };
    expect(teamOf("alice")).toBe(0);
    expect(teamOf("bob")).toBe(0);
    expect(teamOf("carol")).toBe(1);
    expect(teamOf("dave")).toBe(1);
  });

  test("uses the start-time refresh over an earlier one", async () => {
    // The lobby refresh runs on listing/join and again before start; a player
    // joining later must be balanced in, not left unpinned.
    const points: Record<string, number> = {
      alice: 2000,
      bob: 1900,
      carol: 1100,
      dave: 1000,
    };
    const { game, clients } = makeLobby({ points });

    await game.refreshRankedTeams();

    const late = makeClient({
      clientID: cid("late"),
      publicId: "eve",
      username: "Eve",
      claims: signedIn,
    });
    points.eve = 3000;
    expect(game.joinClient(late)).toBe("joined");

    await game.refreshRankedTeams();
    startGame(game);

    const players = startInfoPlayers(game);
    const allClients = [...clients, late];
    const sums = teamSums(players, allClients, points);
    expect(players.every((p) => p.teamIndex !== undefined)).toBe(true);
    // 5 players / 2 teams is 3 vs 2; 800 is the optimal spread for these
    // points, and it is far below the naive "first four balanced" split.
    expect(Math.max(...sums) - Math.min(...sums)).toBe(800);
  });

  test("a failing points read never blocks the start", async () => {
    const game = makeGame({
      creatorPersistentID: HOST_PID,
      config: {
        gameMode: GameMode.Team,
        playerTeams: 2,
        nations: "disabled",
      },
      deps: {
        rankedPoints: vi.fn(async () => {
          throw new Error("ladder unavailable");
        }),
      },
    });
    game.setListed(true);
    const client = makeClient({
      persistentID: HOST_PID,
      publicId: "alice",
      username: "Alice",
      claims: signedIn,
    });
    expect(game.joinClient(client)).toBe("joined");

    await expect(game.refreshRankedTeams()).resolves.toBeUndefined();
    expect(() => startGame(game)).not.toThrow();
    expect(game.hasStarted()).toBe(true);
  });
});
