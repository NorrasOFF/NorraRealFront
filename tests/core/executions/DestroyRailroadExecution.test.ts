import { describe, expect, it } from "vitest";
import { DestroyRailroadExecution } from "../../../src/core/execution/DestroyRailroadExecution";
import { PlayerInfo, PlayerType, UnitType } from "../../../src/core/game/Game";
import { Railroad } from "../../../src/core/game/Railroad";
import { TrainStation } from "../../../src/core/game/TrainStation";
import { setup } from "../../util/Setup";

async function makeRailroadGame() {
  const game = await setup("plains", { instantBuild: true }, [
    new PlayerInfo("p1", PlayerType.Human, null, "p1"),
    new PlayerInfo("p2", PlayerType.Human, null, "p2"),
  ]);
  const owner = game.player("p1")!;
  const enemy = game.player("p2")!;
  [0, 1, 2, 6].forEach((t) => owner.conquer(t));

  const a = new TrainStation(game, owner.buildUnit(UnitType.City, 0, {}));
  const b = new TrainStation(game, owner.buildUnit(UnitType.City, 2, {}));
  const manager = game.railNetwork().stationManager();
  manager.addStation(a);
  manager.addStation(b);

  const rail = new Railroad(a, b, [0, 1, 2], 1);
  a.addRailroad(rail);
  b.addRailroad(rail);

  return { game, owner, enemy, a, b, rail };
}

describe("DestroyRailroadExecution", () => {
  it("removes the railroad under the clicked tile for the land's owner", async () => {
    const { game, owner, a, b, rail } = await makeRailroadGame();

    const exec = new DestroyRailroadExecution(owner, 1);
    exec.init(game);

    expect(exec.isActive()).toBe(false);
    expect(a.getRailroads().has(rail)).toBe(false);
    expect(b.getRailroads().has(rail)).toBe(false);
    expect(game.railNetwork().railroadsAt(1)).toHaveLength(0);
  });

  it("removes a railroad when clicking one of its endpoint tiles", async () => {
    const { game, owner, rail } = await makeRailroadGame();

    const exec = new DestroyRailroadExecution(owner, 2);
    exec.init(game);

    expect(game.railNetwork().railroadsAt(2)).toHaveLength(0);
    expect(rail.from.getRailroads().has(rail)).toBe(false);
  });

  it("rejects a player who does not own the tile", async () => {
    const { game, enemy, a, b, rail } = await makeRailroadGame();

    const exec = new DestroyRailroadExecution(enemy, 1);
    exec.init(game);

    expect(a.getRailroads().has(rail)).toBe(true);
    expect(b.getRailroads().has(rail)).toBe(true);
  });

  it("does nothing on an owned tile with no railroad", async () => {
    const { game, owner, rail } = await makeRailroadGame();

    const exec = new DestroyRailroadExecution(owner, 6);
    exec.init(game);

    expect(rail.from.getRailroads().has(rail)).toBe(true);
  });
});
