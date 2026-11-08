import { Cell, Game, NameViewData, Player } from "../../core/game/Game";
import { calculateBoundingBox } from "../../core/Util";

export interface Point {
  x: number;
  y: number;
}

export interface Rectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Spawn region diameter (see getSpawnTiles in SpawnExecution — euclidean
// radius 4). Used to size spawn-phase names directly off the spawn tile,
// instead of waiting on cluster recomputation.
const SPAWN_REGION_DIAMETER = 8;

/**
 * Place a player's name during the spawn phase using their currently-selected
 * spawn tile. Tracks re-rolls immediately, since spawnTile updates the same
 * tick the player picks a new location.
 */
export function placeSpawnName(game: Game, player: Player): NameViewData {
  const spawnTile = player.spawnTile();
  if (spawnTile === undefined) {
    return { x: 0, y: 0, size: 0 };
  }
  const fontSize = calculateFontSize(
    {
      x: 0,
      y: 0,
      width: SPAWN_REGION_DIAMETER,
      height: SPAWN_REGION_DIAMETER,
    },
    player.displayName(),
  );
  return {
    x: Math.ceil(game.x(spawnTile)),
    y: Math.ceil(game.y(spawnTile) - fontSize / 3),
    size: fontSize,
  };
}

export function placeName(game: Game, player: Player): NameViewData {
  const boundingBox =
    player.largestClusterBoundingBox ??
    calculateBoundingBox(game, player.borderTiles());

  let scalingFactor: number;
  const width = boundingBox.max.x - boundingBox.min.x;
  const height = boundingBox.max.y - boundingBox.min.y;
  const size = Math.min(width, height);
  if (size < 25) {
    scalingFactor = 1;
  } else if (size < 50) {
    scalingFactor = 2;
  } else if (size < 100) {
    scalingFactor = 4;
  } else if (size < 250) {
    scalingFactor = 8;
  } else if (size < 500) {
    scalingFactor = 16;
  } else {
    scalingFactor = 32;
  }

  const grid = createFlatGrid(game, player, boundingBox, scalingFactor);
  const largestRectangle = findLargestInscribedRectangleFlat(grid);
  largestRectangle.x = largestRectangle.x * scalingFactor;
  largestRectangle.y = largestRectangle.y * scalingFactor;
  largestRectangle.width = largestRectangle.width * scalingFactor;
  largestRectangle.height = largestRectangle.height * scalingFactor;

  let center = new Cell(
    Math.floor(
      largestRectangle.x + largestRectangle.width / 2 + boundingBox.min.x,
    ),
    Math.floor(
      largestRectangle.y + largestRectangle.height / 2 + boundingBox.min.y,
    ),
  );

  const fontSize = calculateFontSize(largestRectangle, player.displayName());
  center = new Cell(center.x, center.y - fontSize / 3);

  return {
    x: Math.ceil(center.x),
    y: Math.ceil(center.y),
    size: fontSize,
  };
}

/**
 * Flat (Uint8Array-backed) variant of createGrid used by placeName. The public
 * createGrid stays for callers/tests that want a boolean[][]; the name rebuild
 * runs for every player every 30 ticks in the worker, where one typed array
 * plus no per-cell Cell allocation is materially cheaper.
 */
export interface FlatGrid {
  cells: Uint8Array;
  width: number;
  height: number;
}

function createFlatGrid(
  game: Game,
  player: Player,
  boundingBox: { min: Point; max: Point },
  scalingFactor: number,
): FlatGrid {
  const minX = Math.floor(boundingBox.min.x / scalingFactor);
  const minY = Math.floor(boundingBox.min.y / scalingFactor);
  const maxX = Math.floor(boundingBox.max.x / scalingFactor);
  const maxY = Math.floor(boundingBox.max.y / scalingFactor);
  const width = maxX - minX + 1;
  const height = maxY - minY + 1;
  if (width <= 0 || height <= 0) {
    return { cells: new Uint8Array(0), width: 0, height: 0 };
  }
  const cells = new Uint8Array(width * height);
  const mapWidth = game.width();
  const mapHeight = game.height();

  for (let gy = minY; gy <= maxY; gy++) {
    const py = gy * scalingFactor;
    if (py < 0 || py >= mapHeight) continue;
    const rowBase = (gy - minY) * width;
    for (let gx = minX; gx <= maxX; gx++) {
      const px = gx * scalingFactor;
      if (px < 0 || px >= mapWidth) continue;
      const tile = game.ref(px, py);
      cells[rowBase + (gx - minX)] =
        game.isShore(tile) ||
        (game.isOcean(tile) && game.magnitude(tile) < 10) ||
        game.owner(tile) === player ||
        game.hasFallout(tile)
          ? 1
          : 0;
    }
  }

  return { cells, width, height };
}

export function findLargestInscribedRectangleFlat(grid: FlatGrid): Rectangle {
  const { cells, width, height } = grid;
  const heights = new Int32Array(width);
  const stack = new Int32Array(width + 1);
  let bestArea = 0;
  let bestX = 0;
  let bestY = 0;
  let bestWidth = 0;
  let bestHeight = 0;

  for (let row = 0; row < height; row++) {
    const base = row * width;
    for (let col = 0; col < width; col++) {
      heights[col] = cells[base + col] ? heights[col] + 1 : 0;
    }

    // largestRectangleInHistogram, inlined with a reusable stack.
    let sp = 0;
    for (let i = 0; i <= width; i++) {
      const h = i === width ? 0 : heights[i];
      while (sp > 0 && h < heights[stack[sp - 1]]) {
        const top = stack[--sp];
        const rectHeight = heights[top];
        const left = sp === 0 ? 0 : stack[sp - 1] + 1;
        const rectWidth = i - left;
        const area = rectHeight * rectWidth;
        if (area > bestArea) {
          bestArea = area;
          bestX = left;
          bestY = row - rectHeight + 1;
          bestWidth = rectWidth;
          bestHeight = rectHeight;
        }
      }
      stack[sp++] = i;
    }
  }

  return { x: bestX, y: bestY, width: bestWidth, height: bestHeight };
}

export function createGrid(
  game: Game,
  player: Player,
  boundingBox: { min: Point; max: Point },
  scalingFactor: number,
): boolean[][] {
  const scaledBoundingBox: { min: Point; max: Point } = {
    min: {
      x: Math.floor(boundingBox.min.x / scalingFactor),
      y: Math.floor(boundingBox.min.y / scalingFactor),
    },
    max: {
      x: Math.floor(boundingBox.max.x / scalingFactor),
      y: Math.floor(boundingBox.max.y / scalingFactor),
    },
  };

  const width = scaledBoundingBox.max.x - scaledBoundingBox.min.x + 1;
  const height = scaledBoundingBox.max.y - scaledBoundingBox.min.y + 1;
  const grid: boolean[][] = Array(width)
    .fill(null)
    .map(() => Array(height).fill(false));

  for (let x = scaledBoundingBox.min.x; x <= scaledBoundingBox.max.x; x++) {
    for (let y = scaledBoundingBox.min.y; y <= scaledBoundingBox.max.y; y++) {
      const cell = new Cell(x * scalingFactor, y * scalingFactor);
      if (game.isOnMap(cell)) {
        const tile = game.ref(cell.x, cell.y);
        grid[x - scaledBoundingBox.min.x][y - scaledBoundingBox.min.y] =
          game.isShore(tile) ||
          (game.isOcean(tile) && game.magnitude(tile) < 10) ||
          game.owner(tile) === player ||
          game.hasFallout(tile);
      }
    }
  }

  return grid;
}

export function findLargestInscribedRectangle(grid: boolean[][]): Rectangle {
  const rows = grid[0].length;
  const cols = grid.length;
  const heights: number[] = new Array(cols).fill(0);
  let largestRect: Rectangle = { x: 0, y: 0, width: 0, height: 0 };

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      if (grid[col][row]) {
        heights[col]++;
      } else {
        heights[col] = 0;
      }
    }

    const rectForRow = largestRectangleInHistogram(heights);

    if (
      rectForRow.width * rectForRow.height >
      largestRect.width * largestRect.height
    ) {
      largestRect = {
        x: rectForRow.x,
        y: row - rectForRow.height + 1,
        width: rectForRow.width,
        height: rectForRow.height,
      };
    }
  }

  return largestRect;
}

export function largestRectangleInHistogram(widths: number[]): Rectangle {
  const stack: number[] = [];
  let maxArea = 0;
  let largestRect: Rectangle = { x: 0, y: 0, width: 0, height: 0 };

  for (let i = 0; i <= widths.length; i++) {
    const h = i === widths.length ? 0 : widths[i];

    while (stack.length > 0 && h < widths[stack[stack.length - 1]]) {
      const height = widths[stack.pop()!];
      const width = stack.length === 0 ? i : i - stack[stack.length - 1] - 1;

      if (height * width > maxArea) {
        maxArea = height * width;
        largestRect = {
          x: stack.length === 0 ? 0 : stack[stack.length - 1] + 1,
          y: 0,
          width: width,
          height: height,
        };
      }
    }

    stack.push(i);
  }

  return largestRect;
}

export function calculateFontSize(rectangle: Rectangle, name: string): number {
  // This is a simplified calculation. You might want to adjust it based on your specific font and rendering system.
  const widthConstrained = (rectangle.width / name.length) * 2;
  const heightConstrained = rectangle.height / 3;
  return Math.min(widthConstrained, heightConstrained);
}
