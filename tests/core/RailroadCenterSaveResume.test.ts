/**
 * Exhaustive save/resume regression test for the Railroad Center train-speed
 * boost (`TrainExecution.computeSpeed`, fractional `speed`, `speedAccumulator`).
 *
 * The targeted tests in `RailroadCenter.test.ts` and the single boosted case in
 * `CheckpointRail.test.ts` only round-trip an execution in memory for a handful
 * of ticks. This test drives a real, multi-segment boosted journey, captures
 * checkpoints at many ticks, sends every one through the REAL wire codec
 * (`encodeCheckpointWire`/`decodeCheckpointWire`), restores each into a fresh
 * game, and compares the ORIGINAL's per-tick state hash against the restored
 * copy for the whole remaining suffix.
 *
 * It deliberately:
 *   - builds a long rail (0 -> 60 -> 120) so a train crosses a station
 *     mid-journey (exercises `nextStation`/`leftOver` with fractional speed);
 *   - stacks two centers (level 1 + level 2 = 3 effective units) so the speed
 *     is genuinely fractional (2 * (1 + 0.375 ln 4) ~= 3.0397);
 *   - appends a center and spawns a SECOND train *after* some checkpoints, so
 *     the earlier checkpoints must replay the spawn and later ones must carry it
 *     in restored state;
 *   - asserts the raw `GameCheckpoint` (speed, speedAccumulator, currentTile,
 *     pathIndex, stations) survives the wire byte-for-byte;
 *   - compares the per-tick `GameImpl.hash()` (which folds every unit's tile,
 *     so a single wrong train step fails the test), not just the 10-tick
 *     periodic hash stream.
 */
