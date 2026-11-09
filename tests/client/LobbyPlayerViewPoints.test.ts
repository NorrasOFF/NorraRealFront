import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { GameMode } from "../../src/core/game/Game";
import type { ClientInfo } from "../../src/core/Schemas";

// UserSettings (used by the theme and the component) reads the global
// localStorage directly. Node ships an experimental one that is undefined
// without --localstorage-file, so stub it (jsdom in CI provides a real one).
beforeAll(() => {
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
    key: () => null,
    length: 0,
  });
});

import "../../src/client/components/LobbyPlayerView";

afterEach(() => {
  document.body.innerHTML = "";
});

function player(overrides: Partial<ClientInfo>): ClientInfo {
  return {
    clientID: "c1000000",
    username: "Player",
    clanTag: null,
    ...overrides,
  };
}

async function mount(clients: ClientInfo[], gameMode: GameMode) {
  const view = document.createElement("lobby-player-view") as any;
  view.gameMode = gameMode;
  view.clients = clients;
  view.teamCount = 2;
  view.lobbyCreatorClientID = "c1000000";
  view.currentClientID = "c1000000";
  document.body.append(view);
  await view.updateComplete;
  return view as HTMLElement;
}

describe("lobby player view ranked points are hidden", () => {
  it("never renders the rating even when the wire still carries it", async () => {
    const view = await mount(
      [
        player({ clientID: "c1000000", username: "Alice", elo: 1850 }),
        player({ clientID: "c2000000", username: "Bob", elo: 1420 }),
      ],
      GameMode.Team,
    );

    expect(view.textContent).toContain("Alice");
    expect(view.textContent).toContain("Bob");
    expect(view.textContent).not.toContain("1850");
    expect(view.textContent).not.toContain("1420");
    expect(view.querySelectorAll(".ranked-points").length).toBe(0);
  });

  it("renders no points outside a ranked lobby", async () => {
    const view = await mount(
      [
        player({ clientID: "c1000000", username: "Alice" }),
        player({ clientID: "c2000000", username: "Bob" }),
      ],
      GameMode.Team,
    );

    expect(view.textContent).toContain("Alice");
    expect(view.querySelectorAll(".ranked-points").length).toBe(0);
  });

  it("hides points in FFA rosters too", async () => {
    const view = await mount(
      [player({ clientID: "c1000000", username: "Alice", elo: 1999 })],
      GameMode.FFA,
    );

    expect(view.textContent).toContain("Alice");
    expect(view.textContent).not.toContain("1999");
  });
});
