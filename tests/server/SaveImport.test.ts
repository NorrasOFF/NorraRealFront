import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  CHECKPOINT_VERSION,
  type GameCheckpoint,
} from "../../src/core/Checkpoint";
import { encodeCheckpoint } from "../../src/core/CheckpointCodec";
import {
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
} from "../../src/core/game/Game";
import { SAVED_GAME_VERSION, type SavedGame } from "../../src/core/Schemas";
import {
  decodeImportedSavedGame,
  encodeExportedSavedGame,
  savedGameFromSavedLobby,
  savedLobbyFromSavedGame,
} from "../../src/server/SaveImport";
import { MemorySaveStore } from "../../src/server/SaveStore";
import { makeGame } from "../util/GameServerHarness";

function makeSave(overrides: Partial<SavedGame> = {}): SavedGame {
  return {
    version: SAVED_GAME_VERSION,
    saveId: "GAME0001",
    gameID: "GAME0001",
    label: "Asia · Alice",
    savedAt: 1_700_000_000_000,
    gitCommit: "DEV",
    myClientID: "CLIENT01",
    startInfo: {
      gameID: "GAME0001",
      lobbyCreatedAt: 1_600_000_000_000,
      config: {
        gameMap: GameMapType.Asia,
        gameMapSize: GameMapSize.Normal,
        gameMode: GameMode.FFA,
        gameType: GameType.Private,
        difficulty: Difficulty.Medium,
        nations: "default",
        donateGold: false,
        donateTroops: false,
        bots: 0,
        infiniteGold: false,
        infiniteTroops: false,
        instantBuild: false,
        randomSpawn: false,
      },
      players: [
        { clientID: "CLIENT01", username: "Alice", clanTag: null },
        { clientID: "CLIENT02", username: "Bob", clanTag: null },
      ],
    },
    turns: [
      { turnNumber: 0, intents: [] },
      { turnNumber: 1, intents: [] },
    ],
    ...overrides,
  };
}

function sampleCheckpoint(ticks = 2): GameCheckpoint {
  return {
    version: CHECKPOINT_VERSION,
    ticks,
    startTick: null,
    isPaused: false,
    winner: null,
    nextPlayerID: 3,
    nextUnitID: 9,
    nextFleetId: 1,
    nextAllianceID: 2,
    unitsVersion: 7,
    territoryVersion: 11,
    map: {
      terrain: new Uint8Array([0, 1, 2, 255]),
      state: new Uint16Array([0, 1024, 65535]),
      numLandTiles: 2,
      numTilesWithFallout: 0,
      waterVersion: 1,
    },
    miniMap: {
      terrain: new Uint8Array([3, 4]),
      state: new Uint16Array([5]),
      numLandTiles: 1,
      numTilesWithFallout: 0,
      waterVersion: 0,
    },
    players: [],
    units: [],
    attacks: [],
    allianceRequests: [],
    alliances: [],
    stats: {},
    numMirvsLaunched: 0n,
    executions: [],
    execsCount: 0,
  } as unknown as GameCheckpoint;
}

