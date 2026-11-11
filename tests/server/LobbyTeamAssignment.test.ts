import { describe, expect, it } from "vitest";
import { Duos, GameMode, HumansVsNations } from "../../src/core/game/Game";
import { GameConfig } from "../../src/core/Schemas";
import { GameServer } from "../../src/server/GameServer";
import { IntentActor } from "../../src/server/IntentAuthorization";
import {
  cid,
  makeClient,
  makeGame,
  startGame,
} from "../util/GameServerHarness";

const HOST_PID = "host-pid";

const actor = (
  clientID: string,
  over: Partial<IntentActor> = {},
): IntentActor => ({
  clientID,
  isLobbyCreator: false,
  isAdmin: false,
  isAdminBot: false,
  ...over,
});

const teamGame = (overrides: Partial<GameConfig> = {}): GameServer =>
  makeGame({
    creatorPersistentID: HOST_PID,
    config: {
      gameMode: GameMode.Team,
      playerTeams: 2,
      ...overrides,
    },
  });

function joinHostAndGuest(game: GameServer) {
  const host = makeClient({
    clientID: cid("host"),
    persistentID: HOST_PID,
    username: "Host",
  });
  const guest = makeClient({
    clientID: cid("guest"),
    persistentID: "guest-pid",
    username: "Guest",
  });
  game.joinClient(host);
  game.joinClient(guest);
  return { host, guest };
}

function teamIndexOf(game: GameServer, clientID: string): number | undefined {
  return game.gameInfo().clients?.find((c) => c.clientID === clientID)
    ?.teamIndex;
}

