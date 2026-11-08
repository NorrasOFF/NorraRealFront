// @vitest-environment node
import { describe, expect, test } from "vitest";
import type { GameCheckpoint } from "../../src/core/Checkpoint";
import type { SavedLobbySeat } from "../../src/core/Schemas";
import {
  aliveClientIdsFromCheckpoint,
  rankedResumeRequiredSeats,
} from "../../src/server/ranking/ResumeEligibility";

function seat(
  clientID: string,
  options: {
    persistentID?: string;
    publicId?: string;
    spectator?: boolean;
  } = {},
): SavedLobbySeat {
  return {
    clientID,
    persistentID: options.persistentID ?? `${clientID}-pid`,
    publicId: options.publicId,
    trusted: false,
    spectator: options.spectator,
    username: `user_${clientID}`,
    clanTag: null,
  } as SavedLobbySeat;
}

function checkpoint(
  players: { clientID: string | null }[],
  stats: Record<string, { deathPosition?: number }> = {},
): GameCheckpoint {
  return {
    players: players.map((p) => ({ playerInfo: { clientID: p.clientID } })),
    stats,
  } as unknown as GameCheckpoint;
}

describe("aliveClientIdsFromCheckpoint", () => {
  test("keeps living humans and drops dead ones, bots and nations", () => {
    expect(
      aliveClientIdsFromCheckpoint(
        checkpoint(
          [
            { clientID: "aaaaaaa1" },
            { clientID: "aaaaaaa2" },
            { clientID: "aaaaaaa3" },
            { clientID: null },
          ],
          { aaaaaaa2: { deathPosition: 3 } },
        ),
      ),
    ).toEqual(["aaaaaaa1", "aaaaaaa3"]);
  });

  test("a human with no stats record has not died yet", () => {
    expect(
      aliveClientIdsFromCheckpoint(checkpoint([{ clientID: "aaaaaaa1" }], {})),
    ).toEqual(["aaaaaaa1"]);
  });
});

describe("rankedResumeRequiredSeats", () => {
  const seats = [
    seat("aaaaaaa1", { publicId: "p1" }),
    seat("aaaaaaa2", { publicId: "p2" }),
    seat("aaaaaaa3", { spectator: true }),
  ];

  test("requires the checkpoint's alive seats only", () => {
    expect(rankedResumeRequiredSeats(seats, ["aaaaaaa1"])).toEqual([
      "aaaaaaa1",
    ]);
  });

  test("falls back to every non-spectator seat without a checkpoint", () => {
    expect(rankedResumeRequiredSeats(seats, undefined)).toEqual([
      "aaaaaaa1",
      "aaaaaaa2",
    ]);
  });

  test("ignores alive ids that are not saved seats", () => {
    expect(rankedResumeRequiredSeats(seats, ["aaaaaaa2", "deadbeef"])).toEqual([
      "aaaaaaa2",
    ]);
  });
});
