import fs from "fs";
import path from "path";
import { maps } from "../src/core/game/Game";

type Manifest = {
  map: { width: number; height: number; num_land_tiles: number };
  nations: { name: string; coordinates?: [number, number] }[];
};

const RESOURCES_MAPS = path.resolve(__dirname, "..", "resources", "maps");

function readManifest(folder: string): Manifest {
  return JSON.parse(
    fs.readFileSync(path.join(RESOURCES_MAPS, folder, "manifest.json"), "utf8"),
  ) as Manifest;
}

function isLand(byte: number): boolean {
  // Bit 7 is the land flag; impassable land is encoded as 0b10011111.
  return (byte & 0x80) !== 0 && byte !== 0b10011111;
}

/** Areas of every 4-connected land body in the full-size packed map. */
function landAreas(folder: string, manifest: Manifest): number[] {
  const { width, height } = manifest.map;
  const data = fs.readFileSync(path.join(RESOURCES_MAPS, folder, "map.bin"));
  expect(data.length).toBe(width * height);

  const seen = new Uint8Array(width * height);
  const stack = new Int32Array(width * height);
  const areas: number[] = [];

  for (let start = 0; start < data.length; start++) {
    if (seen[start] !== 0 || !isLand(data[start])) continue;

    let top = 0;
    let area = 0;
    stack[top++] = start;
    seen[start] = 1;

    while (top > 0) {
      const tile = stack[--top];
      area++;
      const x = tile % width;
      const y = (tile - x) / width;

      if (x > 0) {
        const n = tile - 1;
        if (seen[n] === 0 && isLand(data[n])) {
          seen[n] = 1;
          stack[top++] = n;
        }
      }
      if (x < width - 1) {
        const n = tile + 1;
        if (seen[n] === 0 && isLand(data[n])) {
          seen[n] = 1;
          stack[top++] = n;
        }
      }
      if (y > 0) {
        const n = tile - width;
        if (seen[n] === 0 && isLand(data[n])) {
          seen[n] = 1;
          stack[top++] = n;
        }
      }
      if (y < height - 1) {
        const n = tile + width;
        if (seen[n] === 0 && isLand(data[n])) {
          seen[n] = 1;
          stack[top++] = n;
        }
      }
    }

    areas.push(area);
  }

  return areas.sort((a, b) => b - a);
}

const ISLAND_MAPS = [
  { id: "FourIslands", folder: "fourislands", islands: 4 },
  { id: "FiveIslands", folder: "fiveislands", islands: 5 },
  { id: "SixIslands", folder: "sixislands", islands: 6 },
  { id: "SevenIslands", folder: "sevenislands", islands: 7 },
  { id: "EightIslands", folder: "eightislands", islands: 8 },
  { id: "NineIslands", folder: "nineislands", islands: 9 },
] as const;

// These were resized to a shared island area.
const RESIZED_ISLAND_MAPS = ISLAND_MAPS.filter((m) => m.islands >= 5);
const TARGET_ISLAND_AREA = 256_000;

describe.each(ISLAND_MAPS)("$folder", ({ id, folder, islands }) => {
  const manifest = readManifest(folder);

  test("is grouped under the islands category", () => {
    const map = maps.find((m) => m.id === id);
    expect(map?.categories).toContain("islands");
  });

  test(`has ${islands} islands`, () => {
    expect(landAreas(folder, manifest)).toHaveLength(islands);
  });

  test(`has one nation on each island`, () => {
    expect(manifest.nations).toHaveLength(islands);

    const { width, height } = manifest.map;
    const data = fs.readFileSync(path.join(RESOURCES_MAPS, folder, "map.bin"));

    for (const nation of manifest.nations) {
      expect(nation.coordinates).toBeDefined();
      const [x, y] = nation.coordinates!;
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(width);
      expect(y).toBeLessThan(height);
      expect(isLand(data[y * width + x])).toBe(true);
    }
  });
});

describe.each(RESIZED_ISLAND_MAPS)("$folder island sizing", ({ folder }) => {
  test("islands have the shared target area", () => {
    const areas = landAreas(folder, readManifest(folder));
    const average = areas.reduce((a, b) => a + b, 0) / areas.length;

    expect(average / TARGET_ISLAND_AREA).toBeGreaterThan(0.95);
    expect(average / TARGET_ISLAND_AREA).toBeLessThan(1.05);

    for (const area of areas) {
      expect(area / average).toBeGreaterThan(0.95);
      expect(area / average).toBeLessThan(1.05);
    }
  });
});
