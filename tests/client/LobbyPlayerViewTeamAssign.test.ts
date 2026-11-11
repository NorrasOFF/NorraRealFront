import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { GameMode, HumansVsNations } from "../../src/core/game/Game";
import type { ClientInfo } from "../../src/core/Schemas";

// UserSettings reads the global localStorage directly (see the sibling
// LobbyPlayerView test). Node may not provide one.
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

async function mount(
  clients: ClientInfo[],
  opts: {
    teamCount?: any;
    onAssignTeam?: (clientID: string, teamIndex: number | null) => void;
  } = {},
) {
  const view = document.createElement("lobby-player-view") as any;
  view.gameMode = GameMode.Team;
  view.clients = clients;
  view.teamCount = opts.teamCount ?? 2;
  view.lobbyCreatorClientID = "c1000000";
  view.currentClientID = "c1000000";
  view.onAssignTeam = opts.onAssignTeam;
  document.body.append(view);
  await view.updateComplete;
  return view as HTMLElement;
}

function selectFor(view: HTMLElement, clientID: string): HTMLSelectElement {
  const select = view.querySelector(
    `[data-client-id="${clientID}"] select`,
  ) as HTMLSelectElement | null;
  if (select === null) throw new Error(`no team select for ${clientID}`);
  return select;
}

describe("lobby player view host team assignment", () => {
  it("shows a picker for the host and reports the chosen team", async () => {
    const onAssignTeam = vi.fn();
    const view = await mount(
      [
        player({ clientID: "c1000000", username: "Alice" }),
        player({ clientID: "c2000000", username: "Bob" }),
      ],
      { onAssignTeam },
    );

    const select = selectFor(view, "c2000000");
    // No pin yet: the picker shows Auto (first option) plus one per team.
    expect(select.value).toBe("");
    expect(select.options.length).toBe(3);

    select.value = "1";
    select.dispatchEvent(new Event("change"));

    expect(onAssignTeam).toHaveBeenCalledWith("c2000000", 1);
  });

  it("reports null when the host switches a player back to Auto", async () => {
    const onAssignTeam = vi.fn();
    const view = await mount(
      [
        player({ clientID: "c1000000", username: "Alice" }),
        player({ clientID: "c2000000", username: "Bob", teamIndex: 1 }),
      ],
      { onAssignTeam },
    );

    const select = selectFor(view, "c2000000");
    expect(select.value).toBe("1");

    select.value = "";
    select.dispatchEvent(new Event("change"));

    expect(onAssignTeam).toHaveBeenCalledWith("c2000000", null);
  });

  it("renders no picker for non-hosts", async () => {
    const view = await mount([
      player({ clientID: "c1000000", username: "Alice" }),
      player({ clientID: "c2000000", username: "Bob" }),
    ]);

    expect(view.querySelectorAll("[data-client-id]").length).toBe(0);
  });

  it("renders no picker in Humans vs Nations", async () => {
    const onAssignTeam = vi.fn();
    const view = await mount(
      [
        player({ clientID: "c1000000", username: "Alice" }),
        player({ clientID: "c2000000", username: "Bob" }),
      ],
      { teamCount: HumansVsNations, onAssignTeam },
    );

    expect(view.querySelectorAll("[data-client-id]").length).toBe(0);
  });

  it("treats an out-of-range pin as Auto", async () => {
    const onAssignTeam = vi.fn();
    const view = await mount(
      [
        player({ clientID: "c1000000", username: "Alice" }),
        player({ clientID: "c2000000", username: "Bob", teamIndex: 5 }),
      ],
      { onAssignTeam },
    );

    expect(selectFor(view, "c2000000").value).toBe("");
  });
});
