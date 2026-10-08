import { describe, expect, test } from "vitest";
import { RailroadLinkExecution } from "../../../src/core/execution/RailroadLinkExecution";
import { SpawnExecution } from "../../../src/core/execution/SpawnExecution";
import { WinCheckExecution } from "../../../src/core/execution/WinCheckExecution";
import {
  Game,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "../../../src/core/game/Game";
import { GameImpl } from "../../../src/core/game/GameImpl";
import { GameUpdateType } from "../../../src/core/game/GameUpdates";
import { Railroad } from "../../../src/core/game/Railroad";
import { Cluster, TrainStation } from "../../../src/core/game/TrainStation";
import { GameID } from "../../../src/core/Schemas";
import { setup } from "../../util/Setup";
import { executeTicks } from "../../util/utils";

const gameID: GameID = "checkpoint_railroad_link";

interface BuiltGame {
  game: GameImpl;
  alphaId: string;
}

/**
 * One spawned human on the deterministic `plains` map, matching the other B2
 * checkpoint tests: the same builder always produces the same game.
 */
async function buildBase(): Promise<BuiltGame> {
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

  return { game, alphaId: alpha.id };
}

/**
 * Two rail-connected factories of one player (tiles 0 and 4), joined by a
 * railroad, plus the reconciling execution so the informational link exists and
 * is part of the checkpoint. Ownership is taken first so PlayerExecution does
 * not delete the factories.
 */
function buildFactoryRailway(game: GameImpl, playerId: string): void {
  const player = game.player(playerId);
  for (let tile = 0; tile <= 4; tile++) {
    player.conquer(tile);
  }

  const stations = [0, 4].map((tile) => {
    const unit = player.buildUnit(UnitType.Factory, tile, {});
    unit.setTrainStation(true);
    const station = new TrainStation(game, unit);
    return station;
  });

  const net = game.railNetwork();
  const stationManager = net.stationManager();
  stations.forEach((station) => stationManager.addStation(station));

  const rail = new Railroad(stations[0], stations[1], [0, 1, 2, 3, 4], 1);
  stations[0].addRailroad(rail);
  stations[1].addRailroad(rail);

  // A shared cluster, the way `recomputeClusters` would assign one; the
  // checkpoint captures `station.getCluster()`, so this is restored.
  const cluster = new Cluster();
  cluster.addStation(stations[0]);
  cluster.addStation(stations[1]);
  net.recomputeClusters();

  game.addExecution(new RailroadLinkExecution());
}

function drainHashes(game: Game, ticks: number): number[] {
  const hashes: number[] = [];
  for (let i = 0; i < ticks; i++) {
    const updates = game.executeNextTick();
    for (const update of updates[GameUpdateType.Hash]) {
      hashes.push(update.hash);
    }
  }
  return hashes;
}

describe("Railroad link checkpoints", () => {
  test("captures the link and the informational unit", async () => {
    const { game, alphaId } = await buildBase();
    buildFactoryRailway(game, alphaId);
    executeTicks(game, 2);

    const player = game.player(alphaId);
    expect(player.units(UnitType.Railroad).length).toBe(1);

    const checkpoint = game.checkpoint();
    expect(checkpoint).toBeDefined();
    expect(checkpoint!.players[0].railroadLinks).toHaveLength(1);
    expect(checkpoint!.executions.some((e) => e.kind === "railroad_link")).toBe(
      true,
    );
  });

  test("restores the link and replays the suffix identically", async () => {
    const { game: original, alphaId } = await buildBase();
    buildFactoryRailway(original, alphaId);
    executeTicks(original, 3);

    const player = original.player(alphaId);
    const [factoryA, factoryB] = player.units(UnitType.Factory);
    const linkUnitId = player.units(UnitType.Railroad)[0].id();
    const partnerA = player.railroadPartner(factoryA.id());
    expect(partnerA).toBe(factoryB.id());

    const checkpoint = original.checkpoint();
    expect(checkpoint).toBeDefined();

    const expectedHashes = drainHashes(original, 30);
    expect(expectedHashes.length).toBeGreaterThan(0);

    const { game: restored } = await buildBase();
    restored.restoreFromCheckpoint(checkpoint!);

    const restoredPlayer = restored.player(alphaId);
    expect(restoredPlayer.railroadPartner(factoryA.id())).toBe(factoryB.id());
    expect(restoredPlayer.railroadPartner(factoryB.id())).toBe(factoryA.id());
    const restoredLinks = restoredPlayer.units(UnitType.Railroad);
    expect(restoredLinks).toHaveLength(1);
    expect(restoredLinks[0].id()).toBe(linkUnitId);
    expect(restoredLinks[0].targetUnit()!.id()).toBe(factoryB.id());

    const actualHashes = drainHashes(restored, 30);
    expect(actualHashes).toEqual(expectedHashes);
  });
});
