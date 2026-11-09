// @vitest-environment node
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { TokenPayload } from "../../src/core/ApiSchemas";
import { GameMode } from "../../src/core/game/Game";
import { GameServer } from "../../src/server/GameServer";
import type { RankedMatchStartedNotice } from "../../src/server/RankedLobbyNotifier";
import {
  cid,
  makeClient,
  makeGame,
  mockLogger,
  startGame,
} from "../util/GameServerHarness";

const signedIn = { role: null } as unknown as TokenPayload;
const HOST_PID = "host-pid";

// A ranked (listed) private lobby with a signed-in host and one guest.
function rankedLobby(
  rankedStarted: (notice: RankedMatchStartedNotice) => void,
) {
  const game = makeGame({
    creatorPersistentID: HOST_PID,
    deps: { rankedStarted },
  });
  game.setListed(true);
  const host = makeClient({
    persistentID: HOST_PID,
    publicId: "host-account",
    username: "Remus",
    claims: signedIn,
  });
  const guest = makeClient({
    clientID: cid("guest"),
    publicId: "guest-account",
    username: "Guest",
    claims: signedIn,
  });
  expect(game.joinClient(host)).toBe("joined");
  expect(game.joinClient(guest)).toBe("joined");
  return { game, host };
}

describe("ranked match start announcement", () => {
  test("fires once when a ranked lobby starts, with its details", () => {
    const rankedStarted = vi.fn();
    const { game } = rankedLobby(rankedStarted);

    startGame(game);

    expect(rankedStarted).toHaveBeenCalledTimes(1);
    expect(rankedStarted).toHaveBeenCalledWith({
      gameID: game.id,
      map: "World",
      mode: GameMode.FFA,
      players: 2,
      maxPlayers: undefined,
      host: "Remus",
    });
  });

  test("does not fire for an unranked lobby", () => {
    const rankedStarted = vi.fn();
    const game = makeGame({
      creatorPersistentID: HOST_PID,
      deps: { rankedStarted },
    });
    const host = makeClient({
      persistentID: HOST_PID,
      publicId: "host-account",
      claims: signedIn,
    });
    expect(game.joinClient(host)).toBe("joined");

    startGame(game);

    expect(rankedStarted).not.toHaveBeenCalled();
  });

  test("does not fire when the lobby was delisted before start", () => {
    const rankedStarted = vi.fn();
    const { game } = rankedLobby(rankedStarted);
    // A duplicate-creator / cap-overflow delist happens before start.
    game.setListed(false);

    startGame(game);

    expect(rankedStarted).not.toHaveBeenCalled();
  });

  test("announces at most once per game", () => {
    const rankedStarted = vi.fn();
    const { game } = rankedLobby(rankedStarted);

    startGame(game);
    game.start();

    expect(rankedStarted).toHaveBeenCalledTimes(1);
  });

  test("a failing notifier cannot block or fail the start", () => {
    const log = mockLogger();
    const rankedStarted = vi.fn(() => {
      throw new Error("discord down");
    });
    const game = makeGame({
      creatorPersistentID: HOST_PID,
      log,
      deps: { rankedStarted },
    });
    game.setListed(true);
    const host = makeClient({
      persistentID: HOST_PID,
      publicId: "host-account",
      claims: signedIn,
    });
    expect(game.joinClient(host)).toBe("joined");

    expect(() => startGame(game)).not.toThrow();
    expect(game.hasStarted()).toBe(true);
    expect(log.warn).toHaveBeenCalledWith(
      "ranked start notification failed",
      expect.objectContaining({ error: "discord down" }),
    );
  });
});

describe("ranked match announcement on resume", () => {
  const T0 = 1_700_000_000_000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  test("announces a ranked save when the host resumes it", () => {
    // Build a started ranked save, then restore it.
    const original = makeGame({ creatorPersistentID: HOST_PID });
    original.setListed(true);
    const host = makeClient({
      clientID: cid("host"),
      persistentID: HOST_PID,
      publicId: "host-account",
      username: "Remus",
      claims: signedIn,
    });
    const guest = makeClient({
      clientID: cid("p2"),
      persistentID: "p2-pid",
      publicId: "guest-account",
      username: "Guest",
      claims: signedIn,
    });
    expect(original.joinClient(host)).toBe("joined");
    expect(original.joinClient(guest)).toBe("joined");
    startGame(original);
    const save = original.snapshot()!;

    const rankedStarted = vi.fn();
    const restored = makeGame({
      restore: { ...save, aliveClientIDs: [cid("host"), cid("p2")] },
      deps: { rankedStarted },
    });
    const rejoinHost = makeClient({
      clientID: cid("host2"),
      persistentID: HOST_PID,
      publicId: "host-account",
      username: "Remus",
      claims: signedIn,
    });
    const rejoinGuest = makeClient({
      clientID: cid("p2b"),
      persistentID: "p2-pid",
      publicId: "guest-account",
      username: "Guest",
      claims: signedIn,
    });
    expect(restored.joinClient(rejoinHost)).toBe("joined");
    expect(restored.joinClient(rejoinGuest)).toBe("joined");
    expect(rankedStarted).not.toHaveBeenCalled();

    restored.handleIntent(
      { type: "toggle_game_start_timer" },
      {
        clientID: cid("host2"),
        isLobbyCreator: true,
        isAdmin: false,
        isAdminBot: false,
      },
    );
    vi.advanceTimersByTime(GameServer.RESUME_START_DELAY_MS + 10);

    expect(restored.isRanked()).toBe(true);
    expect(rankedStarted).toHaveBeenCalledTimes(1);
    expect(rankedStarted.mock.calls[0][0]).toMatchObject({
      gameID: restored.id,
      players: 2,
      host: "Remus",
    });
  });
});
