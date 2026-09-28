import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// SavesModal talks to the game API and the local IndexedDB store; both are
// stubbed so these tests only exercise the resume -> private-lobby hand-off.
const api = vi.hoisted(() => ({
  listSavedLobbies: vi.fn(),
  resumeSavedLobby: vi.fn(),
  deleteSavedLobby: vi.fn(),
  importSavedLobby: vi.fn(),
  exportSavedLobby: vi.fn(),
}));

vi.mock("../../src/client/Api", () => ({
  listSavedLobbies: api.listSavedLobbies,
  resumeSavedLobby: api.resumeSavedLobby,
  deleteSavedLobby: api.deleteSavedLobby,
  importSavedLobby: api.importSavedLobby,
  exportSavedLobby: api.exportSavedLobby,
}));

const store = vi.hoisted(() => ({
  listSaves: vi.fn(async () => []),
  loadSave: vi.fn(),
  deleteSave: vi.fn(),
  saveGame: vi.fn(),
}));

vi.mock("../../src/client/SaveStore", () => store);

const saveFile = vi.hoisted(() => ({
  decodeSaveFile: vi.fn(),
  downloadSaveFile: vi.fn(),
  encodeSaveFile: vi.fn(),
  saveFileName: vi.fn(() => "save.json.gz"),
  MAX_SAVE_FILE_BYTES: 64 * 1024 * 1024,
}));

vi.mock("../../src/client/SaveFile", () => saveFile);

import { ClientEnv } from "../../src/client/ClientEnv";
import { SavesModal } from "../../src/client/SavesModal";

function setConfig() {
  (window as unknown as { BOOTSTRAP_CONFIG: object }).BOOTSTRAP_CONFIG = {
    gameEnv: "dev",
    numWorkers: 1,
    turnstileSiteKey: "x",
    jwtAudience: "localhost",
    instanceId: "test",
    gitCommit: "DEV",
  };
  ClientEnv.reset();
}

interface StubLobby extends HTMLElement {
  open: ReturnType<typeof vi.fn>;
}

function stubLobby(tag: string): StubLobby {
  const el = document.createElement(tag) as StubLobby;
  el.open = vi.fn();
  document.body.appendChild(el);
  return el;
}

const startedSave = {
  gameID: "GAME0001",
  label: "World · host",
  createdAt: 1,
  savedAt: 2,
  stage: "started" as const,
  numTurns: 10,
  playerCount: 2,
  gameMap: "World",
  gitCommit: "DEV",
};

const lobbySave = {
  ...startedSave,
  gameID: "GAME0002",
  stage: "lobby" as const,
};

describe("SavesModal server-save reopen", () => {
  beforeEach(() => {
    setConfig();
    api.listSavedLobbies.mockResolvedValue({
      saves: [startedSave, lobbySave],
      workers: 1,
      errors: [],
    });
    api.resumeSavedLobby.mockResolvedValue([]);
    document.body.innerHTML = "";
  });

  afterEach(() => {
    delete (window as unknown as { BOOTSTRAP_CONFIG?: object })
      .BOOTSTRAP_CONFIG;
    document.body.innerHTML = "";
    ClientEnv.reset();
    vi.clearAllMocks();
  });

  it("rebuilds a started save and opens the host lobby in resume mode", async () => {
    const host = stubLobby("host-lobby-modal");
    const join = stubLobby("join-lobby-modal");
    const modal = new SavesModal();

    await (modal as any).selectServerSave(startedSave);

    expect(api.resumeSavedLobby).toHaveBeenCalledWith("GAME0001");
    expect(host.open).toHaveBeenCalledWith({
      existingLobbyId: "GAME0001",
      resume: true,
    });
    expect(join.open).not.toHaveBeenCalled();
  });

  it("rebuilds a not-yet-started save and opens the host lobby in resume mode", async () => {
    const host = stubLobby("host-lobby-modal");
    const join = stubLobby("join-lobby-modal");
    const modal = new SavesModal();

    await (modal as any).selectServerSave(lobbySave);

    expect(api.resumeSavedLobby).toHaveBeenCalledWith("GAME0002");
    expect(host.open).toHaveBeenCalledWith({
      existingLobbyId: "GAME0002",
      resume: true,
    });
    expect(join.open).not.toHaveBeenCalled();
  });

  it("does not open a lobby when the resume request fails", async () => {
    const host = stubLobby("host-lobby-modal");
    const join = stubLobby("join-lobby-modal");
    api.resumeSavedLobby.mockRejectedValue(new Error("HTTP 404"));
    const modal = new SavesModal();

    await (modal as any).selectServerSave(startedSave);

    expect(host.open).not.toHaveBeenCalled();
    expect(join.open).not.toHaveBeenCalled();
    expect((modal as any).error).not.toBe("");
  });

  it("imports a file as a lobby and forces a rebuild from it", async () => {
    const host = stubLobby("host-lobby-modal");
    const imported = {
      gameID: "GAME0001",
      saveId: "GAME0001",
      label: "World · host",
      savedAt: 2,
      gitCommit: "DEV",
      myClientID: "CLIENT01",
      startInfo: { gameID: "GAME0001", lobbyCreatedAt: 1, config: {} },
      turns: [],
    };
    saveFile.decodeSaveFile.mockResolvedValue(imported);
    const modal = new SavesModal();
    const file = {
      size: 8,
      arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
    } as unknown as File;

    await (modal as any).onImportLobbyFile({
      target: { files: [file], value: "" },
    });

    expect(api.importSavedLobby).toHaveBeenCalledWith(
      "GAME0001",
      expect.any(Uint8Array),
    );
    // The imported file must win over any live copy of the same game.
    expect(api.resumeSavedLobby).toHaveBeenCalledWith("GAME0001", {
      force: true,
    });
    expect(host.open).toHaveBeenCalledWith({
      existingLobbyId: "GAME0001",
      resume: true,
    });
  });
});
