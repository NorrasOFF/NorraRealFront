/**
 * Defense-post-aware attack prioritization.
 *
 * An attack's frontier heap is ordered by (defense tier, existing priority):
 * undefended tiles are conquered before defended tiles, and lower defense-post
 * levels before higher ones. The tier is the highest level among the
 * defender's active, not-under-construction posts within
 * `Config.defensePostRange()` — the same coverage test the combat formula uses.
 *
 * The geometry below puts two 30x20 defender regions next to one attacker
 * column on the 100x100 plains map. The regions are 60 rows apart, well outside
 * the 30-tile defense-post range, so a post in one region never tiers the
 * other.
 */
import { vi } from "vitest";
import { AttackExecution } from "../src/core/execution/AttackExecution";
import { FlatBinaryHeap } from "../src/core/execution/utils/FlatBinaryHeap";
import {
  Game,
  Player,
  PlayerInfo,
  PlayerType,
  Unit,
  UnitType,
} from "../src/core/game/Game";
import { GameImpl } from "../src/core/game/GameImpl";
import { TileRef } from "../src/core/game/GameMap";
import { GameUpdateType } from "../src/core/game/GameUpdates";
import { setup } from "./util/Setup";

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const ATTACKER_RECT: Rect = { x: 0, y: 0, w: 15, h: 100 };
/** Also the "low" / undefended region. */
const LOW_RECT: Rect = { x: 15, y: 0, w: 30, h: 20 };
/** Also the "high" / defended region. */
const HIGH_RECT: Rect = { x: 15, y: 60, w: 30, h: 20 };
const LOW_POST = { x: 30, y: 10 };
const HIGH_POST = { x: 30, y: 70 };

interface AttackGame {
  game: GameImpl;
  attacker: Player;
  defender: Player;
  exec: AttackExecution;
  lowPost: Unit | null;
  highPost: Unit | null;
}

function rectTiles(game: Game, r: Rect): TileRef[] {
  const tiles: TileRef[] = [];
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) {
      const tile = game.ref(x, y);
      if (game.isLand(tile) && !game.isImpassable(tile)) tiles.push(tile);
    }
  }
  return tiles;
}

function conquerRect(game: Game, player: Player, r: Rect): void {
  for (const tile of rectTiles(game, r)) player.conquer(tile);
}

function buildPost(
  game: Game,
  defender: Player,
  at: { x: number; y: number },
  level: number,
): Unit {
  const post = defender.buildUnit(
    UnitType.DefensePost,
    game.ref(at.x, at.y),
    {},
  );
  for (let i = 1; i < level; i++) post.increaseLevel();
  return post;
}

/**
 * Attacker column plus two defender regions. Posts are optional; `lowLevel: 0`
 * and `highLevel: 0` leave the region undefended.
 */
async function buildAttackGame(
  lowLevel: number = 0,
  highLevel: number = 0,
): Promise<AttackGame> {
  const game = (await setup("plains", {
    infiniteGold: true,
    infiniteTroops: true,
  })) as GameImpl;

  const attackerInfo = new PlayerInfo(
    "attacker",
    PlayerType.Human,
    null,
    "attacker",
  );
  const defenderInfo = new PlayerInfo(
    "defender",
    PlayerType.Human,
    null,
    "defender",
  );
  game.addPlayer(attackerInfo);
  game.addPlayer(defenderInfo);

  const attacker = game.player(attackerInfo.id);
  const defender = game.player(defenderInfo.id);

  conquerRect(game, attacker, ATTACKER_RECT);
  conquerRect(game, defender, LOW_RECT);
  conquerRect(game, defender, HIGH_RECT);

  const lowPost =
    lowLevel > 0 ? buildPost(game, defender, LOW_POST, lowLevel) : null;
  const highPost =
    highLevel > 0 ? buildPost(game, defender, HIGH_POST, highLevel) : null;

  const exec = new AttackExecution(
    1_000_000,
    attacker,
    defender.id(),
    null,
    // Troops are not deducted from the owner; the attack still gets a budget.
    false,
  );
  game.addExecution(exec);

  return { game, attacker, defender, exec, lowPost, highPost };
}

