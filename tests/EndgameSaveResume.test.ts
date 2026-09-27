/**
 * Endgame-scale save/resume harness.
 *
 * `LateGameSaveResume.test.ts` proves a single checkpoint round-trips through
 * the store and server on a moderately-late all-bot game. This file raises the
 * bar to the shape of a real two-hour game:
 *
 *   - a large live state (hundreds of players, >1000 units) rather than a stub;
 *   - explicit coverage assertions, so the test FAILS if the state it checks
 *     stops containing the execution kinds an endgame is made of;
 *   - repeated save -> resume -> save -> resume cycles, comparing each resumed
 *     segment against the uninterrupted run's hash stream;
 *   - a checkpoint reloaded through a *fresh* `FilesystemSaveStore` instance
 *     (what a server process restart does) and delivered as a server `start`
 *     frame;
 *   - an optional recorded-game mode that drives the REAL archived turns
 *     (with player intents) instead of empty turns, which is the only way to
 *     reach the nukes/MIRVs/alliances/tolls that human endgames produce.
 *
 * Run the default all-bot endgame:
 *
 *   $env:ENDGAME_TEST="1"; npx vitest run tests/EndgameSaveResume.test.ts
 *
 * Replay a real recorded two-hour game instead (path to a record JSON, or a
 * game id that the public API is queried for):
 *
 *   $env:ENDGAME_TEST="1"; $env:ENDGAME_RECORD="C:\path\to\record.json"; `
 *   $env:ENDGAME_TICKS="60000"; npx vitest run tests/EndgameSaveResume.test.ts
 *
 * Knobs (all optional):
 *   ENDGAME_MAP, ENDGAME_BOTS, ENDGAME_TICKS, ENDGAME_SUFFIX,
 *   ENDGAME_CYCLES, ENDGAME_MIN_UNITS, ENDGAME_REQUIRED_KINDS
 *
 * NOTE: on World/Medium a 400-bot game collapses to a single owner by ~tick
 * 40000, and never fires nukes. To exercise a genuine 3-4-owner, 2-hour,
 * entity-dense state, use ENDGAME_RECORD with a real game, or a bigger map /
 * team mode. The default 10000-tick checkpoint is a live 7-owner state.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { GameCheckpoint } from "../src/core/Checkpoint";
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
  GAME_ID_REGEX,
  GameConfig,
  GameRecord,
  GameRecordSchema,
  GameStartInfo,
  SAVED_LOBBY_VERSION,
  SavedLobby,
  SavedLobbySeat,
  Turn,
} from "../src/core/Schemas";
import { decompressGameRecord, toWireGameStartInfo } from "../src/core/Util";
import { createGameWireContext } from "../src/core/ZbinWire";
import { GameServer } from "../src/server/GameServer";
import { FilesystemSaveStore } from "../src/server/SaveStore";
import { NodeGameMapLoader } from "./perf/fullgame/NodeGameMapLoader";
import { makeClient, makeGame, mockWsOf } from "./util/GameServerHarness";

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const MAP = (process.env.ENDGAME_MAP as GameMapType) ?? GameMapType.World;
const BOTS = Number(process.env.ENDGAME_BOTS ?? 400);
const TICKS = Number(process.env.ENDGAME_TICKS ?? 10000);
const SUFFIX = Number(process.env.ENDGAME_SUFFIX ?? 120);
const CYCLES = Number(process.env.ENDGAME_CYCLES ?? 3);
const MIN_UNITS = Number(process.env.ENDGAME_MIN_UNITS ?? 500);
const RECORD = process.env.ENDGAME_RECORD;
const API_BASE = process.env.ENDGAME_API_BASE ?? "https://api.openfront.io";
// Execution kinds any live endgame must carry. Overridable because a different
// map/mode reaches a different mix; the default matches World/Medium.
const REQUIRED_KINDS = (
  process.env.ENDGAME_REQUIRED_KINDS ??
  "player,nation,trade_ship,port,city,factory,missile_silo,sam_launcher,train_station"
)
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

const GAME_ID = "endgm001";
const HOST_CID = "hostcid1";
const HOST_PID = "end-host-pid";

const botConfig: GameConfig = {
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

const botStart: GameStartInfo = {
  gameID: GAME_ID,
  lobbyCreatedAt: 1_700_000_000_000,
  config: botConfig,
  players: [
    {
      clientID: HOST_CID,
      username: "hostusr",
      clanTag: null,
      isLobbyCreator: true,
    },
    {
      clientID: "allycid1",
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

/**
 * Collect structural differences between two checkpoint objects, as JSON-ish
 * paths. Used to explain a re-captured-blob mismatch: the two encoded strings
 * are equivalent, but the byte comparison alone never says *which* field
 * diverged. Handles bigint, typed arrays and nested objects/arrays. Capped so a
 * wholesale divergence does not produce a megabyte of output.
 */
