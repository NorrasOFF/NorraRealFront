/**
 * End-to-end save -> store -> load -> resume test on a real medium/large map in
 * a late-game state with many entities.
 *
 * The existing save/resume tests only round-trip a structural stub checkpoint
 * (`{map:{}, players:[]}`), so a real late-game checkpoint (huge map buffers,
 * bigints, thousands of units/attacks/nations) never exercised the chain. This
 * test drives the REAL deterministic core:
 *
 *   1. Build a real game on `resources/maps/<map>` (nations + bots), run it to a
 *      late-game tick T with many entities.
 *   2. Capture a real `GameImpl.checkpoint()` and encode it with the real wire
 *      codec (plain or `gz:` gzip).
 *   3. Keep running the original for SUFFIX_TICKS, recording per-tick state
 *      hashes and the periodic hash stream.
 *   4. Restore the checkpoint into a fresh identical game and replay the suffix;
 *      assert both hash streams match the uninterrupted run (bit-identical).
 *   5. Persist a real `SavedLobby` through a `FilesystemSaveStore`, load it back,
 *      restore a `GameServer` from it, join the host seat and assert the `start`
 *      frame the server sends carries the checkpoint and only the suffix turns.
 *   6. Decode the checkpoint out of that start frame (what the browser does) to
 *      prove the client receives a usable blob.
 *
 * Run (defaults: world, 100 bots, 1200 game ticks after spawn):
 *
 *   $env:LATEGAME_TEST="1"; npx vitest run tests/LateGameSaveResume.test.ts
 *
 * Scale it up / pick a larger map:
 *
 *   $env:LATEGAME_TEST="1"; $env:LATEGAME_MAP="giantworldmap"; `
 *   $env:LATEGAME_BOTS="200"; $env:LATEGAME_TICKS="1800"; `
 *   npx vitest run tests/LateGameSaveResume.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import {
  decodeCheckpointWire,
  encodeCheckpointWire,
} from "../src/core/CheckpointCodec";
import {
  Difficulty,
  Game,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
} from "../src/core/game/Game";
import { GameUpdateType, HashUpdate } from "../src/core/game/GameUpdates";
import { createGameRunner, GameRunner } from "../src/core/GameRunner";
import {
  GameConfig,
  GameStartInfo,
  SAVED_LOBBY_VERSION,
  SavedLobby,
  SavedLobbySeat,
  Turn,
} from "../src/core/Schemas";
import { createGameWireContext } from "../src/core/ZbinWire";
import { GameServer } from "../src/server/GameServer";
import { FilesystemSaveStore } from "../src/server/SaveStore";
import { NodeGameMapLoader } from "./perf/fullgame/NodeGameMapLoader";
import { makeClient, makeGame, mockWsOf } from "./util/GameServerHarness";

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

// Scale knobs. Defaults are a genuine late game on the medium-large World map
// (~2M tiles, default nations + 100 bots).
const MAP = (process.env.LATEGAME_MAP as GameMapType) ?? GameMapType.World;
const BOTS = Number(process.env.LATEGAME_BOTS ?? 100);
const GAME_TICKS = Number(process.env.LATEGAME_TICKS ?? 1200);
// Suffix replayed after the checkpoint; kept short so the golden comparison
// covers a live window without another long run.
const SUFFIX_TICKS = 60;

// Schema-valid ids (8 alphanumerics) so the real wire encoder accepts them.
const GAME_ID = "late0001";
const HOST_CID = "hostcid1";
const ALLY_CID = "allycid1";
const HOST_PID = "late-host-pid";
const ALLY_PID = "late-ally-pid";

const gameConfig: GameConfig = {
  gameMap: MAP,
  difficulty: Difficulty.Medium,
  donateGold: false,
  donateTroops: false,
  gameType: GameType.Private,
  gameMode: GameMode.FFA,
  gameMapSize: GameMapSize.Normal,
  nations: "default",
  bots: BOTS,
  infiniteGold: false,
  infiniteTroops: false,
  instantBuild: false,
  randomSpawn: true,
};

const gameStart: GameStartInfo = {
  gameID: GAME_ID,
  lobbyCreatedAt: 1_700_000_000_000,
  config: gameConfig,
  players: [
    {
      clientID: HOST_CID,
      username: "hostusr",
      clanTag: null,
      isLobbyCreator: true,
    },
    {
      clientID: ALLY_CID,
      username: "allyusr",
      clanTag: null,
      isLobbyCreator: false,
    },
  ],
};

/** `GameImpl.hash()` is not on the `Game` interface; reach it by cast. */
function stateHash(game: Game): number {
  return (game as unknown as { hash(): number }).hash();
}

