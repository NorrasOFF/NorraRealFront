import { ExecutionCheckpoint } from "../Checkpoint";
import { Execution, Game, Player, Unit, UnitType } from "../game/Game";

/**
 * Maintains the informational `UnitType.Railroad` units that represent a
 * persistent rail link between two of the same player's own factories.
 *
 * A link is created the first time two same-player factory stations become
 * rail-connected (through any path in the rail network). It then persists while
 * both factories exist, even if the rail between them is later torn down and
 * rebuilt. It is dropped when either factory dies, or when one of the two
 * factories connects to a different factory (the newest connection wins).
 *
 * The link state lives on the owning `Player` (so it is checkpointed with the
 * player and read directly by the client); this execution only detects
 * connectivity changes and materializes the link as a `Railroad` unit whose
 * `targetUnit` is the partner factory.
 */
export class RailroadLinkExecution implements Execution {
  private active = true;
  private mg: Game;
  /** "a:b" keys (a < b) that were connected at the end of the previous tick. */
  private prevConnected = new Set<string>();

  init(mg: Game, _ticks: number): void {
    this.mg = mg;
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  checkpoint(): ExecutionCheckpoint {
    return {
      kind: "railroad_link",
      data: { prevConnected: [...this.prevConnected] },
    };
  }

  restoreCheckpoint(data: { prevConnected?: string[] }): void {
    this.prevConnected = new Set(data.prevConnected ?? []);
  }

  tick(_ticks: number): void {
    const stationManager = this.mg.railNetwork().stationManager();
    const nowConnected = new Set<string>();

    for (const player of this.mg.players()) {
      // Drop links whose factories are gone or no longer owned by this player.
      for (const factoryId of [...player.railroadLinks().keys()]) {
        const factory = this.mg.unit(factoryId);
        if (
          factory === undefined ||
          !factory.isActive() ||
          factory.owner() !== player
        ) {
          this.removeLink(player, factoryId);
        }
      }

      const factories = player
        .units(UnitType.Factory)
        .filter((u) => u.isActive() && u.hasTrainStation())
        .sort((a, b) => a.id() - b.id());

      for (let i = 0; i < factories.length; i++) {
        const sa = stationManager.findStation(factories[i]);
        if (sa === null) continue;
        const clusterA = sa.getCluster();
        if (clusterA === null) continue;
        for (let j = i + 1; j < factories.length; j++) {
          const sb = stationManager.findStation(factories[j]);
          if (sb === null || sb.getCluster() !== clusterA) continue;
          nowConnected.add(`${factories[i].id()}:${factories[j].id()}`);
        }
      }
    }

    // Only transitions into "connected" create links: this keeps a link that
    // survives a rail teardown/rebuild (the pair is not newly connected there)
    // and lets a manual delete stick until the pair actually reconnects.
    const newPairs = [...nowConnected]
      .filter((key) => !this.prevConnected.has(key))
      .sort();
    for (const key of newPairs) {
      const [aId, bId] = key.split(":").map(Number);
      const a = this.mg.unit(aId);
      const b = this.mg.unit(bId);
      if (a === undefined || b === undefined) continue;
      const player = a.owner();
      if (b.owner() !== player) continue;

      const pa = player.railroadPartner(aId);
      const pb = player.railroadPartner(bId);
      if (pa === bId && pb === aId) continue;

      // Newest connection wins: an existing partner on either endpoint is
      // replaced.
      if (pa !== undefined) this.removeLink(player, aId);
      if (pb !== undefined) this.removeLink(player, bId);
      this.createLink(player, a, b);
    }

    this.prevConnected = nowConnected;
  }

  private createLink(player: Player, a: Unit, b: Unit): void {
    const [first, second] = a.id() < b.id() ? [a, b] : [b, a];
    const unit = player.buildUnit(UnitType.Railroad, first.tile(), {
      targetUnit: second,
    });
    // Never a combat target — it only exists as info-menu metadata.
    unit.setTargetable(false);
    player.setRailroadLink(first.id(), second.id(), unit.id());
  }

  private removeLink(player: Player, factoryId: number): void {
    const link = player.railroadLinks().get(factoryId);
    if (link === undefined) return;
    const unit = this.mg.unit(link.unitId);
    if (unit !== undefined && unit.isActive()) {
      unit.delete(false);
    }
    player.removeRailroadLink(factoryId);
  }
}
