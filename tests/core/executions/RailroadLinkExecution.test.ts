import { describe, expect, it } from "vitest";
import { DeleteRailroadExecution } from "../../../src/core/execution/DeleteRailroadExecution";
import { RailroadLinkExecution } from "../../../src/core/execution/RailroadLinkExecution";
import {
  Game,
  Player,
  PlayerInfo,
  PlayerType,
  Unit,
  UnitType,
} from "../../../src/core/game/Game";
import { Railroad } from "../../../src/core/game/Railroad";
import { Cluster, TrainStation } from "../../../src/core/game/TrainStation";
import { setup } from "../../util/Setup";

async function makeGame() {
  const game = await setup("plains", { instantBuild: true }, [
    new PlayerInfo("p1", PlayerType.Human, null, "p1"),
  ]);
  const player = game.player("p1")!;
  [0, 1, 2, 3, 4].forEach((t) => player.conquer(t));
  return { game, player };
}

function makeFactoryStation(
  game: Game,
  player: Player,
  tile: number,
): { unit: Unit; station: TrainStation } {
  const unit = player.buildUnit(UnitType.Factory, tile, {});
  unit.setTrainStation(true);
  const station = new TrainStation(game, unit);
  game.railNetwork().stationManager().addStation(station);
  return { unit, station };
}

function link(...stations: TrainStation[]): Cluster {
  const cluster = new Cluster();
  for (const station of stations) cluster.addStation(station);
  return cluster;
}

function tick(game: Game): void {
  const exec = new RailroadLinkExecution();
  exec.init(game, 0);
  exec.tick(0);
}

function railroadsOf(player: Player): Unit[] {
  return player.units(UnitType.Railroad);
}

describe("RailroadLinkExecution", () => {
  it("links two rail-connected factories of the same player", async () => {
    const { game, player } = await makeGame();
    const a = makeFactoryStation(game, player, 0);
    const b = makeFactoryStation(game, player, 2);
    link(a.station, b.station);

    tick(game);

    expect(player.railroadPartner(a.unit.id())).toBe(b.unit.id());
    expect(player.railroadPartner(b.unit.id())).toBe(a.unit.id());
    const links = railroadsOf(player);
    expect(links).toHaveLength(1);
    expect(links[0].targetUnit()!.id()).toBe(b.unit.id());
    expect(links[0].tile()).toBe(a.unit.tile());
  });

  it("does not link factories that are not connected", async () => {
    const { game, player } = await makeGame();
    const a = makeFactoryStation(game, player, 0);
    const b = makeFactoryStation(game, player, 2);
    // Two separate clusters.
    link(a.station);
    link(b.station);

    tick(game);

    expect(railroadsOf(player)).toHaveLength(0);
  });

  it("keeps the link when the rail temporarily disconnects and reuses it on rebuild", async () => {
    const { game, player } = await makeGame();
    const a = makeFactoryStation(game, player, 0);
    const b = makeFactoryStation(game, player, 2);
    const cluster = link(a.station, b.station);
    tick(game);
    const linkUnitId = railroadsOf(player)[0].id();

    // Tear the rail down: b leaves the cluster.
    cluster.removeStation(b.station);
    tick(game);
    expect(player.railroadPartner(a.unit.id())).toBe(b.unit.id());
    expect(railroadsOf(player)).toHaveLength(1);
    expect(railroadsOf(player)[0].id()).toBe(linkUnitId);

    // Rebuild the rail between the same two factories.
    link(a.station, b.station);
    tick(game);
    expect(railroadsOf(player)).toHaveLength(1);
    expect(railroadsOf(player)[0].id()).toBe(linkUnitId);
  });

  it("replaces the link when a factory connects to a different factory", async () => {
    const { game, player } = await makeGame();
    const a = makeFactoryStation(game, player, 0);
    const b = makeFactoryStation(game, player, 2);
    const ab = link(a.station, b.station);
    tick(game);
    expect(player.railroadPartner(a.unit.id())).toBe(b.unit.id());

    // Disconnect b, then connect a to a new factory c.
    ab.removeStation(b.station);
    tick(game);
    const c = makeFactoryStation(game, player, 4);
    link(a.station, c.station);
    tick(game);

    expect(player.railroadPartner(a.unit.id())).toBe(c.unit.id());
    expect(player.railroadPartner(b.unit.id())).toBeUndefined();
    expect(railroadsOf(player)).toHaveLength(1);
  });

  it("drops the link when one factory dies", async () => {
    const { game, player } = await makeGame();
    const a = makeFactoryStation(game, player, 0);
    const b = makeFactoryStation(game, player, 2);
    link(a.station, b.station);
    tick(game);
    expect(railroadsOf(player)).toHaveLength(1);

    a.unit.delete(false);
    tick(game);

    expect(player.railroadPartner(b.unit.id())).toBeUndefined();
    expect(railroadsOf(player)).toHaveLength(0);
  });

  it("delete removes the link and cuts the rail between the factories", async () => {
    const { game, player } = await makeGame();
    const a = makeFactoryStation(game, player, 0);
    const b = makeFactoryStation(game, player, 2);
    link(a.station, b.station);

    // Give the two factory stations an actual connecting rail so the delete
    // path can resolve and cut it.
    const rail = new Railroad(a.station, b.station, [0, 1, 2], 1);
    a.station.addRailroad(rail);
    b.station.addRailroad(rail);

    tick(game);
    const linkUnit = railroadsOf(player)[0];
    expect(linkUnit).toBeDefined();

    const del = new DeleteRailroadExecution(player, linkUnit.id());
    del.init(game);

    expect(player.railroadPartner(a.unit.id())).toBeUndefined();
    expect(game.unit(linkUnit.id())).toBeUndefined();
    expect(a.station.getRailroads().has(rail)).toBe(false);
    expect(b.station.getRailroads().has(rail)).toBe(false);
  });
});
