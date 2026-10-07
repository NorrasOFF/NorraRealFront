import { describe, expect, test } from "vitest";
import {
  distanceSqToSegment,
  planDefenseLineActions,
  samThreatensNukePreview,
  shouldPreserveGhostAfterBuild,
} from "../../../src/client/controllers/BuildPreviewController";
import { UnitType } from "../../../src/core/game/Game";

describe("BuildPreviewController ghost preservation (locked nuke / Enter confirm)", () => {
  describe("shouldPreserveGhostAfterBuild", () => {
    test("returns true for AtomBomb so ghost is not cleared after placement", () => {
      expect(shouldPreserveGhostAfterBuild(UnitType.AtomBomb)).toBe(true);
    });

    test("returns true for HydrogenBomb so ghost is not cleared after placement", () => {
      expect(shouldPreserveGhostAfterBuild(UnitType.HydrogenBomb)).toBe(true);
    });

    test("returns false for City so ghost is cleared after placement", () => {
      expect(shouldPreserveGhostAfterBuild(UnitType.City)).toBe(false);
    });

    test("returns false for Factory so ghost is cleared after placement", () => {
      expect(shouldPreserveGhostAfterBuild(UnitType.Factory)).toBe(false);
    });

    test("returns false for other buildable types (Port, DefensePost, MissileSilo, SAMLauncher, Warship, MIRV)", () => {
      expect(shouldPreserveGhostAfterBuild(UnitType.Port)).toBe(false);
      expect(shouldPreserveGhostAfterBuild(UnitType.DefensePost)).toBe(false);
      expect(shouldPreserveGhostAfterBuild(UnitType.MissileSilo)).toBe(false);
      expect(shouldPreserveGhostAfterBuild(UnitType.SAMLauncher)).toBe(false);
      expect(shouldPreserveGhostAfterBuild(UnitType.Warship)).toBe(false);
      expect(shouldPreserveGhostAfterBuild(UnitType.MIRV)).toBe(false);
    });
  });
});

describe("planDefenseLineActions (drag upgrade defense posts)", () => {
  const tiles = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 20, y: 0 },
  ];

  test("upgrades an owned post on the line and builds on far samples", () => {
    const actions = planDefenseLineActions(
      tiles,
      [{ id: 42, x: 10, y: 0 }],
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      3,
      1,
    );
    expect(actions).toEqual([
      { kind: "upgrade", unitId: 42, amount: 1 },
      { kind: "build", x: 0, y: 0 },
      { kind: "build", x: 20, y: 0 },
    ]);
  });

  test("upgrades every post the line passes over, including ones between samples", () => {
    const actions = planDefenseLineActions(
      [
        { x: 0, y: 0 },
        { x: 30, y: 0 },
      ],
      [
        { id: 1, x: 10, y: 0 },
        { id: 2, x: 20, y: 0 },
      ],
      { x: 0, y: 0 },
      { x: 30, y: 0 },
      3,
      1,
    );
    expect(actions.filter((a) => a.kind === "upgrade")).toEqual([
      { kind: "upgrade", unitId: 1, amount: 1 },
      { kind: "upgrade", unitId: 2, amount: 1 },
    ]);
  });

  test("uses the requested upgrade amount (5 on double-tap)", () => {
    const actions = planDefenseLineActions(
      [],
      [{ id: 7, x: 5, y: 0 }],
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      3,
      5,
    );
    expect(actions).toContainEqual({ kind: "upgrade", unitId: 7, amount: 5 });
  });

  test("an all-empty line is all builds", () => {
    const actions = planDefenseLineActions(
      [
        { x: 0, y: 0 },
        { x: 20, y: 0 },
      ],
      [],
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      3,
      5,
    );
    expect(actions).toEqual([
      { kind: "build", x: 0, y: 0 },
      { kind: "build", x: 20, y: 0 },
    ]);
  });

  test("posts off the line are left alone", () => {
    const actions = planDefenseLineActions(
      [{ x: 0, y: 0 }],
      [{ id: 9, x: 10, y: 20 }],
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      3,
      1,
    );
    expect(actions).toEqual([{ kind: "build", x: 0, y: 0 }]);
  });

  test("a sample within radius of a post is not built on", () => {
    const actions = planDefenseLineActions(
      [{ x: 12, y: 0 }],
      [{ id: 5, x: 10, y: 0 }],
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      3,
      1,
    );
    expect(actions).toEqual([{ kind: "upgrade", unitId: 5, amount: 1 }]);
  });
});

describe("distanceSqToSegment", () => {
  test("point on the segment is zero", () => {
    expect(distanceSqToSegment(10, 0, 0, 0, 20, 0)).toBe(0);
  });

  test("point beyond an endpoint clamps to the endpoint", () => {
    expect(distanceSqToSegment(30, 0, 0, 0, 20, 0)).toBe(100);
  });

  test("perpendicular distance", () => {
    expect(distanceSqToSegment(10, 4, 0, 0, 20, 0)).toBe(16);
  });

  test("degenerate segment is the point distance", () => {
    expect(distanceSqToSegment(3, 4, 0, 0, 0, 0)).toBe(25);
  });
});

describe("samThreatensNukePreview (nuke trajectory threat set, #4226)", () => {
  const teammates = new Set([7, 8]);
  const allies = new Set([2, 3]);

  test("non-friendly SAM threatens the trajectory", () => {
    expect(samThreatensNukePreview(5, teammates, allies, new Set())).toBe(true);
  });

  test("allied SAM does not threaten when the strike breaks no alliance", () => {
    expect(samThreatensNukePreview(2, teammates, allies, new Set())).toBe(
      false,
    );
  });

  test("would-be-betrayed ally's SAM threatens (alliance breaks at launch)", () => {
    expect(samThreatensNukePreview(2, teammates, allies, new Set([2]))).toBe(
      true,
    );
  });

  test("other allies' SAMs still excluded when a different ally is betrayed", () => {
    expect(samThreatensNukePreview(3, teammates, allies, new Set([2]))).toBe(
      false,
    );
  });

  test("teammate SAM does not threaten the trajectory", () => {
    expect(samThreatensNukePreview(7, teammates, new Set(), new Set())).toBe(
      false,
    );
  });

  test("teammate SAM stays excluded even if listed as betrayed (a strike never breaks a team)", () => {
    expect(
      samThreatensNukePreview(7, teammates, new Set([7]), new Set([7])),
    ).toBe(false);
  });
});
