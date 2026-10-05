import {
  shipMoveInterval,
  shipShouldMove,
} from "../../src/core/execution/FleetFormation";
import { UnitType } from "../../src/core/game/Game";

describe("shipShouldMove", () => {
  test("warships move every tick", () => {
    const rate = shipMoveInterval(UnitType.Warship);
    for (let t = 0; t < 12; t++) {
      expect(shipShouldMove(rate, t)).toBe(true);
    }
  });

  test("missile ships move every 1.5 ticks (2 steps per 3 ticks)", () => {
    const rate = shipMoveInterval(UnitType.MissileShip);
    expect(rate).toBe(1.5);

    const moved: number[] = [];
    for (let t = 0; t < 12; t++) {
      if (shipShouldMove(rate, t)) moved.push(t);
    }

    // 8 steps in 12 ticks is one every 1.5 ticks on average.
    expect(moved.length).toBe(8);
    // The gap between steps is always 1 or 2 ticks.
    for (let i = 1; i < moved.length; i++) {
      const gap = moved[i] - moved[i - 1];
      expect(gap === 1 || gap === 2).toBe(true);
    }
  });

  test("missile defense ships share the 1.5-tick rate", () => {
    expect(shipMoveInterval(UnitType.MissileDefenseShip)).toBe(1.5);
  });

  test("an integer 2-tick rate still steps on even ticks", () => {
    for (let t = 0; t < 12; t++) {
      expect(shipShouldMove(2, t)).toBe(t % 2 === 0);
    }
  });
});
