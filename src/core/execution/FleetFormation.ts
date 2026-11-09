import { Game, Unit, UnitType } from "../game/Game";
import { TileRef } from "../game/GameMap";

const FORMATION_SPACING = 15;

function isCoreShip(type: UnitType): boolean {
  return type === UnitType.MissileShip || type === UnitType.MissileDefenseShip;
}

/**
 * Ticks between movement steps for a ship. Warships move every tick; missile
 * ships move every 1.5 ticks (two steps every three ticks).
 */
export function shipMoveInterval(type: UnitType): number {
  if (type === UnitType.Warship) return 1;
  return 1.5;
}

/** A fleet takes the slowest member's rate. */
export function computeFleetMoveRate(ships: Unit[]): number {
  return Math.max(...ships.map((s) => shipMoveInterval(s.type())));
}

/**
 * Whether a ship that moves once every `ticksPerMove` ticks should step on
 * `ticks`. The rate may be fractional (missile ships use 1.5), so the modulo
 * used for integer rates does not work. Integer half-tick math instead: the
 * ship has completed `floor(ticks * 2 / rateX2)` steps by `ticks`, where
 * `rateX2 = ticksPerMove * 2` (1 tick -> 2, 1.5 ticks -> 3).
 */
export function shipShouldMove(ticksPerMove: number, ticks: number): boolean {
  if (ticksPerMove <= 1) return true;
  const rateX2 = Math.round(ticksPerMove * 2);
  const movesNow = Math.floor((ticks * 2) / rateX2);
  const movesBefore = Math.floor(((ticks - 1) * 2) / rateX2);
  return movesNow > movesBefore;
}

/**
 * Find the nearest unused water tile to (baseX, baseY) by searching
 * expanding Chebyshev rings. Avoids collapsing ships onto a single tile
 * when a formation slot lands on land near the shore.
 */
function findWaterTile(
  mg: Game,
  baseX: number,
  baseY: number,
  usedTiles: Set<TileRef>,
): TileRef | undefined {
  for (let r = 0; r < 20; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = baseX + dx;
        const y = baseY + dy;
        if (!mg.isValidCoord(x, y)) continue;
        const tile = mg.ref(x, y);
        if (mg.isWater(tile) && !usedTiles.has(tile)) {
          return tile;
        }
      }
    }
  }
  return undefined;
}

/**
 * Collect up to `count` distinct water tiles near `anchor` in deterministic
 * ring order (nearest first). When `component` is given, only tiles reachable
 * through that water component are returned, so a bulk spawn cannot place a
 * ship on the far side of a narrow isthmus.
 */
export function findWaterTilesNear(
  mg: Game,
  anchor: TileRef,
  component: number | null,
  count: number,
): TileRef[] {
  const result: TileRef[] = [];
  const seen = new Set<TileRef>();
  const anchorX = mg.x(anchor);
  const anchorY = mg.y(anchor);
  for (let r = 0; r < 20 && result.length < count; r++) {
    for (let dy = -r; dy <= r && result.length < count; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = anchorX + dx;
        const y = anchorY + dy;
        if (!mg.isValidCoord(x, y)) continue;
        const tile = mg.ref(x, y);
        if (!mg.isWater(tile) || seen.has(tile)) continue;
        if (component !== null && !mg.hasWaterComponent(tile, component)) {
          continue;
        }
        seen.add(tile);
        result.push(tile);
        if (result.length >= count) break;
      }
    }
  }
  return result;
}

/**
 * Spawn tile for the `index`-th ship of a bulk build. The port tile is land,
 * so spread the ships over the nearest distinct water tiles around it. Falls
 * back to the port tile when the surrounding water is too small.
 */
export function bulkShipSpawnTile(
  mg: Game,
  portTile: TileRef,
  patrolTile: TileRef,
  index: number,
): TileRef {
  const component = mg.getWaterComponent(patrolTile);
  const tiles = findWaterTilesNear(mg, portTile, component, index + 1);
  return tiles[index] ?? portTile;
}

/**
 * Seed for a ship's patrol PRNG. Ships built by one bulk gesture all initialise
 * on the same tick, so without an index offset they would generate identical
 * random patrol targets and travel in lockstep on the exact same tile. Index 0
 * keeps the historical seed, so single-ship spawns are unchanged.
 */
export function shipRandomSeed(tick: number, bulkSpawnIndex?: number): number {
  return tick + (bulkSpawnIndex ?? 0) * 1_000_003;
}

/**
 * Assign each ship a compact, evenly-spaced grid slot around `anchor`, with
 * missile ships (MissileShip + MissileDefenseShip) in the center. Sets each
 * ship's patrolTile and fleetMoveRate.
 */
export function assignFleetFormation(
  mg: Game,
  ships: Unit[],
  anchor: TileRef,
): void {
  if (ships.length === 0) return;

  // Core ships (missile / missile-defense) take the innermost slots.
  const ordered = [...ships].sort((a, b) => {
    const aCore = isCoreShip(a.type());
    const bCore = isCoreShip(b.type());
    if (aCore === bCore) return 0;
    return aCore ? -1 : 1;
  });

  // Generate a square grid and sort by distance from center so the
  // innermost slots are assigned first.
  const gridSize = Math.ceil(Math.sqrt(ships.length));
  const half = Math.floor(gridSize / 2);
  const offsets: { dx: number; dy: number }[] = [];
  for (let i = 0; i < gridSize * gridSize; i++) {
    const row = Math.floor(i / gridSize) - half;
    const col = (i % gridSize) - half;
    offsets.push({
      dx: col * FORMATION_SPACING,
      dy: row * FORMATION_SPACING,
    });
  }
  offsets.sort(
    (a, b) => a.dx * a.dx + a.dy * a.dy - (b.dx * b.dx + b.dy * b.dy),
  );

  const fleetMoveRate = computeFleetMoveRate(ships);
  const usedTiles = new Set<TileRef>();
  const anchorX = mg.x(anchor);
  const anchorY = mg.y(anchor);

  ordered.forEach((ship, i) => {
    const offset = offsets[i];
    const formationTile =
      findWaterTile(mg, anchorX + offset.dx, anchorY + offset.dy, usedTiles) ??
      anchor;

    usedTiles.add(formationTile);
    ship.updateWarshipState({ patrolTile: formationTile, fleetMoveRate });
    ship.setTargetTile(undefined);
  });
}

/** Compute the centroid tile of a group of ships (rounded to nearest tile). */
export function computeFleetCentroid(mg: Game, ships: Unit[]): TileRef {
  let sumX = 0;
  let sumY = 0;
  for (const s of ships) {
    sumX += mg.x(s.tile());
    sumY += mg.y(s.tile());
  }
  const cx = Math.round(sumX / ships.length);
  const cy = Math.round(sumY / ships.length);
  if (mg.isValidCoord(cx, cy)) {
    return mg.ref(cx, cy);
  }
  return ships[0].tile();
}