interface CoreRun {
  runner: GameRunner;
  /** Periodic hashes (every 10 ticks), as the wire/DesyncDetector sees them. */
  hashes: number[];
  /** Cheap per-tick fingerprint, to catch a divergence between periodic hashes. */
  stateHashes: number[];
  tick(turnNumber: number): void;
}

async function buildCore(): Promise<CoreRun> {
  const loader = new NodeGameMapLoader(
    path.join(PROJECT_ROOT, "resources/maps"),
  );
  const hashes: number[] = [];
  const stateHashes: number[] = [];
  let coreError: string | undefined;
  const runner = await createGameRunner(gameStart, undefined, loader, (gu) => {
    if ("errMsg" in gu) {
      coreError = gu.errMsg;
      return;
    }
    const hashUpdates = gu.updates[GameUpdateType.Hash] as HashUpdate[];
    for (const update of hashUpdates) {
      hashes.push(update.hash);
    }
  });
  return {
    runner,
    hashes,
    stateHashes,
    tick(turnNumber: number) {
      runner.addTurn({ turnNumber, intents: [] });
      const ok = runner.executeNextTick();
      if (!ok && coreError !== undefined) {
        throw new Error(`core tick failed: ${coreError}`);
      }
      stateHashes.push(stateHash(runner.game));
    },
  };
}

function runSpawn(run: CoreRun): number {
  let n = 0;
  while (run.runner.game.inSpawnPhase()) {
    if (n > 2000) {
      throw new Error("spawn phase did not end within 2000 ticks");
    }
    run.tick(n++);
  }
  return n;
}