function checkpointDiffs(
  a: unknown,
  b: unknown,
  path = "$",
  out: string[] = [],
  limit = 25,
): string[] {
  if (out.length >= limit) return out;
  if (a === b) return out;
  if (typeof a === "bigint" || typeof b === "bigint") {
    out.push(
      `${path}: ${String(a)} (${typeof a}) != ${String(b)} (${typeof b})`,
    );
    return out;
  }
  if (
    a === null ||
    b === null ||
    typeof a !== "object" ||
    typeof b !== "object"
  ) {
    out.push(
      `${path}: ${JSON.stringify(a)} (${typeof a}) != ${JSON.stringify(b)} (${typeof b})`,
    );
    return out;
  }
  if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
    if (!(ArrayBuffer.isView(a) && ArrayBuffer.isView(b))) {
      out.push(`${path}: typed array vs ${JSON.stringify(b)?.slice(0, 40)}`);
      return out;
    }
    const av = a as ArrayBufferView;
    const bv = b as ArrayBufferView;
    const ab = new Uint8Array(av.buffer, av.byteOffset, av.byteLength);
    const bb = new Uint8Array(bv.buffer, bv.byteOffset, bv.byteLength);
    if (ab.length !== bb.length) {
      out.push(`${path}: byte length ${ab.length} != ${bb.length}`);
      return out;
    }
    for (let i = 0; i < ab.length && out.length < limit; i++) {
      if (ab[i] !== bb[i]) out.push(`${path}[byte ${i}]: ${ab[i]} != ${bb[i]}`);
    }
    return out;
  }
  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);
  if (aArr !== bArr) {
    out.push(`${path}: array vs object`);
    return out;
  }
  if (aArr && bArr) {
    const A = a as unknown[];
    const B = b as unknown[];
    if (A.length !== B.length) {
      out.push(`${path}.length: ${A.length} != ${B.length}`);
      return out;
    }
    for (let i = 0; i < A.length && out.length < limit; i++) {
      checkpointDiffs(A[i], B[i], `${path}[${i}]`, out, limit);
    }
    return out;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  for (const key of new Set([...Object.keys(ao), ...Object.keys(bo)])) {
    if (out.length >= limit) break;
    checkpointDiffs(ao[key], bo[key], `${path}.${key}`, out, limit);
  }
  return out;
}

/**
 * A headless core run driven by either empty turns (all-bot) or real archived
 * turns (recorded game), recording hash streams on demand.
 */
class Rig {
  hashes: number[] = [];
  stateHashes: number[] = [];
  private cursor = 0;
  private coreError: { message?: string } = {};

  private constructor(
    readonly runner: GameRunner,
    private readonly turns: Turn[],
  ) {}

  static async build(
    gameStart: GameStartInfo,
    mapLoader: NodeGameMapLoader,
    turns: Turn[] = [],
  ): Promise<Rig> {
    const error: { message?: string } = {};
    // The callback can fire while `createGameRunner` runs `init`, before the
    // rig exists, so route hashes through a holder that is filled in after.
    const sink: { rig?: Rig } = {};
    const runner = await createGameRunner(
      gameStart,
      undefined,
      mapLoader,
      (gu) => {
        if ("errMsg" in gu) {
          error.message = gu.errMsg;
          return;
        }
        for (const u of gu.updates[GameUpdateType.Hash] as HashUpdate[]) {
          sink.rig?.hashes.push(u.hash);
        }
      },
    );
    const rig = new Rig(runner, turns);
    sink.rig = rig;
    rig.coreError = error;
    return rig;
  }

  get game(): Game {
    return this.runner.game;
  }

  /** Position the turn cursor, e.g. before replaying a resumed suffix. */
  seek(turnNumber: number): void {
    this.cursor = turnNumber;
  }

  private emptyTurn(): Turn {
    return { turnNumber: this.cursor, intents: [] };
  }

