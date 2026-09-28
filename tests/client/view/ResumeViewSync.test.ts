/**
 * Client half of the resume view resync: a single full-sync GameUpdateViewData
 * (the shape GameImpl.emitFullViewSync produces after a checkpoint restore)
 * must take a fresh GameView out of spawn phase and rebuild its territory and
 * units. Without it a resumed view stayed in spawn phase with an empty map.
 */

import { beforeAll, describe, expect, it, vi } from "vitest";
import { UnitType } from "../../../src/core/game/Game";
import { GameUpdateType } from "../../../src/core/game/GameUpdates";
import {
  makeEmptyGu,
  makeGameView,
  makePlayerUpdate,
  makeUnitUpdate,
} from "../../util/viewStubs";

beforeAll(() => {
  // UserSettings reads the global localStorage directly. Node 26 ships an
  // experimental one that is undefined without --localstorage-file, so stub it
  // (jsdom in CI provides a real one).
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
    key: () => null,
    length: 0,
  });
});

describe("resume full view sync", () => {
  it("leaves spawn phase and rebuilds territory and units in one update", () => {
    const game = makeGameView({ width: 10, height: 10 });

    // packed tile updates are [tileRef, state] pairs; owner id 1 in the low
    // bits. This stands in for the base territory a checkpoint carries.
    const gu = makeEmptyGu(5000, {
      packedTileUpdates: new Uint32Array([10, 1, 11, 1, 20, 1]),
    });
    gu.updates[GameUpdateType.Player] = [
      makePlayerUpdate({ id: "alice", smallID: 1, isAlive: true }),
    ];
    gu.updates[GameUpdateType.Unit] = [
      makeUnitUpdate({
        id: 7,
        ownerID: 1,
        unitType: UnitType.City,
        pos: 10,
        lastPos: 10,
        isActive: true,
      }),
    ];
    gu.updates[GameUpdateType.SpawnPhaseEnd] = [
      { type: GameUpdateType.SpawnPhaseEnd, startTick: 30 },
    ];

    game.update(gu);

    expect(game.inSpawnPhase()).toBe(false);
    expect(game.hasOwner(10)).toBe(true);
    expect(game.playerBySmallID(1).id()).toBe("alice");
    expect(game.units(UnitType.City).length).toBe(1);
  });
});
