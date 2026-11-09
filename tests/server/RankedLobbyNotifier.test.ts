// @vitest-environment node
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  buildRankedMatchStartedPayload,
  notifyRankedMatchStarted,
  postDiscordWebhook,
  RANKED_NOTIFIER_USERNAME,
  rankedGameUrl,
} from "../../src/server/RankedLobbyNotifier";

const NOW = Date.UTC(2026, 10, 9, 12, 0, 0);
const JOIN_URL = "https://play.example.com/w0/game/abcd1234";

const NOTICE = {
  gameID: "abcd1234",
  map: "World",
  mode: "Free For All",
  players: 12,
  maxPlayers: 50,
  host: "Remus",
  joinUrl: JOIN_URL,
};

const payload = {
  username: "x",
  allowed_mentions: { parse: [] as [] },
  embeds: [],
};

function okResponse(): Response {
  return new Response(null, { status: 204 });
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.DISCORD_RANKED_WEBHOOK_URL;
  delete process.env.PUBLIC_SITE_URL;
  delete process.env.NUM_WORKERS;
});

describe("ranked match start payload", () => {
  test("builds a no-mention embed with map, mode, players, host and link", () => {
    const built = buildRankedMatchStartedPayload(NOTICE, NOW);

    expect(built.username).toBe(RANKED_NOTIFIER_USERNAME);
    expect(built.allowed_mentions).toEqual({ parse: [] });

    const embed = built.embeds[0];
    expect(embed.title).toBe("Ranked match started");
    expect(embed.url).toBe(JOIN_URL);
    expect(embed.description).toContain("**World** · Free For All");
    expect(embed.description).toContain("**12/50** players");
    expect(embed.description).toContain("Host: **Remus**");
    expect(embed.description).toContain(`[Open the game](${JOIN_URL})`);
    expect(embed.footer).toEqual({ text: "Game abcd1234" });
    expect(embed.timestamp).toBe(new Date(NOW).toISOString());
  });

  test("omits the link and the host when the notice has neither", () => {
    const built = buildRankedMatchStartedPayload(
      {
        gameID: "abcd1234",
        map: "Europe",
        mode: "Team",
        players: 4,
      },
      NOW,
    );
    const embed = built.embeds[0];

    expect(embed.url).toBeUndefined();
    expect(embed.description).toContain("**4** players");
    expect(embed.description).not.toContain("Host:");
    expect(embed.description).not.toContain("Open the game");
  });

  test("a username cannot ping anyone", () => {
    const built = buildRankedMatchStartedPayload(
      { ...NOTICE, host: "@everyone" },
      NOW,
    );
    // Mentions are disabled at the message level; the mention syntax itself is
    // inert inside an embed.
    expect(built.allowed_mentions).toEqual({ parse: [] });
  });
});

describe("discord webhook transport", () => {
  test("POSTs the JSON payload and resolves true for a 2xx", async () => {
    const fetchImpl = vi.fn(async () => okResponse());

    await expect(
      postDiscordWebhook("https://discord.test/hook", payload, { fetchImpl }),
    ).resolves.toBe(true);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://discord.test/hook");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(init.body as string)).toEqual(payload);
  });

  test("resolves false (and warns) on a non-2xx response", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("rate limited", { status: 429 }),
    );

    await expect(
      postDiscordWebhook("https://discord.test/hook", payload, {
        fetchImpl,
        log: { warn: vi.fn() } as never,
      }),
    ).resolves.toBe(false);
  });

  test("never throws when the network fails", async () => {
    const warn = vi.fn();
    const fetchImpl = vi.fn(async () => {
      throw new Error("socket hang up");
    });

    await expect(
      postDiscordWebhook("https://discord.test/hook", payload, {
        fetchImpl,
        log: { warn } as never,
      }),
    ).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith(
      "ranked discord notification failed",
      expect.objectContaining({ error: "socket hang up" }),
    );
  });

  test("aborts a request that hangs past the timeout", async () => {
    const fetchImpl = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        }),
    );

    await expect(
      postDiscordWebhook("https://discord.test/hook", payload, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        timeoutMs: 5,
        log: { warn: vi.fn() } as never,
      }),
    ).resolves.toBe(false);
  });
});

describe("notifyRankedMatchStarted", () => {
  test("does nothing when no webhook is configured", async () => {
    const fetchImpl = vi.fn(async () => okResponse());
    vi.stubGlobal("fetch", fetchImpl);

    notifyRankedMatchStarted(NOTICE);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("posts to the configured webhook with a join link from the deployment", async () => {
    process.env.DISCORD_RANKED_WEBHOOK_URL = "https://discord.test/hook";
    process.env.PUBLIC_SITE_URL = "https://play.example.com";
    process.env.NUM_WORKERS = "1";
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) =>
      okResponse(),
    );
    vi.stubGlobal("fetch", fetchImpl);
    // No joinUrl on the notice: the notifier derives it from the deployment.
    const withoutLink = { ...NOTICE, joinUrl: undefined };
    notifyRankedMatchStarted(withoutLink);

    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.embeds[0].url).toBe(JOIN_URL);
  });

  test("rankedGameUrl falls back to the DOMAIN-derived origin", () => {
    process.env.DOMAIN = "example.com";
    process.env.SUBDOMAIN = "play";
    process.env.NUM_WORKERS = "1";

    expect(rankedGameUrl("abcd1234")).toBe(JOIN_URL);
  });

  test("rankedGameUrl is undefined without an origin or worker count", () => {
    expect(rankedGameUrl("abcd1234")).toBeUndefined();

    process.env.DOMAIN = "example.com";
    expect(rankedGameUrl("abcd1234")).toBeUndefined();
  });
});
