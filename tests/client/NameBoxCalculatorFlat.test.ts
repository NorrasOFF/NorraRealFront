import { describe, expect, test } from "vitest";
import {
  findLargestInscribedRectangle,
  findLargestInscribedRectangleFlat,
  FlatGrid,
} from "../../src/client/hud/NameBoxCalculator";

/** Convert the public boolean[][] form ([x][y]) to the row-major flat form. */
function toFlat(grid: boolean[][]): FlatGrid {
  const width = grid.length;
  const height = grid[0].length;
  const cells = new Uint8Array(width * height);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      cells[y * width + x] = grid[x][y] ? 1 : 0;
    }
  }
  return { cells, width, height };
}

function check(grid: boolean[][]): void {
  const expected = findLargestInscribedRectangle(grid);
  const actual = findLargestInscribedRectangleFlat(toFlat(grid));
  expect(actual).toEqual(expected);
}

describe("findLargestInscribedRectangleFlat", () => {
  test("matches the 2D implementation for every small grid", () => {
    for (let width = 1; width <= 3; width++) {
      for (let height = 1; height <= 3; height++) {
        const cells = width * height;
        for (let mask = 0; mask < 1 << cells; mask++) {
          const grid: boolean[][] = Array.from({ length: width }, () =>
            new Array<boolean>(height).fill(false),
          );
          for (let bit = 0; bit < cells; bit++) {
            grid[bit % width][Math.floor(bit / width)] =
              (mask & (1 << bit)) !== 0;
          }
          check(grid);
        }
      }
    }
  });

  test("matches the 2D implementation on larger pseudo-random grids", () => {
    let seed = 123456789;
    const next = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
      return (seed >>> 0) / 0x100000000;
    };
    for (let trial = 0; trial < 200; trial++) {
      const width = 1 + Math.floor(next() * 40);
      const height = 1 + Math.floor(next() * 40);
      const density = 0.2 + next() * 0.7;
      const grid: boolean[][] = Array.from({ length: width }, () =>
        Array.from({ length: height }, () => next() < density),
      );
      check(grid);
    }
  });
});