import { describe, expect, test } from "vitest";
import {
  GameCheckpoint,
  TrainExecutionCheckpoint,
} from "../../src/core/Checkpoint";
import {
  decodeCheckpointWire,
  encodeCheckpointWire,
} from "../../src/core/CheckpointCodec";
import { SpawnExecution } from "../../src/core/execution/SpawnExecution";
import { TrainExecution } from "../../src/core/execution/TrainExecution";
import { WinCheckExecution } from "../../src/core/execution/WinCheckExecution";
import {
  Game,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "../../src/core/game/Game";
import { GameImpl } from "../../src/core/game/GameImpl";
import {
  packMotionPlans,
  TRAIN_SPEED_SCALE,
  TrainRailPathPlan,
  unpackMotionPlans,
} from "../../src/core/game/MotionPlans";
import { Railroad } from "../../src/core/game/Railroad";
import { TrainStation } from "../../src/core/game/TrainStation";
import { GameID } from "../../src/core/Schemas";
import { setup } from "../util/Setup";
import { executeTicks } from "../util/utils";

const gameID: GameID = "railcenter_cp";

// Rail layout: three city stations joined by two long segments, so the train
// crosses the middle station (exercising `nextStation`/`leftOver` with a
// fractional step).
const STATION_TILES = [0, 60, 120];
const RAIL_TILES = Array.from({ length: 121 }, (_, i) => i);

// Ticks at which the original captures a checkpoint (after that tick's state is
// current). Spans both sides of ACTION_TICK.
const CHECKPOINT_TICKS = [6, 12, 18, 24, 30, 36, 42, 48, 54];
// The second center + train are added when the game is at this tick, so any
// checkpoint at or before it must replay the addition.
const ACTION_TICK = 28;
const TOTAL_TICKS = 64;

interface RailGame {
  game: GameImpl;
  alphaId: string;
  stationIds: number[];
}

async function buildBase(): Promise<RailGame> {
  const game = (await setup("plains", {
    infiniteGold: true,
    instantBuild: true,
    infiniteTroops: true,
  })) as GameImpl;

  const alpha = new PlayerInfo(
    "alpha",
    PlayerType.Human,
    "client_alpha",
    "alpha_id",
  );
  game.addPlayer(alpha);

  game.addExecution(
    new SpawnExecution(gameID, game.player(alpha.id).info(), game.ref(0, 0)),
  );
  executeTicks(game, 2);
  game.addExecution(new WinCheckExecution());

  const player = game.player(alpha.id);
  // Own the whole rail corridor plus room off to the side for the centers.
  for (let tile = 0; tile <= 260; tile++) {
    player.conquer(tile);
  }

  const stations = STATION_TILES.map(
    (tile) => new TrainStation(game, player.buildUnit(UnitType.City, tile, {})),
  );
  const net = game.railNetwork();
  const stationManager = net.stationManager();
  stations.forEach((station) => stationManager.addStation(station));

  const link = (
    a: TrainStation,
    b: TrainStation,
    tiles: number[],
    id: number,
  ) => {
    const railroad = new Railroad(a, b, tiles, id);
    a.addRailroad(railroad);
    b.addRailroad(railroad);
  };
  link(stations[0], stations[1], RAIL_TILES.slice(0, 61), 1);
  link(stations[1], stations[2], RAIL_TILES.slice(60), 2);
  net.recomputeClusters();

  // Two centers for a fractional journey: a level-1 and a level-2 (which counts
  // as two level-1s), i.e. 3 effective units -> ~1.52x -> speed ~3.0397.
  player.buildUnit(UnitType.RailroadCenter, 200, {});
  player.buildUnit(UnitType.RailroadCenter, 210, {}).increaseLevel();

  // A train route spanning both segments.
  game.addExecution(
    new TrainExecution(net, player, stations[0], stations[2], 1),
  );

  return {
    game,
    alphaId: alpha.id,
    stationIds: stations.map((s) => s.id),
  };
}

function stateHash(game: Game): number {
  return (game as unknown as { hash(): number }).hash();
}

function trainData(game: Game): TrainExecutionCheckpoint[] {
  const cp = (game as GameImpl).checkpoint();
  if (cp === undefined) return [];
  return cp.executions
    .filter((e) => e.kind === "train")
    .map((e) => e.data as TrainExecutionCheckpoint);
}

function trainTiles(game: Game): number[] {
  return game
    .units(UnitType.Train)
    .map((u) => u.tile())
    .sort((a, b) => a - b);
}

/**
 * Apply the post-checkpoint action when the game is at `tick`. Runs in both the
 * original and every restored replay, so a checkpoint that predates the action
 * must replay it and a later one must already contain it.
 */
function applyAction(
  game: GameImpl,
  tick: number,
  alphaId: string,
  stationIds: number[],
): void {
  if (tick !== ACTION_TICK) return;
  const player = game.player(alphaId);
  // A new center raises the effective count to 4 (~1.603x) for trains spawned
  // from here on; existing trains keep their frozen speed.
  player.buildUnit(UnitType.RailroadCenter, 220, {});
  const manager = game.railNetwork().stationManager();
  const from = manager.getById(stationIds[1]);
  const to = manager.getById(stationIds[2]);
  if (from === undefined || to === undefined) {
    throw new Error("action: stations missing");
  }
  game.addExecution(
    new TrainExecution(game.railNetwork(), player, from, to, 1),
  );
}

interface Timeline {
  hashes: Map<number, number>;
  checkpoints: Map<number, GameCheckpoint>;
}

function runToEnd(
  game: GameImpl,
  alphaId: string,
  stationIds: number[],
  checkpoints: Map<number, GameCheckpoint>,
): Map<number, number> {
  const hashes = new Map<number, number>();
  hashes.set(game.ticks(), stateHash(game));
  while (game.ticks() < TOTAL_TICKS) {
    applyAction(game, game.ticks(), alphaId, stationIds);
    game.executeNextTick();
    const tick = game.ticks();
    hashes.set(tick, stateHash(game));
    if (CHECKPOINT_TICKS.includes(tick)) {
      const cp = game.checkpoint();
      expect(cp).toBeDefined();
      checkpoints.set(tick, cp!);
    }
  }
  return hashes;
}

function buildOriginal(): Promise<{ timeline: Timeline; railGame: RailGame }> {
  return buildBase().then((railGame) => {
    const checkpoints = new Map<number, GameCheckpoint>();
    const hashes = runToEnd(
      railGame.game,
      railGame.alphaId,
      railGame.stationIds,
      checkpoints,
    );
    return { timeline: { hashes, checkpoints }, railGame };
  });
}

describe("Railroad Center save/resume", () => {
  test("boosted, multi-segment journey survives wire checkpoints at every phase", async () => {
    const { timeline } = await buildOriginal();
    expect(timeline.checkpoints.size).toBeGreaterThanOrEqual(5);

    // Every captured boosted train must have a fractional speed in (2, 4], and
    // at least one checkpoint must catch a mid-step accumulator (> 0) — proof
    // the fractional-speed machinery is actually under test.
    let sawNonZeroAccumulator = false;
    for (const cp of timeline.checkpoints.values()) {
      for (const e of cp.executions) {
        if (e.kind !== "train") continue;
        const data = e.data as TrainExecutionCheckpoint;
        expect(data.speed).toBeGreaterThan(2);
        expect(data.speed).toBeLessThanOrEqual(4);
        if ((data.speedAccumulator ?? 0) > 0) sawNonZeroAccumulator = true;
      }
    }
    expect(sawNonZeroAccumulator).toBe(true);

    for (const [tick, cp] of timeline.checkpoints) {
      // ── Round-trip through the real wire save format ──────────────────
      const wire = await encodeCheckpointWire(cp);
      expect(wire).toBeDefined();
      const decoded = await decodeCheckpointWire(wire!);
      expect(decoded).toBeDefined();

      // The fractional-speed state must survive byte-for-byte: speed, the
      // accumulator, currentTile, pathIndex and the route station refs.
      const capturedTrains = cp.executions
        .filter((e) => e.kind === "train")
        .map((e) => e.data as TrainExecutionCheckpoint);
      const decodedTrains = decoded!.executions
        .filter((e) => e.kind === "train")
        .map((e) => e.data as TrainExecutionCheckpoint);
      expect(decodedTrains).toEqual(capturedTrains);

      // ── Restore into a fresh game and replay the suffix ───────────────
      const restoredGame = await buildBase();
      restoredGame.game.restoreFromCheckpoint(decoded!);
      expect(restoredGame.game.ticks()).toBe(tick);
      expect(stateHash(restoredGame.game)).toBe(timeline.hashes.get(tick));

      while (restoredGame.game.ticks() < TOTAL_TICKS) {
        applyAction(
          restoredGame.game,
          restoredGame.game.ticks(),
          restoredGame.alphaId,
          restoredGame.stationIds,
        );
        restoredGame.game.executeNextTick();
        const now = restoredGame.game.ticks();
        // Per-tick comparison: a single wrong fractional train step diverges
        // here, even between the 10-tick periodic hashes.
        expect(stateHash(restoredGame.game)).toBe(timeline.hashes.get(now));
      }
    }
  });

  test("a checkpoint after the action already contains the second (faster) train", async () => {
    const { timeline } = await buildOriginal();
    const after = timeline.checkpoints.get(30);
    expect(after).toBeDefined();
    const trains = after!.executions
      .filter((e) => e.kind === "train")
      .map((e) => e.data as TrainExecutionCheckpoint);
    // Two live trains, and the one spawned after ACTION_TICK is the faster of
    // the two (4 effective center units vs 3).
    expect(trains.length).toBeGreaterThanOrEqual(2);
    const speeds = trains.map((t) => t.speed).sort((a, b) => a - b);
    expect(speeds[speeds.length - 1]).toBeGreaterThan(speeds[0]);
  });

  test("restoring mid-journey keeps the exact accumulator and step schedule", async () => {
    const railGame = await buildBase();
    const { game: original, alphaId, stationIds } = railGame;

    // Run to the middle of the first segment, mid-fractional-step.
    while (original.ticks() < 20) {
      applyAction(original, original.ticks(), alphaId, stationIds);
      original.executeNextTick();
    }
    const captured = trainData(original).sort((a, b) => a.speed - b.speed);
    const cp = original.checkpoint();
    expect(cp).toBeDefined();
    const wire = await encodeCheckpointWire(cp!);
    const decoded = await decodeCheckpointWire(wire!);
    expect(decoded).toBeDefined();

    const restoredGame = await buildBase();
    restoredGame.game.restoreFromCheckpoint(decoded!);

    // The restored executions must reproduce the captured fractional state.
    expect(
      trainData(restoredGame.game).sort((a, b) => a.speed - b.speed),
    ).toEqual(captured);

    // Replay in lockstep and make sure the trains' tile sequences match for the
    // rest of the journey (crossing the middle station included).
    const originalTiles: number[][] = [];
    const restoredTiles: number[][] = [];
    while (original.ticks() < 60 && restoredGame.game.ticks() < 60) {
      original.executeNextTick();
      restoredGame.game.executeNextTick();
      originalTiles.push(trainTiles(original));
      restoredTiles.push(trainTiles(restoredGame.game));
    }
    expect(restoredTiles).toEqual(originalTiles);
    expect(originalTiles.some((t) => t.length > 0)).toBe(true);
  });
});

describe("train motion-plan wire (fractional speed)", () => {
  function plan(speed: number): TrainRailPathPlan {
    return {
      kind: "train",
      engineUnitId: 5,
      carUnitIds: [6, 7],
      planId: 1,
      startTick: 10,
      speed,
      spacing: 2,
      path: [1, 2, 3, 4, 5],
    };
  }

  test("a fractional speed keeps its scale-100 integer and the client recovers it", () => {
    const speed = 2 * (1 + 0.375 * Math.log(4)); // ~3.0397
    const [record] = unpackMotionPlans(packMotionPlans([plan(speed)]));
    expect(record?.kind).toBe("train");
    const decoded = record as TrainRailPathPlan;
    // Client: `speedScaled = Math.round(record.speed * TRAIN_SPEED_SCALE)`.
    expect(Math.round(decoded.speed * TRAIN_SPEED_SCALE)).toBe(
      Math.round(speed * TRAIN_SPEED_SCALE),
    );
    expect(Array.from(decoded.carUnitIds as ArrayLike<number>)).toEqual([6, 7]);
    expect(decoded.spacing).toBe(2);
    expect(Array.from(decoded.path as ArrayLike<number>)).toEqual([
      1, 2, 3, 4, 5,
    ]);
  });

  test("an integer speed round-trips exactly (backward compatible)", () => {
    const [record] = unpackMotionPlans(packMotionPlans([plan(2)]));
    expect((record as TrainRailPathPlan).speed).toBe(2);
  });
});
