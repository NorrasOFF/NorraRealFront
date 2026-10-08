import { Execution, Game, Player, UnitType } from "../game/Game";

/**
 * Removes one of the player's own informational railroad links (the
 * `UnitType.Railroad` unit shown in the info menu) and cuts the rail path
 * between the two factories it links, so the link does not immediately reform.
 *
 * The rail is cut along the station path between the two factories; the
 * factories themselves are left standing. Because link creation is
 * transition-driven, cutting the rail also means the pair will not be treated
 * as newly connected on the next tick.
 */
export class DeleteRailroadExecution implements Execution {
  private active = true;
  private mg: Game;

  constructor(
    private player: Player,
    private unitId: number,
  ) {}

  init(mg: Game): void {
    this.mg = mg;

    if (mg.inSpawnPhase()) {
      this.active = false;
      return;
    }

    const unit = mg.unit(this.unitId);
    if (
      unit === undefined ||
      unit.type() !== UnitType.Railroad ||
      !unit.isActive()
    ) {
      this.active = false;
      return;
    }

    if (unit.owner().id() !== this.player.id()) {
      console.warn(
        `SECURITY: cannot delete another player's railroad link (unit ${this.unitId})`,
      );
      this.active = false;
      return;
    }

    // Resolve the pair from this player's link table.
    let factoryA: number | undefined;
    let factoryB: number | undefined;
    for (const [id, link] of this.player.railroadLinks()) {
      if (link.unitId === this.unitId) {
        factoryA = id;
        factoryB = link.partnerId;
        break;
      }
    }

    if (factoryA !== undefined && factoryB !== undefined) {
      this.cutRailBetween(factoryA, factoryB);
      this.player.removeRailroadLink(factoryA);
    }

    unit.delete(false);
    this.active = false;
  }

  private cutRailBetween(factoryA: number, factoryB: number): void {
    const railNetwork = this.mg.railNetwork();
    const stationManager = railNetwork.stationManager();
    const a = this.mg.unit(factoryA);
    const b = this.mg.unit(factoryB);
    const stationA = a === undefined ? null : stationManager.findStation(a);
    const stationB = b === undefined ? null : stationManager.findStation(b);
    if (stationA === null || stationB === null) return;

    const path = railNetwork.findStationsPath(stationA, stationB);
    for (let i = 0; i + 1 < path.length; i++) {
      const railroad = path[i].getRailroadTo(path[i + 1]);
      if (railroad !== null) {
        railNetwork.removeRailroad(railroad);
      }
    }
  }

  tick(_ticks: number): void {}

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }
}
