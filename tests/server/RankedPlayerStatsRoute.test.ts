// @vitest-environment node
import express from "express";
import { promises as fs } from "fs";
import type { Server } from "http";
import type { AddressInfo } from "net";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  registerRankedRoutes,
  resetRankedRatingsForTests,
} from "../../src/server/ranking/RankedRatings";

// GET /api/player/:publicId/ranked — the "ranked games played" stat the player
// profile shows now that the topplist has no games column.

let dir: string;
let server: Server;
let base: string;

const older = Date.now() - 60_000;

function rating(
  publicId: string,
  games: number,
  verifiedName: string | null = publicId,
) {
  return {
    publicId,
    username: verifiedName ?? publicId,
    verifiedName,
    elo: games * 10,
    peakElo: games * 10,
    games,
    updatedAt: older,
  };
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "ranked-player-stats-"));
  process.env.AUTH_DIR = dir;
  resetRankedRatingsForTests();
  await fs.writeFile(
    path.join(dir, "ranked-ratings.json"),
    JSON.stringify({
      version: 1,
      players: {
        "alice-account": rating("alice-account", 7),
        // Unverified names do not matter for this stat: it is a count, not a
        // name list, so hidden-from-topplist players still have a profile stat.
        "hidden-account": rating("hidden-account", 3, null),
      },
      appliedMatches: [],
    }),
  );

  const app = express();
  registerRankedRoutes(app);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  delete process.env.AUTH_DIR;
  resetRankedRatingsForTests();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("GET /api/player/:publicId/ranked", () => {
  test("returns the number of ranked games played", async () => {
    const res = await fetch(`${base}/api/player/alice-account/ranked`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ games: 7 });
  });

  test("counts a player whose name is not on the topplist", async () => {
    const res = await fetch(`${base}/api/player/hidden-account/ranked`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ games: 3 });
  });

  test("reads 0 for an account that never played ranked", async () => {
    const res = await fetch(`${base}/api/player/never-played/ranked`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ games: 0 });
  });
});
