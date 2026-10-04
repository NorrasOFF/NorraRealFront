import { log } from "../DetMath";
import { TrainExecution } from "../execution/TrainExecution";
import { PseudoRandom } from "../PseudoRandom";
import { Game, Player, Unit, UnitType } from "./Game";
import { TileRef } from "./GameMap";
import { GameUpdateType } from "./GameUpdates";
import { Railroad } from "./Railroad";

/**
 * Handle train stops at various station types
 */
interface TrainStopHandler {
  onStop(mg: Game, station: TrainStation, trainExecution: TrainExecution): void;
}

class TradeStationStopHandler implements TrainStopHandler {
  onStop(
    mg: Game,
    station: TrainStation,
    trainExecution: TrainExecution,
  ): void {
    const stationOwner = station.unit.owner();
    const trainOwner = trainExecution.owner();
    const gold = mg
      .config()
      .trainGold(
        rel(trainOwner, stationOwner),
        trainExecution.tradeStopsVisited(),
        trainOwner,
      );
    // Share revenue with the station owner if it's not the current player
    if (trainOwner !== stationOwner) {
      stationOwner.addGold(gold, station.tile());
      stationOwner.addTrainGold(gold);
      mg.stats().trainExternalTrade(stationOwner, gold);
    }
    trainOwner.addGold(gold, station.tile());
    trainOwner.addTrainGold(gold);
    mg.stats().trainSelfTrade(trainOwner, gold);
  }
}

class FactoryStopHandler implements TrainStopHandler {
  onStop(
    mg: Game,
    station: TrainStation,
    trainExecution: TrainExecution,
  ): void {}
}

export function createTrainStopHandlers(
  random: PseudoRandom,
): Partial<Record<UnitType, TrainStopHandler>> {
  return {
    [UnitType.City]: new TradeStationStopHandler(),
    [UnitType.Port]: new TradeStationStopHandler(),
    [UnitType.Factory]: new FactoryStopHandler(),
  };
}

export class TrainStation {
  id: number = -1; // assigned by StationManager
  private readonly stopHandlers: Partial<Record<UnitType, TrainStopHandler>> =
    {};
  private cluster: Cluster | null = null;
  private railroads: Set<Railroad> = new Set();
  // Quick lookup from neighboring station to connecting railroad
  private railroadByNeighbor: Map<TrainStation, Railroad> = new Map();

  constructor(
    private mg: Game,
    public unit: Unit,
  ) {
    this.stopHandlers = createTrainStopHandlers(new PseudoRandom(mg.ticks()));
  }

  tradeAvailable(otherPlayer: Player): boolean {
    const player = this.unit.owner();
    return otherPlayer === player || player.canTrade(otherPlayer);
  }

  clearRailroads() {
    this.railroads.clear();
    this.railroadByNeighbor.clear();
  }

  addRailroad(railRoad: Railroad) {
    this.railroads.add(railRoad);
    const neighbor = railRoad.from === this ? railRoad.to : railRoad.from;
    this.railroadByNeighbor.set(neighbor, railRoad);
  }

  removeRailroad(railRoad: Railroad) {
    this.railroads.delete(railRoad);
    const neighbor = railRoad.from === this ? railRoad.to : railRoad.from;
    this.railroadByNeighbor.delete(neighbor);
  }

  removeNeighboringRails(station: TrainStation) {
    const toRemove = [...this.railroads].find(
      (r) => r.from === station || r.to === station,
    );
    if (toRemove) {
      this.mg.addUpdate({
        type: GameUpdateType.RailroadDestructionEvent,
        id: toRemove.id,
      });
      this.removeRailroad(toRemove);
    }
  }

  neighbors(): TrainStation[] {
    const neighbors: TrainStation[] = [];
    for (const r of this.railroads) {
      if (r.from !== this) {
        neighbors.push(r.from);
      } else {
        neighbors.push(r.to);
      }
    }
    return neighbors;
  }

  tile(): TileRef {
    return this.unit.tile();
  }

  isActive(): boolean {
    return this.unit.isActive();
  }

  getRailroads(): Set<Railroad> {
    return this.railroads;
  }

