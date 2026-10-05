import { RailNetworkCheckpoint } from "../Checkpoint";
import { Unit, UnitType } from "./Game";
import { TileRef } from "./GameMap";
import { StationManager } from "./RailNetworkImpl";
import { Railroad } from "./Railroad";
import { TrainStation } from "./TrainStation";

export interface RailNetwork {
  connectStation(station: TrainStation): void;
  removeStation(unit: Unit): void;
  findStationsPath(from: TrainStation, to: TrainStation): TrainStation[];
  stationManager(): StationManager;
  /** Railroads whose tile list contains the given tile. */
  railroadsAt(tile: TileRef): Railroad[];
  /** Remove a single railroad segment and mark its endpoint clusters dirty. */
  removeRailroad(railroad: Railroad): void;
  overlappingRailroads(unitType: UnitType, tile: TileRef): TileRef[];
  computeGhostRailPaths(unitType: UnitType, tile: TileRef): TileRef[][];
  recomputeClusters(): void;
  /** B2: capture this network's authoritative state. */
  checkpoint(): RailNetworkCheckpoint;
  /** B2: overwrite this network's state from a checkpoint. */
  restoreFromCheckpoint(cp: RailNetworkCheckpoint): void;
}
