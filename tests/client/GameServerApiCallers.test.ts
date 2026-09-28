import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/client/Auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/client/Auth")>()),
  getPlayToken: vi.fn(async () => "play-token"),
  getAuthHeader: vi.fn(async () => "Bearer test"),
  isSessionActive: vi.fn(() => false),
}));

import {
  createLobby,
  listSavedLobbies,
  resumeSavedLobby,
} from "../../src/client/Api";
import { ClientEnv } from "../../src/client/ClientEnv";
import { JoinLobbyModal } from "../../src/client/JoinLobbyModal";
import { MatchmakingModal } from "../../src/client/Matchmaking";

// Every remaining caller of the game server's HTTP API, driven through real
// production code. Each one used to build a relative URL, which silently
// resolved against the document origin instead of the game server.
const SERVER_HOST = "main.openfront.dev";

let fetchMock: ReturnType<typeof vi.fn>;

function lastCall(): any[] {
  const calls = fetchMock.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1];
}

function lastUrl(): string {
  return String(lastCall()[0]);
}

beforeEach(() => {
  (window as any).BOOTSTRAP_CONFIG = {
    gameEnv: "prod",
    numWorkers: 1,
    turnstileSiteKey: "x",
    jwtAudience: "openfront.io",
    instanceId: "test",
    gitCommit: "test",
    serverHost: SERVER_HOST,
  };
  ClientEnv.reset();
  fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ exists: true, gameID: "game-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as any).BOOTSTRAP_CONFIG;
  ClientEnv.reset();
  vi.clearAllMocks();
});

describe("createLobby", () => {
  it("creates the lobby on the configured game server", async () => {
    await createLobby();
    // No worker prefix: the edge (nginx in prod, the vite proxy in dev) picks
    // a worker, which mints a self-owned id.
    expect(lastUrl()).toBe(`https://${SERVER_HOST}/api/create_game`);
  });

  it("still sends the play token as the creator's identity", async () => {
    await createLobby();
    const init = lastCall()[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer play-token",
    );
  });
});

describe("resumeSavedLobby", () => {
  it("reopens the save on its worker without forcing by default", async () => {
    await resumeSavedLobby("game-1");
    expect(lastUrl()).toBe(
      `https://${SERVER_HOST}/${ClientEnv.workerPath("game-1")}/api/saves/game-1/resume`,
    );
  });

  it("asks the server to rebuild from the file when forcing an import", async () => {
    await resumeSavedLobby("game-1", { force: true });
    expect(lastUrl()).toBe(
      `https://${SERVER_HOST}/${ClientEnv.workerPath("game-1")}/api/saves/game-1/resume?force=1`,
    );
  });
});

describe("JoinLobbyModal.checkActiveLobby", () => {
  it("probes the configured game server for the lobby", async () => {
    const modal = new JoinLobbyModal();
    await (
      modal as unknown as {
        checkActiveLobby(id: string): Promise<boolean>;
      }
    ).checkActiveLobby("game-1");
    // The lobby existence probe goes to the configured game server. (A
    // restored save may add a follow-up seats probe; the exists call is what
    // this test pins.)
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toContain(
      `https://${SERVER_HOST}/${ClientEnv.workerPath("game-1")}/api/game/game-1/exists`,
    );
  });
});

describe("MatchmakingModal.checkGame", () => {
  it("polls the configured game server for the matched game", async () => {
    const modal = new MatchmakingModal();
    const internals = modal as unknown as {
      gameID: string | null;
      checkGame(): Promise<void>;
    };
    internals.gameID = "game-1";
    await internals.checkGame();
    expect(lastUrl()).toBe(
      `https://${SERVER_HOST}/${ClientEnv.workerPath("game-1")}/api/game/game-1/exists`,
    );
  });
});

// A self-hosted Fly machine is stopped while idle and replaced on deploy, so
// nginx answers 502/503/504 until the worker is back. Reporting that as "no
// saves" would look like the save was lost, so the listing retries the gateway
// error before giving up.
describe("listSavedLobbies gateway retry", () => {
  const summary = {
    gameID: "GAME0001",
    label: "World · host",
    createdAt: 1,
    savedAt: 2,
    stage: "started",
    numTurns: 10,
    playerCount: 2,
    gameMap: "World",
    gitCommit: "test",
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("rides out a transient 502 instead of reporting an empty list", async () => {
    let calls = 0;
    fetchMock.mockImplementation(async () => {
      calls++;
      if (calls === 1) return new Response("bad gateway", { status: 502 });
      return new Response(JSON.stringify({ saves: [summary] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const promise = listSavedLobbies();
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await promise;

    expect(calls).toBe(2);
    expect(result.errors).toEqual([]);
    expect(result.saves.map((s) => s.gameID)).toEqual(["GAME0001"]);
  });

  it("surfaces a persistent gateway error after the retries are exhausted", async () => {
    let calls = 0;
    fetchMock.mockImplementation(async () => {
      calls++;
      return new Response("bad gateway", { status: 502 });
    });

    const promise = listSavedLobbies();
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await promise;

    // Initial attempt + one per backoff delay, all on worker 0.
    expect(calls).toBe(5);
    expect(result.saves).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ worker: 0, status: 502 });
  });
});
