import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AvoidConquestController,
  planAvoidConquest,
} from "../../../src/client/controllers/AvoidConquestController";
import { AvoidConquestBoxCompleteEvent } from "../../../src/client/InputHandler";
import { SendAvoidConquestIntentEvent } from "../../../src/client/Transport";
import { GameView } from "../../../src/client/view";
import { SpawnExecution } from "../../../src/core/execution/SpawnExecution";
import { Player, PlayerInfo, PlayerType } from "../../../src/core/game/Game";
import { TileRef } from "../../../src/core/game/GameMap";
import { GameID } from "../../../src/core/Schemas";
import { setup } from "../../util/Setup";

describe("planAvoidConquest (region toggle)", () => {
  const tiles = [1, 2, 3, 4, 5];
  const avoided = (ids: number[]) => {
    const set = new Set(ids);
    return (tile: number) => set.has(tile);
  };

  it("freezes a fresh zone completely", () => {
    const plan = planAvoidConquest(tiles, () => false);
    expect(plan.freeze).toBe(true);
    expect(plan.toggled).toEqual(tiles);
  });

  it("unfreezes a fully avoided zone completely", () => {
    const plan = planAvoidConquest(tiles, () => true);
    expect(plan.freeze).toBe(false);
    expect(plan.toggled).toEqual(tiles);
  });

  it("freezes all when a minority is avoided", () => {
    const plan = planAvoidConquest(tiles, avoided([1, 2]));
    expect(plan.freeze).toBe(true);
    expect(plan.toggled).toEqual([3, 4, 5]);
  });

  it("unfreezes all when a majority is avoided", () => {
    const plan = planAvoidConquest(tiles, avoided([1, 2, 3]));
    expect(plan.freeze).toBe(false);
    expect(plan.toggled).toEqual([1, 2, 3]);
  });

  it("freezes all on an exact tie", () => {
    const plan = planAvoidConquest([1, 2, 3, 4], avoided([1, 2]));
    expect(plan.freeze).toBe(true);
    expect(plan.toggled).toEqual([3, 4]);
  });

  it("returns an empty plan for an empty selection", () => {
    expect(planAvoidConquest([], () => true).toggled).toEqual([]);
  });
});

describe("AvoidConquestController region toggle", () => {
  const gameID: GameID = "game_id";
  let game: Awaited<ReturnType<typeof setup>>;
  let attacker: Player;
  let eventBus: {
    on: ReturnType<typeof vi.fn>;
    emit: ReturnType<typeof vi.fn>;
  };
  let transformHandler: {
    screenToWorldCoordinates: (
      x: number,
      y: number,
    ) => { x: number; y: number };
  };
  let renderer: { updateAvoidedTiles: ReturnType<typeof vi.fn> };
  let gameView: GameView;

  beforeEach(async () => {
    game = await setup("ocean_and_land", { infiniteTroops: true });
    const info = new PlayerInfo(
      "attacker",
      PlayerType.Human,
      null,
      "attacker_id",
    );
    game.addPlayer(info);
    game.addExecution(new SpawnExecution(gameID, info, game.ref(0, 10)));
    game.executeNextTick();
    game.executeNextTick();
    attacker = game.player(info.id);

    eventBus = { on: vi.fn(), emit: vi.fn() };
    transformHandler = {
      screenToWorldCoordinates: (x: number, y: number) => ({ x, y }),
    };
    renderer = { updateAvoidedTiles: vi.fn() };
    gameView = {
      myPlayer: () => attacker,
      width: () => game.width(),
      height: () => game.height(),
      ref: (x: number, y: number) => game.ref(x, y),
      ownerID: (ref: TileRef) => game.ownerID(ref),
      isWater: (ref: TileRef) => game.isWater(ref),
      isImpassable: (ref: TileRef) => game.isImpassable(ref),
      neighbors4: (ref: TileRef, out: TileRef[]) => game.neighbors4(ref, out),
      x: (ref: TileRef) => game.x(ref),
      y: (ref: TileRef) => game.y(ref),
    } as unknown as GameView;
  });

  function frontierTiles(): TileRef[] {
    const myID = attacker.smallID();
    const result = new Set<TileRef>();
    const nbuf: TileRef[] = [0, 0, 0, 0];
    attacker.tiles().forEach((tile) => {
      const n = game.neighbors4(tile, nbuf);
      for (let i = 0; i < n; i++) {
        const nb = nbuf[i];
        if (game.ownerID(nb) === myID) continue;
        if (game.isWater(nb) || game.isImpassable(nb)) continue;
        result.add(nb);
      }
    });
    return [...result];
  }

  function makeController(): AvoidConquestController {
    return new AvoidConquestController(
      gameView,
      eventBus as never,
      transformHandler as never,
      renderer as never,
    );
  }

  function avoidedOf(controller: AvoidConquestController): Set<TileRef> {
    return (controller as unknown as { avoided: Set<TileRef> }).avoided;
  }

  function drag(
    controller: AvoidConquestController,
    tiles: TileRef[],
  ): TileRef[] {
    const xs = tiles.map((t) => game.x(t));
    const ys = tiles.map((t) => game.y(t));
    (controller as unknown as { onBoxComplete: (e: unknown) => void })[
      "onBoxComplete"
    ](
      new AvoidConquestBoxCompleteEvent(
        Math.min(...xs),
        Math.min(...ys),
        Math.max(...xs),
        Math.max(...ys),
      ),
    );
    const emitted = eventBus.emit.mock.calls
      .map((c) => c[0])
      .find((e) => e instanceof SendAvoidConquestIntentEvent) as
      | SendAvoidConquestIntentEvent
      | undefined;
    return emitted?.tiles ?? [];
  }

  it("freezes every frontier tile in a fresh zone on one drag", () => {
    const frontier = frontierTiles();
    expect(frontier.length).toBeGreaterThan(1);

    const controller = makeController();
    const toggled = drag(controller, frontier);

    expect(new Set(toggled)).toEqual(new Set(frontier));
    expect(new Set(avoidedOf(controller))).toEqual(new Set(frontier));
  });

  it("unfreezes the whole zone on a second drag", () => {
    const frontier = frontierTiles();

    const controller = makeController();
    drag(controller, frontier);
    const toggled = drag(controller, frontier);

    expect(new Set(toggled)).toEqual(new Set(frontier));
    expect(avoidedOf(controller).size).toBe(0);
  });

  it("unfreezes all when a majority of the zone is already avoided", () => {
    const frontier = frontierTiles();
    const majority = frontier.slice(0, Math.ceil(frontier.length / 2) + 1);

    const controller = makeController();
    avoidedOf(controller).clear();
    for (const tile of majority) avoidedOf(controller).add(tile);

    const toggled = drag(controller, frontier);

    expect(new Set(toggled)).toEqual(new Set(majority));
    expect(avoidedOf(controller).size).toBe(0);
  });
});