  getRailroadTo(station: TrainStation): Railroad | null {
    return this.railroadByNeighbor.get(station) ?? null;
  }

  setCluster(cluster: Cluster | null) {
    // Properly disconnect cluster if it's already set
    if (this.cluster !== null && this.cluster !== cluster) {
      this.cluster.removeStation(this);
    }
    this.cluster = cluster;
  }

  getCluster(): Cluster | null {
    return this.cluster;
  }

  onTrainStop(trainExecution: TrainExecution) {
    const type = this.unit.type();
    const handler = this.stopHandlers[type];
    if (handler) {
      handler.onStop(this.mg, this, trainExecution);
    }
  }
}

/**
 * How strongly a destination's level pulls train traffic toward it.
 * `w(L) = 1 + TRAIN_DESTINATION_LEVEL_WEIGHT * ln(L)`: a level-1 station is
 * the baseline, every level above adds a small bonus that diminishes as the
 * level grows (level 50 is ~1.98x a level-1 station). Kept deliberately mild.
 */
export const TRAIN_DESTINATION_LEVEL_WEIGHT = 0.25;

// Integer scale so weighted reservoir sampling stays deterministic (no
// float comparisons in the PRNG draw).
const DESTINATION_WEIGHT_SCALE = 1000;

/**
 * Integer selection weight for a destination at the given level. Uses the
 * deterministic `log` from DetMath so every client computes the same weight.
 */
export function trainDestinationWeight(level: number): number {
  if (level <= 1) return DESTINATION_WEIGHT_SCALE;
  return Math.round(
    (1 + TRAIN_DESTINATION_LEVEL_WEIGHT * log(level)) *
      DESTINATION_WEIGHT_SCALE,
  );
}

/**
 * Cluster of connected stations
 */
export class Cluster {
  public stations: Set<TrainStation> = new Set();
  private tradeStations: Set<TrainStation> = new Set();

  private isTradeStation(station: TrainStation): boolean {
    const type = station.unit.type();
    return type === UnitType.City || type === UnitType.Port;
  }

  has(station: TrainStation) {
    return this.stations.has(station);
  }

  addStation(station: TrainStation) {
    this.stations.add(station);
    if (this.isTradeStation(station)) {
      this.tradeStations.add(station);
    }
    station.setCluster(this);
  }

  removeStation(station: TrainStation) {
    this.stations.delete(station);
    this.tradeStations.delete(station);
  }

  addStations(stations: Set<TrainStation>) {
    for (const station of stations) {
      this.addStation(station);
    }
  }

  merge(other: Cluster) {
    for (const s of other.stations) {
      this.addStation(s);
    }
  }

  hasAnyTradeDestination(player: Player): boolean {
    for (const station of this.tradeStations) {
      if (station.tradeAvailable(player)) {
        return true;
      }
    }
    return false;
  }

  randomTradeDestination(
    player: Player,
    random: PseudoRandom,
  ): TrainStation | null {
    let selected: TrainStation | null = null;
    let totalWeight = 0;

    for (const station of this.tradeStations) {
      if (!station.tradeAvailable(player)) continue;
      const weight = trainDestinationWeight(station.unit.level());
      totalWeight += weight;

      // Weighted reservoir sampling: keep each eligible station with
      // probability weight / totalWeight. Higher-level destinations are
      // slightly more likely, with diminishing returns (trainDestinationWeight).
      if (random.nextInt(0, totalWeight) < weight) {
        selected = station;
      }
    }

    return selected;
  }

  availableForTrade(player: Player): Set<TrainStation> {
    const tradingStations = new Set<TrainStation>();
    for (const station of this.tradeStations) {
      if (station.tradeAvailable(player)) {
        tradingStations.add(station);
      }
    }
    return tradingStations;
  }

  size() {
    return this.stations.size;
  }

  clear() {
    this.stations.clear();
    this.tradeStations.clear();
  }
}

function rel(
  player: Player,
  other: Player,
): "self" | "team" | "ally" | "other" {
  if (player === other) {
    return "self";
  }
  if (player.isOnSameTeam(other)) {
    return "team";
  }
  if (player.isAlliedWith(other)) {
    return "ally";
  }
  return "other";
}
