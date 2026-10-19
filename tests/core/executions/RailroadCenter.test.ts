import { describe, expect, it, vi } from "vitest";
import { TrainExecutionCheckpoint } from "../../../src/core/Checkpoint";
import { TrainExecution } from "../../../src/core/execution/TrainExecution";
import { TrainStationExecution } from "../../../src/core/execution/TrainStationExecution";
import {
  Game,
  Player,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "../../../src/core/game/Game";
import { Railroad } from "../../../src/core/game/Railroad";
import { TrainStation } from "../../../src/core/game/TrainStation";
import { setup } from "../../util/Setup";

const RAIL_TILES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

function buildRailLine(
  game: Game,
  stationOwnerIds: [string, string],
): { net: ReturnType<Game["railNetwork"]>; a: TrainStation; b: TrainStation } {
  const net = game.railNetwork();
  const a = new TrainStation(
    game,
    game.player(stationOwnerIds[0])!.buildUnit(UnitType.City, 0, {}),
  );
  const b = new TrainStation(
    game,
    game.player(stationOwnerIds[1])!.buildUnit(UnitType.City, 9, {}),
  );
  net.stationManager().addStation(a);
  net.stationManager().addStation(b);
  const rail = new Railroad(a, b, [...RAIL_TILES], 1);
  a.addRailroad(rail);
  b.addRailroad(rail);
  return { net, a, b };
}

function lastPlanSpeed(spy: ReturnType<typeof vi.spyOn>): number {
  const call = spy.mock.calls.at(-1)!;
  return (call[0] as { speed: number }).speed;
}

async function ownLandAndRail(
  buildCenters: (player: Player) => void,
): Promise<{ speed: number; game: Game; player: Player }> {
  const game = await setup("plains", { instantBuild: true }, [
    new PlayerInfo("p1", PlayerType.Human, null, "p1"),
  ]);
  const player = game.player("p1")!;
  RAIL_TILES.forEach((t) => player.conquer(t));
  const { net, a, b } = buildRailLine(game, ["p1", "p1"]);
  buildCenters(player);
  const spy = vi.spyOn(game, "recordMotionPlan");
  const exec = new TrainExecution(net, player, a, b, 0);
  exec.init(game, 0);
  return { speed: lastPlanSpeed(spy), game, player };
}

describe("RailroadCenter speed boost", () => {
  it("uses a logarithmic curve that reaches ~1.9 at 10 and caps at 2", async () => {
    const game = await setup("plains", {}, []);
    const config = game.config();
    expect(config.railroadCenterSpeedMultiplier(0)).toBe(1);
    expect(config.railroadCenterSpeedMultiplier(1)).toBeCloseTo(1.2599, 3);
    expect(config.railroadCenterSpeedMultiplier(10)).toBeCloseTo(1.9, 2);
    expect(config.railroadCenterSpeedMultiplier(1000)).toBe(2);
    // Leveling a center is like building another of the same level.
    expect(config.railroadCenterBoostUnits(1)).toBe(1);
    expect(config.railroadCenterBoostUnits(2)).toBe(2);
    expect(config.railroadCenterBoostUnits(3)).toBe(4);
  });

  it("boosts a train between two own stops", async () => {
    const base = await ownLandAndRail(() => {});
    expect(base.speed).toBeCloseTo(2, 6);

    const boosted = await ownLandAndRail((player) => {
      player.buildUnit(UnitType.RailroadCenter, 4, {});
    });
    expect(boosted.speed).toBeCloseTo(
      2 * boosted.game.config().railroadCenterSpeedMultiplier(1),
      6,
    );
    expect(boosted.speed).toBeGreaterThan(base.speed);
  });

  it("does not boost when the two stops belong to different nations", async () => {
    const game = await setup("plains", { instantBuild: true }, [
      new PlayerInfo("p1", PlayerType.Human, null, "p1"),
      new PlayerInfo("p2", PlayerType.Human, null, "p2"),
    ]);
    const p1 = game.player("p1")!;
    RAIL_TILES.forEach((t) => p1.conquer(t));
    const { net, a, b } = buildRailLine(game, ["p1", "p2"]);
    p1.buildUnit(UnitType.RailroadCenter, 4, {});

    const spy = vi.spyOn(game, "recordMotionPlan");
    const exec = new TrainExecution(net, p1, a, b, 0);
    exec.init(game, 0);
    expect(lastPlanSpeed(spy)).toBeCloseTo(2, 6);
  });

  it("a level-2 center equals two level-1 centers", async () => {
    const oneLevelTwo = await ownLandAndRail((player) => {
      player.buildUnit(UnitType.RailroadCenter, 4, {}).increaseLevel();
    });
    const twoLevelOne = await ownLandAndRail((player) => {
      player.buildUnit(UnitType.RailroadCenter, 4, {});
      player.buildUnit(UnitType.RailroadCenter, 5, {});
    });

    expect(oneLevelTwo.speed).toBeCloseTo(twoLevelOne.speed, 6);
    expect(oneLevelTwo.speed).toBeCloseTo(2 * (1 + 0.375 * Math.log(3)), 4);
  });

  it("captures and restores the fractional speed and its accumulator", async () => {
    const game = await setup("plains", { instantBuild: true }, [
      new PlayerInfo("p1", PlayerType.Human, null, "p1"),
    ]);
    const player = game.player("p1")!;
    RAIL_TILES.forEach((t) => player.conquer(t));
    const { net, a, b } = buildRailLine(game, ["p1", "p1"]);
    player.buildUnit(UnitType.RailroadCenter, 4, {});

    const exec = new TrainExecution(net, player, a, b, 0);
    exec.init(game, 0);
    exec.tick(1);

    const cp = exec.checkpoint();
    expect(cp.kind).toBe("train");
    const data = cp.data as TrainExecutionCheckpoint;
    expect(data.speed).toBeGreaterThan(2);

    const restored = new TrainExecution(net, player, a, b, 0);
    expect(restored.restoreCheckpoint(game, data)).toBe(true);
    expect((restored as unknown as { speed: number }).speed).toBeCloseTo(
      data.speed,
      6,
    );
    expect(
      (restored as unknown as { speedAccumulator: number }).speedAccumulator,
    ).toBe((exec as unknown as { speedAccumulator: number }).speedAccumulator);
  });

  it("spawn multiplier rises +10% per center level", async () => {
    const game = await setup("plains", {}, []);
    const config = game.config();
    expect(config.railroadCenterSpawnMultiplier(0)).toBe(1);
    expect(config.railroadCenterSpawnMultiplier(1)).toBeCloseTo(1.1, 6);
    expect(config.railroadCenterSpawnMultiplier(5)).toBeCloseTo(1.5, 6);
  });

  it("caps a player's summed Railroad Center levels at 5, for build and upgrade", async () => {
    const game = await setup(
      "plains",
      { instantBuild: true, infiniteGold: true },
      [new PlayerInfo("p1", PlayerType.Human, null, "p1")],
    );
    const player = game.player("p1")!;
    for (let y = 0; y <= 95; y++) {
      for (let x = 0; x <= 30; x++) player.conquer(game.ref(x, y));
    }

    // Five level-1 centers, spaced past structureMinDist (15), are allowed
    // (summed levels = 5).
    const tiles = [0, 20, 40, 60, 80].map((y) => game.ref(0, y));
    for (const tile of tiles) {
      expect(player.canBuild(UnitType.RailroadCenter, tile)).not.toBe(false);
      player.buildUnit(UnitType.RailroadCenter, tile, {});
    }
    // A sixth is refused, and no existing center can be upgraded past the cap.
    expect(player.canBuild(UnitType.RailroadCenter, game.ref(0, 95))).toBe(
      false,
    );
    const existing = player.units(UnitType.RailroadCenter)[0];
    expect(player.canUpgradeUnit(existing)).toBe(false);
  });

  it("charges a flat 2M gold per Railroad Center level", async () => {
    const game = await setup("plains", { instantBuild: true }, [
      new PlayerInfo("p1", PlayerType.Human, null, "p1"),
    ]);
    const player = game.player("p1")!;
    [0, 1, 2, 3, 4].forEach((t) => player.conquer(t));
    const cost = () =>
      game.config().unitInfo(UnitType.RailroadCenter).cost(game, player);
    expect(cost()).toBe(2_000_000n);
    player.buildUnit(UnitType.RailroadCenter, 4, {});
    expect(cost()).toBe(2_000_000n);
    player.units(UnitType.RailroadCenter)[0].increaseLevel();
    expect(cost()).toBe(2_000_000n);
  });

  it("scales factory spawn odds by the owner's center levels", async () => {
    async function spawnOdds(centerLevel: number): Promise<number[]> {
      const game = await setup(
        "plains",
        { instantBuild: true, infiniteGold: true },
        [new PlayerInfo("p1", PlayerType.Human, null, "p1")],
      );
      const player = game.player("p1")!;
      [0, 1, 2, 3, 4, 5].forEach((t) => player.conquer(t));
      const factory = player.buildUnit(UnitType.Factory, 0, {});
      if (centerLevel > 0) {
        const center = player.buildUnit(UnitType.RailroadCenter, 4, {});
        for (let i = 1; i < centerLevel; i++) center.increaseLevel();
      }

      const exec = new TrainStationExecution(factory, true) as unknown as {
        init(g: Game, t: number): void;
        random: { chance(odds: number): boolean };
        shouldSpawnTrain(): boolean;
      };
      exec.init(game, 0);
      const odds: number[] = [];
      // Capture the spawn odds each level-roll is asked for; always fail so we
      // observe every roll without side effects.
      exec.random = {
        chance: (o: number) => {
          odds.push(o);
          return false;
        },
      };
      exec.shouldSpawnTrain();
      return odds;
    }

    const base = await spawnOdds(0);
    const boosted = await spawnOdds(5);
    // Factory level 1 -> one roll, at round(trainSpawnRate(1) / boost).
    expect(base).toEqual([165]);
    expect(boosted).toEqual([Math.round(165 / 1.5)]);
    expect(boosted[0]).toBeLessThan(base[0]);
  });

  it("trims a captured center's levels down to the 5-level cap", async () => {
    const game = await setup(
      "plains",
      { instantBuild: true, infiniteGold: true },
      [
        new PlayerInfo("p1", PlayerType.Human, null, "p1"),
        new PlayerInfo("p2", PlayerType.Human, null, "p2"),
      ],
    );
    const p1 = game.player("p1")!;
    const p2 = game.player("p2")!;
    [0, 20, 40, 60].forEach((y) =>
      p1.buildUnit(UnitType.RailroadCenter, game.ref(0, y), {}),
    );
    const captured = p2.buildUnit(UnitType.RailroadCenter, game.ref(0, 90), {});
    captured.increaseLevel();
    captured.increaseLevel();
    expect(captured.level()).toBe(3);

    p1.captureUnit(captured);

    expect(p1.unitsOwned(UnitType.RailroadCenter)).toBe(5);
    expect(captured.owner()).toBe(p1);
    expect(captured.level()).toBe(1);
    expect(p2.unitsOwned(UnitType.RailroadCenter)).toBe(0);
  });

  it("deletes a captured center that cannot fit under the cap", async () => {
    const game = await setup(
      "plains",
      { instantBuild: true, infiniteGold: true },
      [
        new PlayerInfo("p1", PlayerType.Human, null, "p1"),
        new PlayerInfo("p2", PlayerType.Human, null, "p2"),
      ],
    );
    const p1 = game.player("p1")!;
    const p2 = game.player("p2")!;
    [0, 20, 40, 60, 80].forEach((y) =>
      p1.buildUnit(UnitType.RailroadCenter, game.ref(0, y), {}),
    );
    const captured = p2.buildUnit(UnitType.RailroadCenter, game.ref(0, 90), {});
    [1, 2, 3, 4].forEach(() => captured.increaseLevel());
    expect(captured.level()).toBe(5);

    p1.captureUnit(captured);

    expect(p1.unitsOwned(UnitType.RailroadCenter)).toBe(5);
    expect(captured.isActive()).toBe(false);
    expect(p1.units(UnitType.RailroadCenter)).toHaveLength(5);
    expect(p2.unitsOwned(UnitType.RailroadCenter)).toBe(0);
  });
});
