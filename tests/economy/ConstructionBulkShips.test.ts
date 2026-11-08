import { ConstructionExecution } from "../../src/core/execution/ConstructionExecution";
import {
  Game,
  Gold,
  Player,
  PlayerInfo,
  PlayerType,
  Unit,
  UnitType,
} from "../../src/core/game/Game";
import { setup } from "../util/Setup";

const coastX = 7;
let game: Game;
let player: Player;

describe("Bulk warship construction", () => {
  const builderInfo = new PlayerInfo(
    "builder",
    PlayerType.Human,
    null,
    "builder_id",
  );

  beforeEach(async () => {
    game = await setup(
      "half_land_half_ocean",
      { infiniteGold: false, instantBuild: true, infiniteTroops: true },
      [builderInfo],
    );
    player = game.player(builderInfo.id);
    player.conquer(game.ref(0, 10));
    player.addGold(10_000_000n);
    // A port is required for warshipSpawn; built directly to keep the test
    // focused on the construction intent (buildUnit does not charge gold).
    player.buildUnit(UnitType.Port, game.ref(coastX, 10), {});
  });

  const patrolTile = () => game.ref(coastX + 1, 10);

  const runTicks = (n: number) => {
    for (let i = 0; i < n; i++) game.executeNextTick();
  };

  test("a build_unit amount of 5 spawns five warships", () => {
    game.addExecution(
      new ConstructionExecution(
        player,
        UnitType.Warship,
        patrolTile(),
        undefined,
        5,
      ),
    );
    // init -> completeConstruction -> WarshipExecution init/build
    runTicks(4);

    const ships: Unit[] = player.units(UnitType.Warship);
    expect(ships).toHaveLength(5);
    for (const ship of ships) {
      expect(ship.warshipState().patrolTile).toBe(patrolTile());
    }
  });

  test("bulk construction charges the escalating per-ship price", () => {
    const costBefore = player.gold();
    // 1st ship 250k, 2nd 500k, 3rd+ 750k (capped) = 3,000,000 for five.
    game.addExecution(
      new ConstructionExecution(
        player,
        UnitType.Warship,
        patrolTile(),
        undefined,
        5,
      ),
    );
    runTicks(4);

    expect(player.units(UnitType.Warship)).toHaveLength(5);
    const spent = costBefore - player.gold();
    // Allow for a few ticks of passive gold income after the purchase.
    expect(spent).toBeGreaterThanOrEqual(3_000_000n);
    expect(spent).toBeLessThan(3_010_000n);
  });

  test("no amount still spawns a single warship", () => {
    game.addExecution(
      new ConstructionExecution(player, UnitType.Warship, patrolTile()),
    );
    runTicks(4);
    expect(player.units(UnitType.Warship)).toHaveLength(1);
  });

  test("only as many ships as the player can afford are spawned", () => {
    // Drain nearly all gold: enough for the first ship (250k) but not the
    // second (500k).
    const single = game.unitInfo(UnitType.Warship).cost(game, player);
    expect(single).toBe(250_000n);
    player.removeGold(player.gold() - 300_000n);

    game.addExecution(
      new ConstructionExecution(
        player,
        UnitType.Warship,
        patrolTile(),
        undefined,
        5,
      ),
    );
    runTicks(4);

    expect(player.units(UnitType.Warship)).toHaveLength(1);
    expect(player.gold() >= 0n).toBe(true);
  });

  test("buildableUnits exposes cumulative ship build costs", () => {
    const bu = player
      .buildableUnits(patrolTile())
      .find((u) => u.type === UnitType.Warship);
    expect(bu).toBeDefined();
    expect(bu!.buildCosts?.slice(0, 5)).toEqual([
      250_000n,
      750_000n,
      1_500_000n,
      2_250_000n,
      3_000_000n,
    ] as Gold[]);
  });
});