  private takeTurn(): Turn {
    return this.cursor < this.turns.length
      ? this.turns[this.cursor]
      : this.emptyTurn();
  }

  /** Run `count` turns. Records the per-tick fingerprint only when asked. */
  run(count: number, recordState = false): void {
    for (let i = 0; i < count; i++) {
      const turn = this.takeTurn();
      this.cursor++;
      this.runner.addTurn(turn);
      const ok = this.runner.executeNextTick();
      if (!ok && this.coreError.message !== undefined) {
        throw new Error(`core tick failed: ${this.coreError.message}`);
      }
      if (recordState) this.stateHashes.push(stateHash(this.game));
    }
  }

  /** Run until the spawn phase ends; returns turns consumed (bot mode). */
  runSpawn(): number {
    let n = 0;
    while (this.game.inSpawnPhase()) {
      if (n > 2000)
        throw new Error("spawn phase did not end within 2000 ticks");
      const turn = this.takeTurn();
      this.cursor++;
      this.runner.addTurn(turn);
      this.runner.executeNextTick();
      n++;
    }
    return n;
  }

  clearStreams(): void {
    this.hashes.length = 0;
    this.stateHashes.length = 0;
  }
}

async function loadRecord(source: string): Promise<GameRecord> {
  let raw: unknown;
  if (fs.existsSync(source)) {
    raw = JSON.parse(fs.readFileSync(source, "utf8"));
  } else {
    // The public archive lives under /public/game/:id (docs/API.md). The bare
    // /game/:id path is not served and returns 403, which made record mode
    // unusable from a game id.
    const url = `${API_BASE}/public/game/${source}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`failed to fetch record: HTTP ${res.status}`);
    raw = await res.json();
  }
  const parsed = GameRecordSchema.safeParse(raw);
  return parsed.success ? parsed.data : (raw as GameRecord);
}

// The save store only accepts this fork's 8-char `ID`, but archived public
// records carry the upstream 10-char game id (e.g. "dKLqTLUg9j"). Map any
// record id onto a stable 8-char id (same record -> same id) so a real record
// can be persisted through the real store. The replay stays internally
// consistent because the source and every restored run share this id; only the
// exact production id is dropped.
function wireGameId(gameID: string): string {
  if (gameID.length === 8 && GAME_ID_REGEX.test(gameID)) return gameID;
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let state = 2166136261 >>> 0;
  for (let i = 0; i < gameID.length; i++) {
    state ^= gameID.charCodeAt(i);
    state = Math.imul(state, 16777619) >>> 0;
  }
  let out = "";
  for (let i = 0; i < 8; i++) {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    out += alphabet[state % alphabet.length];
  }
  return out;
}

const temporaryDirs: string[] = [];
afterAll(() => {
  for (const dir of temporaryDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

interface EndgameState {
  gameStart: GameStartInfo;
  turns: Turn[];
  gameType: GameType;
  checkpointTick: number;
  wire: string;
  checkpointStateHash: number;
}

/** Drive the source run to the checkpoint and assert it is entity-rich. */
async function buildEndgame(
  mapLoader: NodeGameMapLoader,
): Promise<{ state: EndgameState; source: Rig }> {
  let gameStart = botStart;
  let turns: Turn[] = [];
  if (RECORD !== undefined) {
    const record = decompressGameRecord(await loadRecord(RECORD));
    const info = record.info;
    const replayId = wireGameId(info.gameID);
    gameStart = toWireGameStartInfo({
      gameID: replayId,
      lobbyCreatedAt: info.lobbyCreatedAt,
      config: info.config,
      players: info.players,
      tribes: info.tribes,
    });
    turns = record.turns;
    console.log(
      `[endgame] record ${info.gameID} -> ${replayId}: ` +
        `${info.config.gameMap} ${info.config.gameMode}, ` +
        `${info.players.length} players, ${turns.length} turns`,
    );
  }

  const source = await Rig.build(gameStart, mapLoader, turns);
  if (turns.length > 0) {
    source.run(Math.min(TICKS, turns.length));
  } else {
    source.runSpawn();
    source.run(TICKS);
  }

  const game = source.game;
  const checkpointTick = game.ticks();
  const checkpoint = source.runner.checkpoint();
  if (checkpoint === undefined) {
    const unsupported = game
      .executions()
      .filter(
        (e) => typeof (e as { checkpoint?: unknown }).checkpoint !== "function",
      )
      .map((e) => e.constructor.name);
    throw new Error(
      `checkpoint() returned undefined at tick ${checkpointTick}; ` +
        `executions without checkpoint(): ${unsupported.join(", ")}`,
    );
  }

  const alive = game.allPlayers().filter((p) => p.isAlive()).length;
  const kinds = new Map<string, number>();
  for (const e of checkpoint.executions) {
    kinds.set(e.kind, (kinds.get(e.kind) ?? 0) + 1);
  }
  console.log(
    `[endgame] tick=${checkpointTick} players=${checkpoint.players.length} ` +
      `alive=${alive} units=${checkpoint.units.length} ` +
      `attacks=${checkpoint.attacks.length} ` +
      `alliances=${checkpoint.alliances.length} ` +
      `kinds=${[...kinds.keys()].sort().join(",")}`,
  );

  // Coverage assertions: this must be a real, entity-rich endgame.
  expect(checkpoint.units.length).toBeGreaterThanOrEqual(MIN_UNITS);
  for (const kind of REQUIRED_KINDS) {
    expect(kinds.has(kind), `endgame checkpoint is missing ${kind}`).toBe(true);
  }
  if (turns.length === 0) {
    expect(checkpoint.players.length).toBeGreaterThanOrEqual(BOTS);
  }

  const wire = await encodeCheckpointWire(checkpoint);
  return {
    state: {
      gameStart,
      turns,
      gameType: gameStart.config.gameType,
      checkpointTick,
      wire: wire!,
      checkpointStateHash: stateHash(game),
    },
    source,
  };
}

describe.skipIf(process.env.ENDGAME_TEST !== "1")(
  "endgame save/resume at scale",
  () => {
    test("repeated save/resume cycles replay the endgame identically", async () => {
      const mapLoader = new NodeGameMapLoader(
        path.join(PROJECT_ROOT, "resources/maps"),
      );
      const { state, source } = await buildEndgame(mapLoader);

      // ── Uninterrupted run: record each suffix segment + its checkpoint ──
      // The uninterrupted source and the resumed games run in separate phases,
      // never interleaved: the trade/transport pathfinder stagger is a
      // process-global counter, so two games ticking in one process would draw
      // from the same counter. Each resume restores the counter from the
      // checkpoint first, so a clean phase reproduces the source's slots.
      const expectedState: number[][] = [];
      const expectedPeriodic: number[][] = [];
      const segmentWires: string[] = [];
      const expectedCps: GameCheckpoint[] = [];
      for (let c = 0; c < CYCLES; c++) {
        source.clearStreams();
        source.run(SUFFIX, true);
        expectedState.push([...source.stateHashes]);
        expectedPeriodic.push([...source.hashes]);
        const cp = source.runner.checkpoint();
        expect(cp, `uninterrupted checkpoint ${c + 1}`).toBeDefined();
        expectedCps.push(cp!);
        segmentWires.push((await encodeCheckpointWire(cp!))!);
      }

      // ── Resume chain: restore each checkpoint into a fresh game ─────────
      let wire = state.wire;
      let checkpointHash = state.checkpointStateHash;
      for (let c = 0; c < CYCLES; c++) {
        const decoded = await decodeCheckpointWire(wire);
        expect(decoded, `cycle ${c} decode`).toBeDefined();
        const resumed = await Rig.build(
          state.gameStart,
          mapLoader,
          state.turns,
        );
        // Replay mode must feed the same intents in the suffix, so seek the
        // fresh rig to the checkpoint before running the segment.
        resumed.seek(decoded!.ticks);
        resumed.runner.restoreFromCheckpoint(decoded!);
        // Capture the restored game before it ticks again. If this differs from
        // the decoded blob, the asymmetry is in capture/restore itself.
        const recaptured = resumed.runner.checkpoint();
        if (recaptured !== undefined) {
          const diffs = checkpointDiffs(decoded!, recaptured);
          if (diffs.length > 0) {
            console.log(
              `[endgame] cycle ${c} immediate re-capture diffs (${diffs.length}):\n  ` +
                diffs.join("\n  "),
            );
          }
        }
        expect(stateHash(resumed.game), `cycle ${c} checkpoint hash`).toBe(
          checkpointHash,
        );

        resumed.clearStreams();
        resumed.run(SUFFIX, true);
        expect(resumed.stateHashes, `cycle ${c} per-tick`).toEqual(
          expectedState[c],
        );
        expect(resumed.hashes, `cycle ${c} periodic`).toEqual(
          expectedPeriodic[c],
        );

        // A checkpoint taken from the resumed run must drive the next cycle, and
        // must structurally match the uninterrupted run's checkpoint at the same
        // tick. The comparison is structural: the encoded bytes are also
        // sensitive to JSON key insertion order, which is not deterministic
        // state.
        const next = resumed.runner.checkpoint();
        expect(next, `cycle ${c} next checkpoint`).toBeDefined();
        const nextWire = (await encodeCheckpointWire(next!))!;
        const blobDiffs = checkpointDiffs(expectedCps[c], next!);
        expect(
          blobDiffs,
          `cycle ${c} re-captured checkpoint differs:\n  ${blobDiffs.join("\n  ")}`,
        ).toEqual([]);
        if (nextWire !== segmentWires[c]) {
          console.log(
            `[endgame] cycle ${c} note: re-captured wire differs only by ` +
              `encoding order (structurally equal)`,
          );
        }
        wire = nextWire;
        checkpointHash = stateHash(resumed.game);
      }

      // ── Persist + reload through a FRESH store (server restart) ─────────
      const finalTick = state.checkpointTick + SUFFIX * CYCLES;
      const seats: SavedLobbySeat[] = state.gameStart.players.map((p) => ({
        clientID: p.clientID,
        username: p.username,
        clanTag: p.clanTag,
        cosmetics: p.cosmetics,
        isLobbyCreator: p.isLobbyCreator,
        friends: p.friends,
        teamIndex: p.teamIndex,
        persistentID: p.clientID === HOST_CID ? HOST_PID : `${p.clientID}-pid`,
        trusted: false,
        spectator: false,
      }));
      const savedTurns: Turn[] = Array.from({ length: finalTick }, (_, i) => ({
        turnNumber: i,
        intents: [],
      }));
      const save: SavedLobby = {
        version: SAVED_LOBBY_VERSION,
        gameID: state.gameStart.gameID,
        createdAt: state.gameStart.lobbyCreatedAt,
        creatorPersistentID: HOST_PID,
        gameConfig: state.gameStart.config,
        stage: "started",
        seats,
        gameStartInfo: state.gameStart,
        turns: savedTurns,
        checkpoint: segmentWires[segmentWires.length - 1],
        checkpointTurn: finalTick,
        savedAt: Date.now(),
        gitCommit: "DEV",
      };
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "endgame-"));
      temporaryDirs.push(dir);
      await new FilesystemSaveStore(dir).save(save, 0);
      const reloaded = await new FilesystemSaveStore(dir).load(
        state.gameStart.gameID,
      );
      expect(reloaded).not.toBeNull();
      expect(reloaded!.checkpoint).toBe(save.checkpoint);
      expect(reloaded!.checkpointTurn).toBe(finalTick);
      expect(reloaded!.turns.length).toBe(finalTick);

      // ── Server delivers checkpoint + suffix as a start frame (private) ──
      if (state.gameType === GameType.Private) {
        const prevDelay = GameServer.RESUME_START_DELAY_MS;
        GameServer.RESUME_START_DELAY_MS = 5;
        try {
          const restored = makeGame({
            id: state.gameStart.gameID,
            restore: reloaded!,
            buildHash: "DEV",
          });
          const host = makeClient({
            clientID: HOST_CID,
            persistentID: HOST_PID,
            username: "hostusr",
          });
          expect(restored.joinClient(host, HOST_CID)).toBe("joined");
          await new Promise((resolve) => setTimeout(resolve, 50));

          const ctx = createGameWireContext(state.gameStart.players);
          const start = mockWsOf(host)
            .sent(ctx)
            .find((m) => m.type === "start");
          expect(start, "server start frame").toBeDefined();
          if (start?.type !== "start") return;
          expect(start.checkpoint).toBe(save.checkpoint);
          expect(start.myClientID).toBe(HOST_CID);
          const fromServer = await decodeCheckpointWire(start.checkpoint!);
          expect(fromServer?.ticks).toBe(finalTick);
        } finally {
          GameServer.RESUME_START_DELAY_MS = prevDelay;
        }
      }
    }, 1_800_000); // A long endgame is minutes of simulation, not milliseconds.
  },
);
