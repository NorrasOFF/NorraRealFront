import { gzipSync } from "node:zlib";
import { beforeEach, describe, expect, it } from "vitest";
import {
  decodeSaveFile,
  encodeSaveFile,
  SAVE_FILE_EXTENSION,
  saveFileName,
} from "../../src/client/SaveFile";
import {
  loadSave,
  MemorySaveBackend,
  saveGame,
  setSaveBackend,
} from "../../src/client/SaveStore";
import {
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
} from "../../src/core/game/Game";
import { SAVED_GAME_VERSION, type SavedGame } from "../../src/core/Schemas";

// jsdom does not expose the Compression Streams API; use Node's.
if (typeof globalThis.CompressionStream === "undefined") {
  const streamWeb = await import("node:stream/web");
  (globalThis as any).CompressionStream = streamWeb.CompressionStream;
}
if (typeof globalThis.DecompressionStream === "undefined") {
  const streamWeb = await import("node:stream/web");
  (globalThis as any).DecompressionStream = streamWeb.DecompressionStream;
}

function makeSave(overrides: Partial<SavedGame> = {}): SavedGame {
  return {
    version: SAVED_GAME_VERSION,
    saveId: "SAVE0001",
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
        gameType: GameType.Singleplayer,
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

describe("SaveFile", () => {
  beforeEach(() => {
    setSaveBackend(new MemorySaveBackend());
  });

  describe("saveFileName", () => {
    it("sanitizes an accented label with separators", () => {
      expect(
        saveFileName({ label: "Asia · Alïce/Bob", gameID: "GAME0001" }),
      ).toBe(`Asia_Alice_Bob-GAME0001${SAVE_FILE_EXTENSION}`);
    });

    it("falls back to 'save' when the label is all punctuation", () => {
      expect(saveFileName({ label: "···", gameID: "GAME0001" })).toBe(
        `save-GAME0001${SAVE_FILE_EXTENSION}`,
      );
    });

    it("caps the label stem length", () => {
      expect(saveFileName({ label: "A".repeat(100), gameID: "GAME0001" })).toBe(
        `${"A".repeat(60)}-GAME0001${SAVE_FILE_EXTENSION}`,
      );
    });
  });

  it("round-trips a save through gzip", async () => {
    const save = makeSave({ checkpoint: "gz:AAAA" });
    const bytes = await encodeSaveFile(save);
    // Gzip magic number, so the file is actually compressed.
    expect(bytes[0]).toBe(0x1f);
    expect(bytes[1]).toBe(0x8b);
    expect(await decodeSaveFile(bytes)).toEqual(save);
  });

  it("accepts a plain, uncompressed JSON save", async () => {
    const save = makeSave();
    const bytes = new TextEncoder().encode(JSON.stringify(save));
    expect(await decodeSaveFile(bytes)).toEqual(save);
  });

  it("rejects arbitrary non-JSON bytes", async () => {
    await expect(
      decodeSaveFile(new TextEncoder().encode("not a save")),
    ).rejects.toThrow();
  });

  it("rejects gzipped JSON that is not a save", async () => {
    const bytes = new Uint8Array(gzipSync(Buffer.from('{"hello":"world"}')));
    await expect(decodeSaveFile(bytes)).rejects.toThrow();
  });

  it("rejects a save from another version", async () => {
    const save = { ...makeSave(), version: "v9.9.9" };
    const bytes = new TextEncoder().encode(JSON.stringify(save));
    await expect(decodeSaveFile(bytes)).rejects.toThrow();
  });

  it("bounds the decompressed size", async () => {
    const bytes = await encodeSaveFile(makeSave());
    await expect(decodeSaveFile(bytes, 1)).rejects.toThrow();
  });

  it("imports a decoded save into the local store", async () => {
    const save = makeSave();
    const bytes = await encodeSaveFile(save);
    const decoded = await decodeSaveFile(bytes);
    await saveGame(decoded);
    expect(await loadSave(save.saveId)).toEqual(save);
  });
});
