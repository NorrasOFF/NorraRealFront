import fs from "fs";
import path from "path";
import { describe, expect, test } from "vitest";
import {
  ATLAS_COLS,
  STRUCTURE_ORDER,
} from "../src/client/render/gl/passes/StructurePass";
import { STRUCTURE_TYPES } from "../src/client/render/types";

/**
 * The structure sprite atlas is a fixed-column sheet: every structure type is
 * one 64 px column, in `STRUCTURE_ORDER`. When a structure is added to
 * `STRUCTURE_TYPES` but not to `STRUCTURE_ORDER` (as happened to the
 * Tollhouse) it silently renders as nothing, because the passes derive their
 * type→column map from `STRUCTURE_ORDER`.
 */

const CELL_PX = 64;
const ICON_ATLAS = path.join(
  __dirname,
  "..",
  "resources",
  "atlases",
  "icon-atlas.png",
);

function pngSize(buf: Buffer): { width: number; height: number } {
  // PNG signature (8) + IHDR chunk length (4) + "IHDR" (4), then width/height.
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

describe("structure sprite atlas", () => {
  test("STRUCTURE_ORDER covers every structure type exactly once", () => {
    expect(new Set(STRUCTURE_ORDER).size).toBe(STRUCTURE_ORDER.length);
    expect([...STRUCTURE_ORDER].sort()).toEqual([...STRUCTURE_TYPES].sort());
  });

  test("icon-atlas.png has one 64px column per structure", () => {
    const { width, height } = pngSize(fs.readFileSync(ICON_ATLAS));
    expect(height).toBe(CELL_PX);
    expect(width).toBe(ATLAS_COLS * CELL_PX);
  });
});