describe("GameServer - host team assignment", () => {
  it("pins a player to a team slot shown in lobby info", () => {
    const game = teamGame();
    const { host, guest } = joinHostAndGuest(game);

    const result = game.handleIntent(
      {
        type: "assign_player_team",
        targetClientID: guest.clientID,
        teamIndex: 1,
      },
      actor(host.clientID, { isLobbyCreator: true }),
    );

    expect(result.status).toBe(200);
    expect(teamIndexOf(game, guest.clientID)).toBe(1);
  });

  it("clears the pin when teamIndex is null", () => {
    const game = teamGame();
    const { host, guest } = joinHostAndGuest(game);
    const hostActor = actor(host.clientID, { isLobbyCreator: true });

    game.handleIntent(
      {
        type: "assign_player_team",
        targetClientID: guest.clientID,
        teamIndex: 1,
      },
      hostActor,
    );
    const cleared = game.handleIntent(
      {
        type: "assign_player_team",
        targetClientID: guest.clientID,
        teamIndex: null,
      },
      hostActor,
    );

    expect(cleared.status).toBe(200);
    expect(teamIndexOf(game, guest.clientID)).toBeUndefined();
  });

  it("lets the host move themselves", () => {
    const game = teamGame();
    const { host } = joinHostAndGuest(game);

    const result = game.handleIntent(
      {
        type: "assign_player_team",
        targetClientID: host.clientID,
        teamIndex: 1,
      },
      actor(host.clientID, { isLobbyCreator: true }),
    );

    expect(result.status).toBe(200);
    expect(teamIndexOf(game, host.clientID)).toBe(1);
  });

  it("rejects a non-host", () => {
    const game = teamGame();
    const { guest } = joinHostAndGuest(game);

    const result = game.handleIntent(
      {
        type: "assign_player_team",
        targetClientID: guest.clientID,
        teamIndex: 1,
      },
      actor(guest.clientID),
    );

    expect(result.status).toBe(403);
    expect(teamIndexOf(game, guest.clientID)).toBeUndefined();
  });

  it("rejects a team index past the team list", () => {
    const game = teamGame();
    const { host, guest } = joinHostAndGuest(game);

    const result = game.handleIntent(
      {
        type: "assign_player_team",
        targetClientID: guest.clientID,
        teamIndex: 2,
      },
      actor(host.clientID, { isLobbyCreator: true }),
    );

    expect(result.status).toBe(400);
    expect(teamIndexOf(game, guest.clientID)).toBeUndefined();
  });

  it("caps indexes when a preset's team count is only known on the client", () => {
    // Duos with map-default nations: the server cannot derive the exact count,
    // so it still rejects an absurd slot rather than storing it.
    const game = teamGame({ playerTeams: Duos });
    const { host, guest } = joinHostAndGuest(game);

    const result = game.handleIntent(
      {
        type: "assign_player_team",
        targetClientID: guest.clientID,
        teamIndex: 100000,
      },
      actor(host.clientID, { isLobbyCreator: true }),
    );

    expect(result.status).toBe(400);
    expect(teamIndexOf(game, guest.clientID)).toBeUndefined();
  });

  it("rejects an unknown or spectator target", () => {
    const game = teamGame();
    const { host } = joinHostAndGuest(game);
    const hostActor = actor(host.clientID, { isLobbyCreator: true });

    expect(
      game.handleIntent(
        {
          type: "assign_player_team",
          targetClientID: cid("ghost"),
          teamIndex: 0,
        },
        hostActor,
      ).status,
    ).toBe(404);

    const watcher = makeClient({
      clientID: cid("watch"),
      persistentID: "watch-pid",
      username: "Watcher",
      spectator: true,
    });
    game.joinClient(watcher);

    expect(
      game.handleIntent(
        {
          type: "assign_player_team",
          targetClientID: watcher.clientID,
          teamIndex: 0,
        },
        hostActor,
      ).status,
    ).toBe(404);
  });

  it("rejects assignment outside a team lobby", () => {
    const ffa = teamGame({ gameMode: GameMode.FFA });
    const { host, guest } = joinHostAndGuest(ffa);

    expect(
      ffa.handleIntent(
        {
          type: "assign_player_team",
          targetClientID: guest.clientID,
          teamIndex: 1,
        },
        actor(host.clientID, { isLobbyCreator: true }),
      ).status,
    ).toBe(409);

    const hvn = makeGame({
      creatorPersistentID: HOST_PID,
      config: {
        gameMode: GameMode.Team,
        playerTeams: HumansVsNations,
      },
    });
    const hvnPlayers = joinHostAndGuest(hvn);

    expect(
      hvn.handleIntent(
        {
          type: "assign_player_team",
          targetClientID: hvnPlayers.guest.clientID,
          teamIndex: 1,
        },
        actor(hvnPlayers.host.clientID, { isLobbyCreator: true }),
      ).status,
    ).toBe(409);
  });

  it("clears pins when the team count changes", () => {
    const game = teamGame();
    const { host, guest } = joinHostAndGuest(game);
    const hostActor = actor(host.clientID, { isLobbyCreator: true });

    game.handleIntent(
      {
        type: "assign_player_team",
        targetClientID: guest.clientID,
        teamIndex: 1,
      },
      hostActor,
    );
    expect(teamIndexOf(game, guest.clientID)).toBe(1);

    game.updateGameConfig({ playerTeams: 3 });

    expect(teamIndexOf(game, guest.clientID)).toBeUndefined();
  });

  it("ignores a pin left behind when the team count shrinks with the roster", () => {
    // Duos derives the team count from the roster, so two players leaving can
    // shrink the list without a config change (and therefore without the
    // clear-on-team-change guard running).
    const game = teamGame({ playerTeams: Duos, nations: "disabled" });
    const { host, guest } = joinHostAndGuest(game);
    const extra1 = makeClient({
      clientID: cid("extra1"),
      persistentID: "extra1-pid",
      username: "Extra1",
    });
    const extra2 = makeClient({
      clientID: cid("extra2"),
      persistentID: "extra2-pid",
      username: "Extra2",
    });
    game.joinClient(extra1);
    game.joinClient(extra2);

    game.handleIntent(
      {
        type: "assign_player_team",
        targetClientID: guest.clientID,
        teamIndex: 1,
      },
      actor(host.clientID, { isLobbyCreator: true }),
    );
    expect(teamIndexOf(game, guest.clientID)).toBe(1);

    game.kickClient(extra1.clientID, "kick_reason.admin");
    game.kickClient(extra2.clientID, "kick_reason.admin");

    // 2 players / duos = 1 team, so slot 1 no longer exists.
    expect(teamIndexOf(game, guest.clientID)).toBeUndefined();
  });

  it("carries the pin into the frozen start roster", () => {
    const game = teamGame();
    const { host, guest } = joinHostAndGuest(game);

    game.handleIntent(
      {
        type: "assign_player_team",
        targetClientID: guest.clientID,
        teamIndex: 1,
      },
      actor(host.clientID, { isLobbyCreator: true }),
    );

    startGame(game);

    const startInfo = game.snapshot()?.gameStartInfo;
    const guestRecord = startInfo?.players.find(
      (p) => p.clientID === guest.clientID,
    );
    expect(guestRecord?.teamIndex).toBe(1);
  });
});
