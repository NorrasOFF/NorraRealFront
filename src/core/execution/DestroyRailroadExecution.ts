import { Execution, Game, Player } from "../game/Game";
import { TileRef } from "../game/GameMap";

/**
 * Removes the railroad segment under a clicked tile. The two endpoint stations
 * are left standing; only the edge between them is destroyed (the per-tick
 * RecomputeRailClusterExecution then splits any cluster the removal broke).
 *
 * A player may only cut rails on their own territory, so a railroad crossing
 * your land can be pruned even if its stations belong to someone else.
 */
export class DestroyRailroadExecution implements Execution {
  private active = true;
  private mg: Game;

  constructor(
    private player: Player,
    private tile: TileRef,
  ) {}

  init(mg: Game): void {
    this.mg = mg;

    if (mg.inSpawnPhase()) {
      this.active = false;
      return;
    }

    const tileOwner = mg.owner(this.tile);
    if (!tileOwner.isPlayer() || tileOwner.id() !== this.player.id()) {
      console.warn(
        `SECURITY: cannot destroy railroad off player's territory (tile ${this.tile})`,
      );
      this.active = false;
      return;
    }

    const railroads = mg.railNetwork().railroadsAt(this.tile);
    if (railroads.length === 0) {
      this.active = false;
      return;
    }

    // At a junction several segments can share the clicked tile. Prefer one
    // where the tile is interior (not an endpoint) so cutting a line between
    // two stops removes the through segment rather than a station stub.
    const chosen =
      railroads.find(
        (r) =>
          r.tiles[0] !== this.tile && r.tiles[r.tiles.length - 1] !== this.tile,
      ) ?? railroads[0];
    this.mg.railNetwork().removeRailroad(chosen);

    this.active = false;
  }

  tick(_ticks: number): void {}

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }
}