function heapSnapshot(exec: AttackExecution) {
  return (
    exec as unknown as { toConquer: FlatBinaryHeap }
  ).toConquer.snapshot();
}

function defenseLevelAt(exec: AttackExecution, tile: TileRef): number {
  return (
    exec as unknown as { defenseLevelAt(tile: TileRef): number }
  ).defenseLevelAt(tile);
}

function executeTicks(game: Game, ticks: number): void {
  for (let i = 0; i < ticks; i++) game.executeNextTick();
}

function drainHashes(game: Game, ticks: number): number[] {
  const hashes: number[] = [];
  for (let i = 0; i < ticks; i++) {
    const updates = game.executeNextTick();
    for (const update of updates[GameUpdateType.Hash]) hashes.push(update.hash);
  }
  return hashes;
}

/** Conquered tiles recorded by `vi.spyOn(attacker, "conquer")`, in order. */
function conquests(spy: { mock: { calls: unknown[][] } }): TileRef[] {
  return spy.mock.calls.map((call) => call[0] as TileRef);
}

describe("attack defense-post prioritization", () => {
  test("undefended frontier tiles are conquered before defended ones", async () => {
    const { game, attacker, exec } = await buildAttackGame(0, 1);
    const conquerSpy = vi.spyOn(attacker, "conquer");
    const low = new Set(rectTiles(game, LOW_RECT));
    const high = new Set(rectTiles(game, HIGH_RECT));

    let firstHigh = -1;
    for (let i = 0; i < 2000 && firstHigh === -1; i++) {
      game.executeNextTick();
      firstHigh = conquests(conquerSpy).findIndex((tile) => high.has(tile));
    }

    expect(firstHigh).toBeGreaterThanOrEqual(0);
    const before = conquests(conquerSpy).slice(0, firstHigh);
    // Every undefended tile was taken first, and nothing else was touched.
    expect(before.every((tile) => low.has(tile))).toBe(true);
    expect(before.filter((tile) => low.has(tile))).toHaveLength(low.size);
    expect(defenseLevelAt(exec, game.ref(HIGH_POST.x, HIGH_POST.y))).toBe(1);
    expect(defenseLevelAt(exec, game.ref(LOW_POST.x, LOW_POST.y))).toBe(0);
  });

  test("lower-level posts' tiles are conquered before higher-level posts'", async () => {
    const { game, attacker, exec } = await buildAttackGame(1, 5);
    const conquerSpy = vi.spyOn(attacker, "conquer");
    const low = new Set(rectTiles(game, LOW_RECT));
    const high = new Set(rectTiles(game, HIGH_RECT));

    let firstHigh = -1;
    for (let i = 0; i < 2000 && firstHigh === -1; i++) {
      game.executeNextTick();
      firstHigh = conquests(conquerSpy).findIndex((tile) => high.has(tile));
    }

    expect(firstHigh).toBeGreaterThanOrEqual(0);
    const before = conquests(conquerSpy).slice(0, firstHigh);
    expect(before.every((tile) => low.has(tile))).toBe(true);
    expect(before.filter((tile) => low.has(tile))).toHaveLength(low.size);

    const snapshot = heapSnapshot(exec);
    expect(snapshot.tiers).toBeDefined();
    expect(snapshot.tiers!.length).toBeGreaterThan(0);
    // Only the level-5 region remains, so every tiered entry is tier 5.
    expect(snapshot.tiers!.every(([, tier]) => tier === 5)).toBe(true);
    expect(defenseLevelAt(exec, game.ref(LOW_POST.x, LOW_POST.y))).toBe(1);
  });

  test("a post built mid-attack re-tiers existing frontier entries", async () => {
    const { game, defender, exec } = await buildAttackGame();
    executeTicks(game, 2);
    // No posts yet: the whole frontier is undefended.
    expect(heapSnapshot(exec).tiers).toBeUndefined();

    defender.buildUnit(
      UnitType.DefensePost,
      game.ref(HIGH_POST.x, HIGH_POST.y),
      {},
    );
    executeTicks(game, 1);

    const snapshot = heapSnapshot(exec);
    expect(snapshot.tiers).toBeDefined();
    expect(snapshot.tiers!.length).toBeGreaterThan(0);
    const range = game.config().defensePostRange();
    for (const [slot, tier] of snapshot.tiers!) {
      expect(tier).toBe(1);
      const tile = snapshot.tiles[slot];
      const dx = game.x(tile) - HIGH_POST.x;
      const dy = game.y(tile) - HIGH_POST.y;
      // Every tiered entry is inside the new post's coverage.
      expect(dx * dx + dy * dy).toBeLessThanOrEqual(range * range);
    }
  });

  test("destroying a post reverts its frontier tiles to undefended", async () => {
    const { game, exec, highPost } = await buildAttackGame(0, 1);
    executeTicks(game, 2);
    expect(heapSnapshot(exec).tiers).toBeDefined();

    highPost!.delete();
    executeTicks(game, 1);
    expect(heapSnapshot(exec).tiers).toBeUndefined();
  });

  test("a post under construction does not count until completion", async () => {
    const { game, defender, exec } = await buildAttackGame();
    const post = defender.buildUnit(
      UnitType.DefensePost,
      game.ref(HIGH_POST.x, HIGH_POST.y),
      {},
    );
    post.setUnderConstruction(true);
    executeTicks(game, 1);
    expect(heapSnapshot(exec).tiers).toBeUndefined();

    post.setUnderConstruction(false);
    executeTicks(game, 1);
    expect(heapSnapshot(exec).tiers).toBeDefined();
    expect(heapSnapshot(exec).tiers!.every(([, tier]) => tier === 1)).toBe(
      true,
    );
  });

  test("upgrading a post re-tiers after construction starts and finishes", async () => {
    const { game, defender, exec } = await buildAttackGame();
    const post = buildPost(game, defender, HIGH_POST, 1);
    executeTicks(game, 1);
    expect(heapSnapshot(exec).tiers!.every(([, tier]) => tier === 1)).toBe(
      true,
    );

    post.increaseLevel();
    post.beginDefensePostUpgrade();
    executeTicks(game, 1);
    // Under construction: coverage is ignored again.
    expect(heapSnapshot(exec).tiers).toBeUndefined();

    post.maybeFinishDefensePostUpgrade(
      game.ticks() + game.config().defensePostUpgradeDuration(),
    );
    executeTicks(game, 1);
    const tiers = heapSnapshot(exec).tiers!;
    expect(tiers.length).toBeGreaterThan(0);
    expect(tiers.every(([, tier]) => tier === 2)).toBe(true);
  });

  test("checkpoint restore preserves tiers and the suffix replay", async () => {
    const original = await buildAttackGame(0, 2);
    executeTicks(original.game, 5);

    const checkpoint = original.game.checkpoint();
    expect(checkpoint).toBeDefined();
    const attackCp = checkpoint!.executions.find((e) => e.kind === "attack");
    expect(attackCp).toBeDefined();
    const cpData = attackCp!.data as {
      toConquer: { tiers?: [number, number][] };
    };
    expect(cpData.toConquer.tiers).toBeDefined();
    expect(cpData.toConquer.tiers!.length).toBeGreaterThan(0);

    const expectedSnapshot = heapSnapshot(original.exec);
    const expectedHashes = drainHashes(original.game, 20);

    const restored = await buildAttackGame(0, 2);
    restored.game.restoreFromCheckpoint(checkpoint!);
    const restoredExec = (
      restored.game as unknown as { execs: AttackExecution[] }
    ).execs.find((exec) => exec instanceof AttackExecution)!;
    expect(restoredExec).toBeDefined();
    // Tiers and slot layout round-trip exactly, so dequeue order is identical.
    expect(heapSnapshot(restoredExec)).toEqual(expectedSnapshot);

    expect(drainHashes(restored.game, 20)).toEqual(expectedHashes);
  });

  test("no defense posts keeps the original priority-only ordering", async () => {
    const { game, exec } = await buildAttackGame();
    executeTicks(game, 3);
    expect(heapSnapshot(exec).tiers).toBeUndefined();
    expect(defenseLevelAt(exec, game.ref(LOW_POST.x, LOW_POST.y))).toBe(0);
  });
});
