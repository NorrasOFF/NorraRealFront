/**
 * Repeatable full-game benchmark wrapper.
 *
 * Runs the real FullGamePerf harness N times with profiling disabled (the
 * profilers add measurable overhead), then reports median/min tick times and
 * the final state hash. Use it to A/B a change on the same machine:
 *
 *   npm run perf:quick -- --runs 5 --save tests/perf/output/baseline.json
 *   # make the change
 *   npm run perf:quick -- --runs 5 --compare tests/perf/output/baseline.json
 *
 * The final hash must match between the two runs: a performance change that
 * alters the simulation is a bug, not an optimization. Timing is machine-noisy
 * (run several repetitions and compare medians, not single runs).
 *
 * Usage:
 *   npm run perf:quick -- [--runs 3] [--ticks 900] [--bots 300]
 *                            [--map World] [--seed perf-default]
 *                            [--save <file.json>] [--compare <file.json>]
 */
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

interface Options {
  runs: number;
  ticks: number;
  bots: number;
  map: string;
  seed: string;
  save?: string;
  compare?: string;
}

interface RunResult {
  totalMs: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  hash: string;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HARNESS = path.join(HERE, "FullGamePerf.ts");

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    runs: 3,
    ticks: 900,
    bots: 300,
    map: "World",
    seed: "perf-default",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`missing value for ${arg}`);
      return value;
    };
    switch (arg) {
      case "--runs":
        opts.runs = parseInt(next(), 10);
        break;
      case "--ticks":
        opts.ticks = parseInt(next(), 10);
        break;
      case "--bots":
        opts.bots = parseInt(next(), 10);
        break;
      case "--map":
        opts.map = next();
        break;
      case "--seed":
        opts.seed = next();
        break;
      case "--save":
        opts.save = next();
        break;
      case "--compare":
        opts.compare = next();
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function fmt(ms: number): string {
  return ms >= 100 ? ms.toFixed(0) : ms.toFixed(2);
}

function runOnce(opts: Options): RunResult {
  const command =
    `npx tsx "${HARNESS}"` +
    ` --map ${opts.map} --ticks ${opts.ticks} --bots ${opts.bots}` +
    ` --seed ${opts.seed}` +
    ` --no-cpu-profile --no-exec-profile --no-gc-profile --no-alloc-profile`;
  const output = execSync(command, {
    cwd: path.resolve(HERE, "../../.."),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });

  const total = /Total: ([\d.]+)ms sim time/.exec(output);
  const stats =
    /mean ([\d.]+)ms \| p50 ([\d.]+)ms \| p95 ([\d.]+)ms \| p99 ([\d.]+)ms/.exec(
      output,
    );
  const hash = /Final hash:\s+(-?\d+)/.exec(output);
  if (!total || !stats || !hash) {
    throw new Error(`could not parse benchmark output:\n${output}`);
  }
  return {
    totalMs: parseFloat(total[1]),
    meanMs: parseFloat(stats[1]),
    p50Ms: parseFloat(stats[2]),
    p95Ms: parseFloat(stats[3]),
    p99Ms: parseFloat(stats[4]),
    hash: hash[1],
  };
}

interface SavedBenchmark {
  scenario: { map: string; ticks: number; bots: number; seed: string };
  runs: RunResult[];
  median: RunResult;
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  const runs: RunResult[] = [];

  console.log(
    `QuickBench: ${opts.map}, ${opts.ticks} ticks, ${opts.bots} bots, ` +
      `${opts.runs} run(s)\n`,
  );
  for (let i = 1; i <= opts.runs; i++) {
    process.stdout.write(`run ${i}/${opts.runs}... `);
    const result = runOnce(opts);
    runs.push(result);
    console.log(
      `total ${fmt(result.totalMs)}ms | mean ${fmt(result.meanMs)}ms | ` +
        `p50 ${fmt(result.p50Ms)}ms | p95 ${fmt(result.p95Ms)}ms | ` +
        `p99 ${fmt(result.p99Ms)}ms | hash ${result.hash}`,
    );
  }

  const hashes = new Set(runs.map((r) => r.hash));
  if (hashes.size > 1) {
    console.error(
      `\nWARNING: final hashes differ between runs: ${[...hashes]}`,
    );
  }

  const med: RunResult = {
    totalMs: median(runs.map((r) => r.totalMs)),
    meanMs: median(runs.map((r) => r.meanMs)),
    p50Ms: median(runs.map((r) => r.p50Ms)),
    p95Ms: median(runs.map((r) => r.p95Ms)),
    p99Ms: median(runs.map((r) => r.p99Ms)),
    hash: runs[0].hash,
  };

  console.log(
    `\nmedian: total ${fmt(med.totalMs)}ms | mean ${fmt(med.meanMs)}ms | ` +
      `p50 ${fmt(med.p50Ms)}ms | p95 ${fmt(med.p95Ms)}ms | ` +
      `p99 ${fmt(med.p99Ms)}ms | hash ${med.hash}`,
  );

  if (opts.save !== undefined) {
    const saved: SavedBenchmark = {
      scenario: {
        map: opts.map,
        ticks: opts.ticks,
        bots: opts.bots,
        seed: opts.seed,
      },
      runs,
      median: med,
    };
    fs.mkdirSync(path.dirname(opts.save), { recursive: true });
    fs.writeFileSync(opts.save, JSON.stringify(saved, null, 2));
    console.log(`saved baseline to ${opts.save}`);
  }

  if (opts.compare !== undefined) {
    const baseline: SavedBenchmark = JSON.parse(
      fs.readFileSync(opts.compare, "utf8"),
    );
    const base = baseline.median;
    const pct = (now: number, before: number) =>
      before === 0 ? "n/a" : `${(((now - before) / before) * 100).toFixed(1)}%`;
    console.log(`\nvs ${opts.compare}:`);
    console.log(
      `  mean  ${fmt(med.meanMs)}ms vs ${fmt(base.meanMs)}ms (${pct(med.meanMs, base.meanMs)})`,
    );
    console.log(
      `  p95   ${fmt(med.p95Ms)}ms vs ${fmt(base.p95Ms)}ms (${pct(med.p95Ms, base.p95Ms)})`,
    );
    console.log(
      `  p99   ${fmt(med.p99Ms)}ms vs ${fmt(base.p99Ms)}ms (${pct(med.p99Ms, base.p99Ms)})`,
    );
    console.log(
      `  total ${fmt(med.totalMs)}ms vs ${fmt(base.totalMs)}ms (${pct(med.totalMs, base.totalMs)})`,
    );
    if (base.hash !== med.hash) {
      console.error(
        `\nERROR: simulation hash changed (${base.hash} -> ${med.hash}). ` +
          `A performance change must not alter game state.`,
      );
      process.exitCode = 1;
    } else {
      console.log(`  hash  ${med.hash} (unchanged)`);
    }
  }
}

main();
