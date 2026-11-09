// Outbound announcement posted to the community Discord when a ranked match
// starts. The Discord invite is linked from the page footer; the destination
// webhook is deployment configuration (DISCORD_RANKED_WEBHOOK_URL) so the
// feature stays off — and no request is made — when it is unset.
//
// Delivery is best-effort: a notification is never allowed to delay or fail a
// game start, so every error is logged and swallowed.

import { logger } from "./Logger";
import { ServerEnv } from "./ServerEnv";

// What a started ranked match looks like to the notifier. Built by GameServer
// from state it already has, and kept free of account ids (only the public
// host username is included, which the lobby already shows).
export interface RankedMatchStartedNotice {
  gameID: string;
  map: string;
  mode: string;
  players: number;
  maxPlayers?: number;
  host?: string;
  // Absolute URL a reader can open to watch the match. Filled in by
  // notifyRankedMatchStarted() when the caller does not supply one.
  joinUrl?: string;
}

export interface DiscordEmbed {
  title: string;
  description?: string;
  url?: string;
  color: number;
  fields?: { name: string; value: string; inline?: boolean }[];
  footer?: { text: string };
  timestamp: string;
}

export interface DiscordWebhookPayload {
  username: string;
  // Never ping anyone: an empty parse list disables mentions in every field,
  // so a username that looks like "@everyone" cannot ping the server.
  allowed_mentions: { parse: [] };
  embeds: DiscordEmbed[];
}

export const RANKED_NOTIFIER_USERNAME = "Hexfront Ranked";

// The blurple Discord uses for its own embeds.
const RANKED_EMBED_COLOR = 0x5865f2;

// Pure: everything the payload needs is in the notice (plus the clock), so a
// test can pin the exact message without touching the network or the env.
export function buildRankedMatchStartedPayload(
  notice: RankedMatchStartedNotice,
  now: number = Date.now(),
): DiscordWebhookPayload {
  const lines = [
    `**${notice.map}** · ${notice.mode}`,
    notice.maxPlayers === undefined
      ? `**${notice.players}** players`
      : `**${notice.players}/${notice.maxPlayers}** players`,
  ];
  if (notice.host !== undefined && notice.host.length > 0) {
    lines.push(`Host: **${notice.host}**`);
  }
  if (notice.joinUrl !== undefined && notice.joinUrl.length > 0) {
    lines.push(`[Open the game](${notice.joinUrl})`);
  }

  const embed: DiscordEmbed = {
    title: "Ranked match started",
    description: lines.join("\n"),
    color: RANKED_EMBED_COLOR,
    footer: { text: `Game ${notice.gameID}` },
    timestamp: new Date(now).toISOString(),
  };
  if (notice.joinUrl !== undefined && notice.joinUrl.length > 0) {
    // Makes the embed title clickable as well, which is the affordance on
    // Discord clients that hide description links.
    embed.url = notice.joinUrl;
  }

  return {
    username: RANKED_NOTIFIER_USERNAME,
    allowed_mentions: { parse: [] },
    embeds: [embed],
  };
}

// POST one payload. Resolves true only for a 2xx, false for anything else
// (network error, timeout, Discord rate limit or bad webhook). Never throws.
export async function postDiscordWebhook(
  url: string,
  payload: DiscordWebhookPayload,
  opts: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    log?: Pick<typeof logger, "warn">;
  } = {},
): Promise<boolean> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const log = opts.log ?? logger;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      log.warn("ranked discord notification rejected", {
        status: response.status,
      });
      return false;
    }
    return true;
  } catch (error) {
    log.warn("ranked discord notification failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// Public join/watch URL for a game on this deployment, or undefined when the
// deployment does not know its own origin. ServerEnv.workerPath() throws when
// NUM_WORKERS is unset (e.g. in a bare test process), hence the guard.
export function rankedGameUrl(gameID: string): string | undefined {
  const site = ServerEnv.publicSiteUrl();
  if (site.length === 0) return undefined;
  try {
    return `${site}/${ServerEnv.workerPath(gameID)}/game/${gameID}`;
  } catch {
    return undefined;
  }
}

// Fire-and-forget notification for a started ranked match. A no-op when no
// webhook is configured, and safe to call from a game tick: nothing is awaited
// and no error escapes.
export function notifyRankedMatchStarted(
  notice: RankedMatchStartedNotice,
): void {
  const url = ServerEnv.discordRankedWebhookUrl();
  if (url === undefined) return;

  const full: RankedMatchStartedNotice = {
    ...notice,
    joinUrl: notice.joinUrl ?? rankedGameUrl(notice.gameID),
  };
  void postDiscordWebhook(url, buildRankedMatchStartedPayload(full));
}