describe("SaveImport", () => {
  describe("decodeImportedSavedGame", () => {
    it("reads a gzipped save file", async () => {
      const save = makeSave();
      const bytes = gzipSync(Buffer.from(JSON.stringify(save)));
      expect(await decodeImportedSavedGame(bytes)).toEqual(save);
    });

    it("reads a plain JSON save file", async () => {
      const save = makeSave();
      const bytes = Buffer.from(JSON.stringify(save));
      expect(await decodeImportedSavedGame(bytes)).toEqual(save);
    });

    it("rejects non-JSON bytes", async () => {
      await expect(
        decodeImportedSavedGame(Buffer.from("not a save")),
      ).rejects.toThrow();
    });

    it("rejects a gzipped non-save", async () => {
      const bytes = gzipSync(Buffer.from('{"hello":"world"}'));
      await expect(decodeImportedSavedGame(bytes)).rejects.toThrow();
    });
  });

  describe("savedLobbyFromSavedGame", () => {
    const options = {
      creatorPersistentID: "11111111-1111-1111-1111-111111111111",
      gitCommit: "BUILD1",
      now: 42,
    };

    it("builds a started lobby with the caller as creator", async () => {
      const lobby = await savedLobbyFromSavedGame(makeSave(), options);
      expect(lobby.gameID).toBe("GAME0001");
      expect(lobby.stage).toBe("started");
      expect(lobby.creatorPersistentID).toBe(options.creatorPersistentID);
      expect(lobby.gitCommit).toBe("BUILD1");
      expect(lobby.savedAt).toBe(42);
      expect(lobby.gameConfig).toEqual(makeSave().startInfo.config);
      expect(lobby.gameStartInfo).toEqual(makeSave().startInfo);
    });

    it("stamps only the creator's seat with their persistentID", async () => {
      const lobby = await savedLobbyFromSavedGame(makeSave(), options);
      const mine = lobby.seats.find((s) => s.clientID === "CLIENT01");
      const other = lobby.seats.find((s) => s.clientID === "CLIENT02");
      expect(mine?.persistentID).toBe(options.creatorPersistentID);
      expect(other?.persistentID).toBe("");
    });

    it("keeps a decodable checkpoint and records its turn", async () => {
      const save = makeSave({
        checkpoint: encodeCheckpoint(sampleCheckpoint(2)),
      });
      const lobby = await savedLobbyFromSavedGame(save, options);
      expect(lobby.checkpoint).toBe(save.checkpoint);
      expect(lobby.checkpointTurn).toBe(2);
    });

    it("drops an undecodable checkpoint", async () => {
      const save = makeSave({ checkpoint: "not-a-checkpoint" });
      const lobby = await savedLobbyFromSavedGame(save, options);
      expect(lobby.checkpoint).toBeUndefined();
      expect(lobby.checkpointTurn).toBeUndefined();
    });

    it("persists and restores an imported lobby as a live game", async () => {
      const lobby = await savedLobbyFromSavedGame(makeSave(), options);
      const store = new MemorySaveStore();
      await store.save(lobby, 0);
      const loaded = await store.load(lobby.gameID);
      expect(loaded).not.toBeNull();

      const game = makeGame({
        id: lobby.gameID,
        restore: loaded!,
        buildHash: "BUILD1",
      });
      expect(game.isRestored()).toBe(true);
      expect(game.claimableSeats().map((s) => s.clientID)).toEqual([
        "CLIENT01",
        "CLIENT02",
      ]);
    });
  });

  describe("savedGameFromSavedLobby", () => {
    const options = {
      creatorPersistentID: "11111111-1111-1111-1111-111111111111",
      gitCommit: "BUILD1",
      now: 42,
    };

    it("round-trips a started lobby back to a portable save", async () => {
      const original = makeSave();
      const lobby = await savedLobbyFromSavedGame(original, options);
      const portable = await savedGameFromSavedLobby(lobby);
      expect(portable.version).toBe(SAVED_GAME_VERSION);
      expect(portable.gameID).toBe(original.gameID);
      expect(portable.startInfo).toEqual(original.startInfo);
      expect(portable.turns).toEqual(original.turns);
      expect(portable.myClientID).toBe("CLIENT01");
    });

    it("drops seat PII when synthesizing startInfo for an unstarted save", async () => {
      const lobby = await savedLobbyFromSavedGame(makeSave(), options);
      const portable = await savedGameFromSavedLobby({
        ...lobby,
        stage: "lobby",
        gameStartInfo: undefined,
      });
      expect(portable.startInfo.players.map((p) => p.clientID)).toEqual([
        "CLIENT01",
        "CLIENT02",
      ]);
      for (const player of portable.startInfo.players) {
        expect(player).not.toHaveProperty("persistentID");
        expect(player).not.toHaveProperty("publicId");
        expect(player).not.toHaveProperty("trusted");
        expect(player).not.toHaveProperty("spectator");
      }
      expect(JSON.stringify(portable)).not.toContain(
        options.creatorPersistentID,
      );
    });

    it("keeps a decodable checkpoint", async () => {
      const save = makeSave({
        checkpoint: encodeCheckpoint(sampleCheckpoint(2)),
      });
      const lobby = await savedLobbyFromSavedGame(save, options);
      const portable = await savedGameFromSavedLobby(lobby);
      expect(portable.checkpoint).toBe(save.checkpoint);
    });

    it("gzip-encodes a save the import boundary accepts", async () => {
      const lobby = await savedLobbyFromSavedGame(makeSave(), options);
      const portable = await savedGameFromSavedLobby(lobby);
      const bytes = await encodeExportedSavedGame(portable);
      expect(await decodeImportedSavedGame(bytes)).toEqual(portable);
    });
  });
});
