import { UnitType } from "../../../src/core/game/Game";
import {
  Cluster,
  TrainStation,
  trainDestinationWeight,
} from "../../../src/core/game/TrainStation";
import { PseudoRandom } from "../../../src/core/PseudoRandom";

const createStation = (id: number = 1, level: number = 1): TrainStation => {
  const station = new TrainStation(
    { ticks: () => 0 } as any,
    {
      type: () => UnitType.City,
      level: () => level,
      owner: () => ({ canTrade: () => true }),
    } as any,
  );
  station.id = id;
  return station;
};

describe("Cluster tests", () => {
  let cluster: Cluster;
  let stationA: TrainStation;
  let stationB: TrainStation;
  let stationC: TrainStation;

  beforeEach(() => {
    cluster = new Cluster();
    stationA = createStation(1);
    stationB = createStation(2);
    stationC = createStation(3);
  });

  test("addStation adds station and sets cluster bidirectionally", () => {
    cluster.addStation(stationA);
    expect(cluster.has(stationA)).toBe(true);
    expect(stationA.getCluster()).toBe(cluster);
  });

  test("duplicate addStation is idempotent and preserves trade destination", () => {
    cluster.addStation(stationA);
    cluster.addStation(stationA);
    expect(cluster.has(stationA)).toBe(true);
    expect(stationA.getCluster()).toBe(cluster);
    expect(
      cluster.hasAnyTradeDestination({ canTrade: () => true } as any),
    ).toBe(true);
  });

  test("removeStation removes station from cluster", () => {
    cluster.addStation(stationA);
    cluster.removeStation(stationA);
    expect(cluster.has(stationA)).toBe(false);
  });

  test("addStations adds multiple stations and sets cluster", () => {
    cluster.addStations(new Set([stationA, stationB]));
    expect(cluster.has(stationA)).toBe(true);
    expect(cluster.has(stationB)).toBe(true);
    expect(stationA.getCluster()).toBe(cluster);
    expect(stationB.getCluster()).toBe(cluster);
  });

  test("merge combines stations from another cluster and migrates clusters", () => {
    const otherCluster = new Cluster();
    otherCluster.addStation(stationB);
    otherCluster.addStation(stationC);
    cluster.addStation(stationA);
    cluster.merge(otherCluster);
    expect(cluster.has(stationA)).toBe(true);
    expect(cluster.has(stationB)).toBe(true);
    expect(cluster.has(stationC)).toBe(true);
    expect(stationB.getCluster()).toBe(cluster);
  });

  test("has returns false for non-member stations", () => {
    expect(cluster.has(stationA)).toBe(false);
  });
});

describe("trainDestinationWeight", () => {
  test("level 1 is the baseline weight", () => {
    expect(trainDestinationWeight(1)).toBe(1000);
  });

  test("levels below 1 clamp to the baseline", () => {
    expect(trainDestinationWeight(0)).toBe(1000);
    expect(trainDestinationWeight(-5)).toBe(1000);
  });

  test("strictly increases with level", () => {
    for (let level = 2; level <= 50; level++) {
      expect(trainDestinationWeight(level)).toBeGreaterThan(
        trainDestinationWeight(level - 1),
      );
    }
  });

  test("bonus diminishes with level", () => {
    // Early levels add more than late levels.
    const earlyGain = trainDestinationWeight(5) - trainDestinationWeight(1);
    const lateGain = trainDestinationWeight(50) - trainDestinationWeight(40);
    expect(earlyGain).toBeGreaterThan(lateGain);
  });

  test("level 50 is ~1.98x a level 1", () => {
    expect(trainDestinationWeight(50)).toBe(1978);
  });
});

describe("Cluster weighted train destinations", () => {
  test("higher-level destination is chosen more often", () => {
    const cluster = new Cluster();
    const lows = [1, 2, 3, 4].map((id) => createStation(id, 1));
    const high = createStation(5, 50);
    for (const station of lows) cluster.addStation(station);
    cluster.addStation(high);

    const player = {} as any;
    const random = new PseudoRandom(12345);
    const counts = new Map<number, number>();
    const trials = 20000;
    for (let i = 0; i < trials; i++) {
      const destination = cluster.randomTradeDestination(player, random);
      const id = destination!.id;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }

    const highCount = counts.get(5)!;
    for (const low of lows) {
      expect(highCount).toBeGreaterThan(counts.get(low.id)!);
    }
    // Theoretical ratio is trainDestinationWeight(50) / 1000 = 1.978.
    const avgLow =
      lows.reduce((sum, low) => sum + counts.get(low.id)!, 0) / lows.length;
    expect(highCount / avgLow).toBeGreaterThan(1.8);
    expect(highCount / avgLow).toBeLessThan(2.15);
  });
});
