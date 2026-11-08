/**
 * Entity-stress performance benchmark.
 *
 * Builds a dense late-game-like state on a headless test map:
 *   - two players with adjacent territory,
 *   - a few hundred factories/cities wired into a rail network,
 *   - hundreds of defense posts (varied levels) covering the attack front,
 *   - a target number of live trains (each with 5 cars = 7 units),
 *   - a sustained attack against the defended frontier.
 *
 * By default one defense post's construction flag is flipped every tick. That
 * changes AttackExecution's deterministic defense-post signature every tick, so
 * every attack tick performs a full `retier()` of its conquest heap - the
 * worst case for the defense-tier mechanism.
 *
 * Reports per-tick wall time, unit/station counts, optional execution/CPU/GC
 * profiles, and checkpoint capture/encode time + size (the "large autosave"
 * side). The final checkpoint hash is printed so baseline and optimized builds
 * can be compared for identical simulation state.
 *
 * Usage:
 *   npx tsx tests/perf/entity/EntityStressPerf.ts
 *   npx tsx tests/perf/entity/EntityStressPerf.ts --ticks 600 --posts 300 \
 *       --buildings 160 --trains 120
 *
 * Flags: --ticks --posts --buildings --trains --train-min-dist --map --seed
 *        --toggle-post / --no-toggle-post --attack-troops
 *        --profile --cpu-profile --gc --no-checkpoint
 */
import path from "path";
import { performance } from "perf_hooks";
import { fileURLToPath } from "url";
import { GameCheckpoint } from "../../../src/core/Checkpoint";
import {
  encodeCheckpoint,
  encodeCheckpointWire,
} from "../../../src/core/CheckpointCodec";
import { Config } from "../../../src/core/configuration/Config";
import { AttackExecution } from "../../../src/core/execution/AttackExecution";
import { DefensePostExecution } from "../../../src/core/execution/DefensePostExecution";
import { FactoryExecution } from "../../../src/core/execution/FactoryExecution";
import { TrainExecution } from "../../../src/core/execution/TrainExecution";
import {
  Game,
  Player,
  PlayerInfo,
  PlayerType,
  Unit,
  UnitType,
} from "../../../src/core/game/Game";
import { TileRef } from "../../../src/core/game/GameMap";
import { PseudoRandom } from "../../../src/core/PseudoRandom";
import { simpleHash } from "../../../src/core/Util";
import { setup } from "../../util/Setup";
import { TestConfig } from "../../util/TestConfig";
import { GcTracker, summarizeGcEvents } from "../fullgame/GcProfiler";
import {
  CpuProfiler,
  ExecutionProfiler,
  summarizeCpuProfile,
  TickStats,
} from "../fullgame/Profiler";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Keep the real attack formula (including the reusable result object) while
// skipping nav-mesh construction, which is unrelated to unit/tick work.
class StressConfig extends Config {
  disableNavMesh(): boolean {
    return true;
  }
}

interface Options {
  ticks: number;
  posts: number;
  buildings: number;
  trains: number;
  trainMinDist: number;
  map: string;
  seed: string;
  togglePost: boolean;
  attackTroops: number;
  execProfile: boolean;
  cpuProfile: boolean;
  gcProfile: boolean;
  checkpoint: boolean;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    ticks: 600,
    posts: 320,
    buildings: 160,
    trains: 120,
    trainMinDist: 80,
    map: "big_plains",
    seed: "entity-stress",
    togglePost: true,
    attackTroops: 150_000,
    execProfile: false,
    cpuProfile: false,
    gcProfile: false,
    checkpoint: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`missing value for ${arg}`);
      return value;
    };
    switch (arg) {
      case "--ticks":
        opts.ticks = parseInt(next(), 10);
        break;
      case "--posts":
        opts.posts = parseInt(next(), 10);
        break;
      case "--buildings":
        opts.buildings = parseInt(next(), 10);
        break;
      case "--trains":
        opts.trains = parseInt(next(), 10);
        break;
      case "--train-min-dist":
        opts.trainMinDist = parseInt(next(), 10);
        break;
      case "--map":
        opts.map = next();
        break;
      case "--seed":
        opts.seed = next();
        break;
      case "--toggle-post":
        opts.togglePost = true;
        break;
      case "--no-toggle-post":
        opts.togglePost = false;
        break;
      case "--attack-troops":
        opts.attackTroops = parseInt(next(), 10);
        break;
      case "--profile":
        opts.execProfile = true;
        break;
      case "--cpu-profile":
        opts.cpuProfile = true;
        break;
      case "--gc":
        opts.gcProfile = true;
        break;
      case "--no-checkpoint":
        opts.checkpoint = false;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

function fmtMs(ms: number): string {
  return ms >= 100 ? ms.toFixed(0) : ms >= 10 ? ms.toFixed(1) : ms.toFixed(2);
}

function fmtMB(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  return mb >= 100 ? mb.toFixed(0) : mb >= 10 ? mb.toFixed(1) : mb.toFixed(2);
}

function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, c) =>
    Math.max(h.length, ...rows.map((r) => r[c].length)),
  );
  const line = (cells: string[]) =>
    cells.map((cell, c) => cell.padEnd(widths[c])).join("  ");
  return [line(headers), line(widths.map((w) => "-".repeat(w)))]
    .concat(rows.map(line))
    .join("\n");
}

