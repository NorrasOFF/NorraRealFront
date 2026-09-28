import { SpawnExecution } from "../../src/core/execution/SpawnExecution";
import { WinCheckExecution } from "../../src/core/execution/WinCheckExecution";
import { PlayerInfo, PlayerType, UnitType } from "../../src/core/game/Game";
import { GameImpl } from "../../src/core/game/GameImpl";
import { GameUpdateType } from "../../src/core/game/GameUpdates";
import { GameID } from "../../src/core/Schemas";
import { setup } from "../util/Setup";
import { executeTicks } from "../util/utils";

const gameID: GameID = "view_sync_game";

/**
 * Two spawned humans with a city each, on a small land/ocean map. Mirrors the
 * shape of tests/core/Checkpoint.test.ts so a checkpoint can be captured and
 * restored.
 */
async function buildGame(): Promise<GameImpl> {
  const game = (await setup("ocean_and_land", {
    infiniteGold: true,
    instantBuild: true,
    infiniteTroops: true,
  })) as GameImpl;

  const alpha = new PlayerInfo(
    "alpha",
    PlayerType.Human,
    "client_alpha",
    "alpha_id",
  );
  const beta = new PlayerInfo(
    "beta",
    PlayerType.Human,
    "client_beta",
    "beta_id",
  );
  game.addPlayer(alpha);
  game.addPlayer(beta);

  game.addExecution(
    new SpawnExecution(gameID, game.player(alpha.id).info(), game.ref(0, 15)),
    new SpawnExecution(gameID, game.player(beta.id).info(), game.ref(0, 10)),
  );
  executeTicks(game, 2);
  game.addExecution(new WinCheckExecution());

  // Advance past the spawn phase (spawn end is a one-shot update), then give
  // each player a structure so the checkpoint has units to restore.
  executeTicks(game, 78);
  for (const id of [alpha.id, beta.id]) {
    const player = game.player(id);
    const tile = [...player.tiles()].find((t) => game.isLand(t));
    if (tile !== undefined) {
      player.buildUnit(UnitType.City, tile, {});
    }
  }
  executeTicks(game, 5);

  return game;
}

/** Total tile updates drained from the game's transferable buffer. */
function drainTilePairs(game: GameImpl): number {
  return game.drainPackedTileUpdates().length;
}

describe("resume view resync", () => {
  test("the first tick after a restore emits a full view snapshot", async () => {
    const original = await buildGame();
    const checkpoint = original.checkpoint();
    expect(checkpoint).toBeDefined();
    expect(checkpoint!.startTick).not.toBeNull();

    const restored = await buildGame();
    restored.restoreFromCheckpoint(checkpoint!);
    expect(restored.inSpawnPhase()).toBe(false);

    // The pre-restore suffix is skipped on resume, so the client's view is
    // rebuilt entirely from updates. The restored game knows the whole map, so
    // its first tick must hand the client a complete snapshot: the spawn-phase
    // end (or the view stays in spawn phase), every owned tile (or the map
    // renders empty), and every live unit (or cities/ships vanish).
    const updates = restored.executeNextTick();

    expect(updates[GameUpdateType.SpawnPhaseEnd].length).toBe(1);
    expect(drainTilePairs(restored)).toBeGreaterThan(10);
    expect(updates[GameUpdateType.Unit].length).toBeGreaterThan(0);
  });
});
