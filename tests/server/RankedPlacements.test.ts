// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  computeRankedPlacements,
  type RankedPlacementParticipant,
  type RankedPlacementStats,
} from "../../src/server/ranking/Placements";

function participant(
  publicId: string,
  clientID = `client-${publicId}`,
  teamIndex?: number,
): RankedPlacementParticipant {
  return { publicId, clientID, teamIndex };
}

describe("computeRankedPlacements", () => {
  test("orders winner, survivors by tiles, then elimination order", () => {
    const placements = computeRankedPlacements(
      [
        participant("w"),
        participant("a"),
        participant("b"),
        participant("c"),
        participant("d"),
      ],
      {
        "client-w": { finalTiles: 1000n },
        "client-a": { finalTiles: 500n },
        "client-b": { finalTiles: 100n },
        "client-c": { deathPosition: 2 },
        "client-d": { deathPosition: 5 },
      } satisfies Record<string, RankedPlacementStats>,
      ["w"],
    );

    expect(placements).toEqual([
      { publicId: "w", place: 1, teamSize: 1 },
      { publicId: "a", place: 2, teamSize: 1 },
      { publicId: "b", place: 3, teamSize: 1 },
      { publicId: "c", place: 4, teamSize: 1 },
      { publicId: "d", place: 5, teamSize: 1 },
    ]);
  });

  test("normalises places densely when nations consumed positions", () => {
    // deathPosition counts every non-bot still standing, so a nation can push
    // the raw value past the number of rated players. Places stay 1..N.
    const placements = computeRankedPlacements(
      [participant("w"), participant("late"), participant("early")],
      {
        "client-w": { finalTiles: 10n },
        "client-late": { deathPosition: 7 },
        "client-early": { deathPosition: 9 },
      },
      ["w"],
    );

    expect(placements.map((p) => p.place)).toEqual([1, 2, 3]);
    expect(placements.map((p) => p.publicId)).toEqual(["w", "late", "early"]);
  });

  test("teammates share the best place and report their team size", () => {
    const placements = computeRankedPlacements(
      [
        participant("w", "client-w", 0),
        participant("c", "client-c", 1),
        participant("d", "client-d", 1),
      ],
      {
        "client-w": { finalTiles: 100n },
        "client-c": { deathPosition: 2 },
        "client-d": { deathPosition: 3 },
      },
      ["w"],
    );

    expect(placements).toEqual([
      { publicId: "w", place: 1, teamSize: 1 },
      { publicId: "c", place: 2, teamSize: 2 },
      { publicId: "d", place: 2, teamSize: 2 },
    ]);
  });

  test("counts every teammate when splitting a larger team", () => {
    const placements = computeRankedPlacements(
      [
        participant("a", "client-a", 0),
        participant("b", "client-b", 0),
        participant("c", "client-c", 0),
        participant("x", "client-x", 1),
      ],
      {
        "client-a": { finalTiles: 100n },
        "client-b": { finalTiles: 90n },
        "client-c": { finalTiles: 80n },
        "client-x": { deathPosition: 4 },
      },
      ["a", "b", "c"],
    );

    expect(placements).toEqual([
      { publicId: "a", place: 1, teamSize: 3 },
      { publicId: "b", place: 1, teamSize: 3 },
      { publicId: "c", place: 1, teamSize: 3 },
      { publicId: "x", place: 4, teamSize: 1 },
    ]);
  });

  test("ranks a participant without stats last", () => {
    const placements = computeRankedPlacements(
      [participant("w"), participant("gone"), participant("dead")],
      {
        "client-w": { finalTiles: 10n },
        "client-dead": { deathPosition: 3 },
      },
      ["w"],
    );

    expect(placements.map((p) => p.publicId)).toEqual(["w", "dead", "gone"]);
  });

  test("collapses duplicate accounts and breaks ties deterministically", () => {
    const placements = computeRankedPlacements(
      [
        participant("same", "client-1"),
        participant("same", "client-2"),
        participant("b", "client-b"),
        participant("a", "client-a"),
      ],
      {
        "client-1": { deathPosition: 2 },
        "client-2": { finalTiles: 999n },
        "client-a": { deathPosition: 4 },
        "client-b": { deathPosition: 4 },
      },
      [],
    );

    expect(placements).toEqual([
      // "same" is one account; its first client is the one that counts.
      { publicId: "same", place: 1, teamSize: 1 },
      { publicId: "a", place: 2, teamSize: 1 },
      { publicId: "b", place: 3, teamSize: 1 },
    ]);
  });
});
