import { describe, expect, it, vi } from "vitest";
import { TrainExecutionCheckpoint } from "../../../src/core/Checkpoint";
import { TrainExecution } from "../../../src/core/execution/TrainExecution";
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
});