const temporaryDirs: string[] = [];
afterAll(() => {
  for (const dir of temporaryDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe.skipIf(process.env.LATEGAME_TEST !== "1")(
  "late-game private save/resume",
  () => {
    test("checkpoint survives store + server resume and replays identically", async () => {
      // ── 1. Real late-game simulation ────────────────────────────────────
      const run = await buildCore();
      const spawnTicks = runSpawn(run);
      for (let i = 0; i < GAME_TICKS; i++) {
        run.tick(spawnTicks + i);
      }
      const game = run.runner.game;
      const checkpointTick = game.ticks();

      const alive = game.allPlayers().filter((p) => p.isAlive()).length;
      const units = game.units().length;
      const alliances = game
        .allPlayers()
        .reduce((sum, p) => sum + p.alliances().length, 0);
      const attacks = game
        .allPlayers()
        .reduce((sum, p) => sum + p.outgoingAttacks().length, 0);
      console.log(
        `[late-game] map=${MAP} tick=${checkpointTick} ` +
          `players=${game.players().length} alive=${alive} units=${units} ` +
          `attacks=${attacks} alliances=${alliances}`,
      );
      expect(checkpointTick).toBe(spawnTicks + GAME_TICKS);
      expect(units).toBeGreaterThan(0);

      // ── 2. Capture + encode a real checkpoint ───────────────────────────
      const checkpoint = run.runner.checkpoint();
      if (checkpoint === undefined) {
        const unsupported = game
          .executions()
          .filter(
            (e) =>
              typeof (e as { checkpoint?: unknown }).checkpoint !== "function",
          )
          .map((e) => e.constructor.name);
        throw new Error(
          `GameImpl.checkpoint() returned undefined at a late-game tick; ` +
            `live executions without checkpoint(): ${unsupported.join(", ")}`,
        );
      }
      const wire = await encodeCheckpointWire(checkpoint);
      expect(wire).toBeDefined();
      console.log(
        `[late-game] checkpoint ticks=${checkpoint.ticks} ` +
          `wire=${wire!.length} chars gzip=${wire!.startsWith("gz:")} ` +
          `players=${checkpoint.players.length} units=${checkpoint.units.length} ` +
          `attacks=${checkpoint.attacks.length} execs=${checkpoint.executions.length}`,
      );

      // ── 3. Continue the original, recording the suffix hash stream ──────
      const checkpointStateHash = stateHash(game);
      run.hashes.length = 0;
      run.stateHashes.length = 0;
      for (let i = 0; i < SUFFIX_TICKS; i++) {
        run.tick(checkpointTick + i);
      }
      const expectedHashes = [...run.hashes];
      const expectedStateHashes = [...run.stateHashes];
      expect(expectedHashes.length).toBeGreaterThan(0);

      // ── 4. Restore into a fresh identical game and replay the suffix ────
      const decoded = await decodeCheckpointWire(wire!);
      expect(decoded).toBeDefined();
      const restoredRun = await buildCore();
      restoredRun.runner.restoreFromCheckpoint(decoded!);
      expect(restoredRun.runner.game.ticks()).toBe(checkpointTick);
      // The restored state must be bit-identical at the checkpoint itself...
      expect(stateHash(restoredRun.runner.game)).toBe(checkpointStateHash);
      for (let i = 0; i < SUFFIX_TICKS; i++) {
        restoredRun.tick(checkpointTick + i);
      }
      // ...and every tick after it (per-tick first, then the periodic stream
      // the wire/DesyncDetector actually compares).
      expect(restoredRun.stateHashes).toEqual(expectedStateHashes);
      expect(restoredRun.hashes).toEqual(expectedHashes);

      // ── 5. Persist + load a real SavedLobby through the server store ────
      const seats: SavedLobbySeat[] = gameStart.players.map((p) => ({
        clientID: p.clientID,
        username: p.username,
        clanTag: p.clanTag,
        cosmetics: p.cosmetics,
        isLobbyCreator: p.isLobbyCreator,
        friends: p.friends,
        teamIndex: p.teamIndex,
        persistentID: p.clientID === HOST_CID ? HOST_PID : ALLY_PID,
        trusted: false,
        spectator: false,
      }));
      const finalTick = checkpointTick + SUFFIX_TICKS;
      const turns: Turn[] = Array.from({ length: finalTick }, (_, i) => ({
        turnNumber: i,
        intents: [],
      }));
      const save: SavedLobby = {
        version: SAVED_LOBBY_VERSION,
        gameID: GAME_ID,
        createdAt: gameStart.lobbyCreatedAt,
        creatorPersistentID: HOST_PID,
        gameConfig,
        stage: "started",
        seats,
        gameStartInfo: gameStart,
        turns,
        checkpoint: wire!,
        checkpointTurn: checkpointTick,
        savedAt: Date.now(),
        gitCommit: "DEV",
      };

      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "late-save-"));
      temporaryDirs.push(dir);
      const store = new FilesystemSaveStore(dir);
      await store.save(save, 0);
      const loaded = await store.load(GAME_ID);
      expect(loaded).not.toBeNull();
      expect(loaded!.checkpoint).toBe(wire);
      expect(loaded!.checkpointTurn).toBe(checkpointTick);
      expect(loaded!.turns.length).toBe(finalTick);

      // ── 6. Restore a GameServer and inspect the resume start frame ──────
      const prevDelay = GameServer.RESUME_START_DELAY_MS;
      GameServer.RESUME_START_DELAY_MS = 5;
      try {
        const restored = makeGame({
          id: GAME_ID,
          restore: loaded!,
          buildHash: "DEV",
        });
        expect(restored.isRestored()).toBe(true);
        expect(restored.snapshot()?.checkpoint).toBe(wire);
        expect(restored.snapshot()?.checkpointTurn).toBe(checkpointTick);

        const host = makeClient({
          clientID: HOST_CID,
          persistentID: HOST_PID,
          username: "hostusr",
        });
        expect(restored.joinClient(host, HOST_CID)).toBe("joined");
        // Let the resume countdown elapse and the start frame be sent.
        await new Promise((resolve) => setTimeout(resolve, 50));

        const ctx = createGameWireContext(gameStart.players);
        const start = mockWsOf(host)
          .sent(ctx)
          .find((m) => m.type === "start");
        expect(start).toBeDefined();
        if (start?.type !== "start") return;
        expect(start.checkpoint).toBe(wire);
        expect(start.myClientID).toBe(HOST_CID);
        // Only the suffix after the checkpoint, not the whole history.
        expect(start.turns.length).toBe(SUFFIX_TICKS);
        expect(start.turns[0].turnNumber).toBe(checkpointTick);
        expect(start.turns[start.turns.length - 1].turnNumber).toBe(
          finalTick - 1,
        );

        // The browser decodes `message.checkpoint`; make sure it is usable.
        const fromServer = await decodeCheckpointWire(start.checkpoint!);
        expect(fromServer?.ticks).toBe(checkpointTick);
        console.log(
          `[late-game] server start frame: checkpoint=${start.checkpoint!.length} chars ` +
            `suffixTurns=${start.turns.length} fromTurn=${start.turns[0].turnNumber}`,
        );
      } finally {
        GameServer.RESUME_START_DELAY_MS = prevDelay;
      }
    }, // A late game on World/Giant is minutes of simulation, not milliseconds.
    600_000);
  },
);