function conquerRect(
  game: Game,
  player: Player,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
): void {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const tile = game.ref(x, y);
      if (game.isLand(tile) && !game.isImpassable(tile)) {
        player.conquer(tile);
      }
    }
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  console.debug = () => {};

  const defenderInfo = new PlayerInfo(
    "Defender",
    PlayerType.Human,
    null,
    "Defender",
  );
  const attackerInfo = new PlayerInfo(
    "Attacker",
    PlayerType.Human,
    null,
    "Attacker",
  );

  const game = await setup(
    opts.map,
    {
      infiniteGold: true,
      infiniteTroops: true,
      instantBuild: true,
      disableNavMesh: true,
    },
    [defenderInfo, attackerInfo],
    undefined,
    StressConfig as unknown as typeof TestConfig,
  );

  const defender = game.player(defenderInfo.id)!;
  const attacker = game.player(attackerInfo.id)!;

  const width = game.width();
  const height = game.height();

  // Territory: attacker owns the left 25%, defender the rest. The shared
  // vertical border is the attack front.
  const frontX = Math.floor(width / 4);
  conquerRect(game, attacker, 0, frontX - 1, 0, height - 1);
  conquerRect(game, defender, frontX, width - 1, 0, height - 1);

  const used = new Set<TileRef>();
  const markUsed = (x: number, y: number): TileRef | null => {
    if (x < 0 || y < 0 || x >= width || y >= height) return null;
    const tile = game.ref(x, y);
    if (used.has(tile) || !game.isLand(tile) || game.isImpassable(tile)) {
      return null;
    }
    used.add(tile);
    return tile;
  };

  // ── Rail network: factories (spawn trains) and cities (destinations) ──
  const factories: Unit[] = [];
  const cities: Unit[] = [];
  let built = 0;
  const buildingStep = 14;
  for (let y = 6; y < height - 4 && built < opts.buildings; y += buildingStep) {
    for (
      let x = frontX + 6;
      x < width - 4 && built < opts.buildings;
      x += buildingStep
    ) {
      const tile = markUsed(x, y);
      if (tile === null) continue;
      const isFactory = built % 2 === 0;
      const unit = defender.buildUnit(
        isFactory ? UnitType.Factory : UnitType.City,
        tile,
        {},
      );
      if (isFactory) {
        factories.push(unit);
        game.addExecution(new FactoryExecution(unit));
      } else {
        cities.push(unit);
      }
      built++;
    }
  }

  // Railroad Centers boost train speed/spawn throughput (cap is 5 levels).
  const centers: Unit[] = [];
  for (let i = 0; i < 5; i++) {
    const tile = markUsed(frontX + 8 + i * 14, 4);
    if (tile === null) continue;
    centers.push(defender.buildUnit(UnitType.RailroadCenter, tile, {}));
  }

  // ── Defense posts across the front and into the defender's territory ──
  const posts: Unit[] = [];
  const postStep = 7;
  for (let y = 0; y < height && posts.length < opts.posts; y += postStep) {
    for (
      let x = frontX;
      x < width && posts.length < opts.posts;
      x += postStep
    ) {
      const tile = markUsed(x, y);
      if (tile === null) continue;
      const post = defender.buildUnit(UnitType.DefensePost, tile, {});
      for (let l = 1; l < 1 + (posts.length % 5); l++) {
        post.increaseLevel();
      }
      posts.push(post);
      game.addExecution(new DefensePostExecution(post));
    }
  }

  // ── Setup ticks: let factories create stations and connect the network ──
  for (let i = 0; i < 20; i++) {
    game.executeNextTick();
  }

  const stationManager = game.railNetwork().stationManager();
  const allStations = [...stationManager.getAll()];
  const clustersBySize = new Map<
    import("../../../src/core/game/TrainStation").Cluster,
    import("../../../src/core/game/TrainStation").TrainStation[]
  >();
  for (const station of allStations) {
    const cluster = station.getCluster();
    if (cluster === null) continue;
    let list = clustersBySize.get(cluster);
    if (list === undefined) {
      list = [];
      clustersBySize.set(cluster, list);
    }
    list.push(station);
  }
  const trainClusters = [...clustersBySize.values()].filter(
    (stations) => stations.length >= 2,
  );
  if (trainClusters.length === 0) {
    throw new Error(
      `no connected station clusters after setup (stations=${allStations.length})`,
    );
  }

  // ── Profiles ──
  const execProfiler = new ExecutionProfiler();
  if (opts.execProfile) execProfiler.attach(game);

  let gcTracker: GcTracker | null = null;
  if (opts.gcProfile) {
    try {
      gcTracker = new GcTracker();
      gcTracker.start();
    } catch {
      gcTracker = null;
    }
  }

  const cpuProfiler = opts.cpuProfile ? new CpuProfiler() : null;
  if (cpuProfiler) await cpuProfiler.start();

  // ── Sustained attack + train traffic ──
  const random = new PseudoRandom(simpleHash(opts.seed));
  const attackExecs: AttackExecution[] = [];
  const spawnAttack = () => {
    const exec = new AttackExecution(
      opts.attackTroops,
      attacker,
      defender.id(),
      null,
      false,
    );
    attackExecs.push(exec);
    game.addExecution(exec);
  };
  spawnAttack();

  let trains: TrainExecution[] = [];
  const spawnTrain = (): boolean => {
    const stations = random.randElement(trainClusters);
    const from = random.randElement(stations);
    let to = random.randElement(stations);
    // Prefer a long route: short hops finish in a few ticks and turn the
    // benchmark into train-spawn churn rather than steady-state rail traffic.
    for (let attempt = 0; attempt < 24; attempt++) {
      if (
        to !== from &&
        game.manhattanDist(from.tile(), to.tile()) >= opts.trainMinDist
      ) {
        break;
      }
      to = random.randElement(stations);
    }
    if (to === from) return false;
    const train = new TrainExecution(game.railNetwork(), defender, from, to, 5);
    game.addExecution(train);
    trains.push(train);
    return true;
  };

  const stats = new TickStats();
  const tickStart = performance.now();
  let spawnedTrains = 0;
  for (let i = 0; i < opts.ticks; i++) {
    // Ramp train traffic (init pathfinding is expensive; don't do it all at once).
    trains = trains.filter((t) => t.isActive());
    for (let n = 0; n < 5 && trains.length < opts.trains; n++) {
      if (spawnTrain()) spawnedTrains++;
    }

    // Force the defense-post signature to change, so the attack re-tiers its
    // whole conquest heap every tick (worst case).
    if (opts.togglePost && posts.length > 0) {
      const post = posts[i % posts.length];
      post.setUnderConstruction(!post.isUnderConstruction());
    }

    if (!attackExecs.some((a) => a.isActive())) {
      spawnAttack();
    }

    const t0 = performance.now();
    game.executeNextTick();
    stats.record(game.ticks(), performance.now() - t0);
  }
  const wallMs = performance.now() - tickStart;

  const profile = cpuProfiler ? await cpuProfiler.stop() : null;
  const gcEvents = gcTracker ? await gcTracker.stop() : null;

  // ── Report ──
  const summary = stats.summarize(100);
  const unitsByType = new Map<UnitType, number>();
  for (const unit of game.units()) {
    unitsByType.set(unit.type(), (unitsByType.get(unit.type()) ?? 0) + 1);
  }
  const activeTrains = trains.filter((t) => t.isActive()).length;
  const activeAttacks = attackExecs.filter((a) => a.isActive()).length;

  console.log(`\n${"=".repeat(76)}`);
  console.log(
    `Entity Stress Perf: ${opts.map}, ${opts.ticks} ticks, ` +
      `${opts.buildings} buildings, ${opts.posts} defense posts, ` +
      `${opts.trains} target trains`,
  );
  console.log("=".repeat(76));

  console.log(`\n--- Game state at end ---`);
  console.log(`Ticks executed:     ${game.ticks()}`);
  console.log(`Units:              ${game.units().length}`);
  console.log(
    `  Factories/Cities:  ${factories.length}/${cities.length}` +
      `  RailroadCenters: ${centers.length}`,
  );
  console.log(
    `  Defense posts:     ${posts.length}` +
      `  Trains live: ${activeTrains}/${trains.length} ` +
      `(spawned ${spawnedTrains})`,
  );
  console.log(`Stations:           ${allStations.length}`);
  console.log(
    `Station clusters:   ${clustersBySize.size} ` +
      `(${trainClusters.length} with >=2 stations)`,
  );
  console.log(`Active attacks:     ${activeAttacks}`);
  console.log(`Defender tiles:     ${defender.numTilesOwned()}`);
  console.log(`Attacker tiles:     ${attacker.numTilesOwned()}`);
  for (const type of [
    UnitType.Train,
    UnitType.DefensePost,
    UnitType.Factory,
    UnitType.City,
  ]) {
    console.log(`  ${type}: ${unitsByType.get(type) ?? 0}`);
  }

  console.log(`\n--- Per-tick wall time ---`);
  console.log(
    `Total: ${fmtMs(summary.totalMs)}ms sim over ${fmtMs(wallMs)}ms wall ` +
      `(${(summary.count / (wallMs / 1000)).toFixed(0)} ticks/sec)`,
  );
  console.log(
    `mean ${fmtMs(summary.meanMs)}ms | p50 ${fmtMs(summary.p50Ms)}ms | ` +
      `p95 ${fmtMs(summary.p95Ms)}ms | p99 ${fmtMs(summary.p99Ms)}ms | ` +
      `max ${fmtMs(summary.maxMs)}ms`,
  );
  console.log(`Over 100ms budget: ${summary.overBudget} / ${summary.count}`);
  console.log(
    `Slowest ticks: ` +
      summary.slowest.map((s) => `#${s.tick} (${fmtMs(s.ms)}ms)`).join(", "),
  );

  if (opts.execProfile) {
    console.log(`\n--- Time by Execution class ---`);
    const rows = execProfiler.report();
    const grandTotal = rows.reduce((a, r) => a + r.totalMs, 0);
    console.log(
      table(
        ["execution", "total ms", "%", "tick ms", "ticks", "instances"],
        rows
          .slice(0, 25)
          .map((r) => [
            r.name,
            fmtMs(r.totalMs),
            grandTotal > 0
              ? ((r.totalMs * 100) / grandTotal).toFixed(1)
              : "0.0",
            fmtMs(r.tickMs),
            String(r.tickCalls),
            String(r.instances),
          ]),
      ),
    );
  }

  if (gcEvents) {
    const gc = summarizeGcEvents(gcEvents);
    console.log(`\n--- GC (measured phase) ---`);
    console.log(
      table(
        ["kind", "count", "total ms", "avg ms", "max ms"],
        (["minor", "major", "incremental", "all"] as const).map((kind) => [
          kind,
          String(gc[kind].count),
          fmtMs(gc[kind].totalMs),
          fmtMs(gc[kind].count > 0 ? gc[kind].totalMs / gc[kind].count : 0),
          fmtMs(gc[kind].maxMs),
        ]),
      ),
    );
  }

  if (profile) {
    const projectRoot = path.resolve(__dirname, "../../..");
    const fns = summarizeCpuProfile(profile, projectRoot);
    console.log(`\n--- Top functions by self time ---`);
    console.log(
      table(
        ["self ms", "%", "function", "location"],
        fns
          .slice(0, 25)
          .map((f) => [
            fmtMs(f.selfMs),
            f.selfPct.toFixed(1),
            f.functionName,
            f.location,
          ]),
      ),
    );
  }

  if (opts.checkpoint) {
    console.log(`\n--- Checkpoint (autosave) ---`);
    const captureStart = performance.now();
    const checkpoint: GameCheckpoint | undefined = game.checkpoint?.();
    const captureMs = performance.now() - captureStart;
    if (checkpoint === undefined) {
      console.log(`checkpoint unavailable (an execution cannot be captured)`);
    } else {
      const encodeStart = performance.now();
      const plain = encodeCheckpoint(checkpoint);
      const encodeMs = performance.now() - encodeStart;
      const wireStart = performance.now();
      const wire = await encodeCheckpointWire(checkpoint);
      const wireMs = performance.now() - wireStart;
      console.log(`capture:        ${fmtMs(captureMs)}ms`);
      console.log(
        `plain encode:   ${fmtMs(encodeMs)}ms, ${fmtMB(plain.length)} MB, ` +
          `hash ${simpleHash(plain)}`,
      );
      console.log(
        `wire encode:    ${fmtMs(wireMs)}ms, ` +
          (wire === undefined
            ? "unavailable (over transfer budget)"
            : `${fmtMB(wire.length)} MB`),
      );
    }
  }

  console.log(
    `\nCheckpoint/state hash: final game state is deterministic for a`,
  );
  console.log(`fixed seed; compare the "plain encode" hash across builds.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
