# Handoff — Discord announcement when a ranked match starts

> Future sessions: this file holds the current handoff. Overwrite it rather than
> appending; keep only the latest handoff. Write one only when the session leaves
> open items or partially verified work.

Companion notes: `testnotes.md` (section "Ranked match announcements on
Discord").

## 1. Where things are

- Repo: `C:\Users\ai51940\OpenFrontIO`.
- Token `H:\Documents\Hexfront-token.txt` authenticates as **`hexfront-dev`**.
- Ship target: `origin` = `hexfront-dev/NorraRealFront-Remus-`, branch `main`.
  This work is on `main` at **`a26714497`** (pushed and verified via the API).
- GitHub credential-manager prompts fail in this shell; push with a
  credential-in-URL remote (`https://x-access-token:<token>@github.com/...`).

## 2. What shipped

When a ranked match starts, the server posts one message to the community
Discord (the invite in the page footer, `https://discord.gg/SJSyRbVA`).

- **Trigger:** `GameServer.start()` when `isRanked()` is true (the private lobby
  was listed), and `startResumedGame()` when a resumed save keeps its ranked
  status. `notifyRankedStart()` is guarded by `rankedStartNotified`, so a game
  announces at most once. Unranked, delisted-before-start and resumed games
  that lost ranked status are silent.
- **Message:** `Hexfront Ranked` webhook username, embed "Ranked match started"
  with map, mode, `players/maxPlayers`, host username, timestamp and a clickable
  `https://[SUBDOMAIN.]DOMAIN/w<N>/game/<id>` link. `allowed_mentions:
{ parse: [] }`, so it can never ping anyone.
- **Robustness:** 5 s AbortController timeout; non-2xx / network errors are
  logged (`warn`) and swallowed; the `GameServer` hook is also wrapped in
  try/catch, so Discord cannot block or fail a start. No webhook = zero
  requests.
- **Code:** `src/server/RankedLobbyNotifier.ts` (payload builder, transport,
  URL derivation, fire-and-forget entry point), `ServerEnv.discordRankedWebhookUrl()`
  and `ServerEnv.publicSiteUrl()`, `GameServerDeps.rankedStarted` (default is the
  real notifier; tests inject a spy).
- **Config (documented in `example.env`):** `DISCORD_RANKED_WEBHOOK_URL` and
  optional `PUBLIC_SITE_URL`.

## 3. Verification

- `npx tsc --noEmit` clean; `npm run lint` and Prettier clean.
- `tests/server`: 732 passed, 3 failed — only the documented pre-existing
  failures (`GameServerWire` `numTurns` snapshot, `HostedLobbyListing`
  countdowns, `GameServerPhase` prune).
- New tests: `tests/server/RankedLobbyNotifier.test.ts` (payload, link
  derivation, no-mention guarantee, POST/timeout/non-2xx, no-op when
  unconfigured) and `tests/server/RankedStartNotification.test.ts` (ranked start
  fires once with details; unranked/delisted silent; failing notifier
  non-blocking; resumed ranked save announces on host start).
- Not browser-tested: server-only change, no UI/input/wire/checkpoint impact.

## 4. Open items

- **Deploy action:** create a webhook in the target Discord channel (Channel
  settings → Integrations → Webhooks), then set `DISCORD_RANKED_WEBHOOK_URL`
  (use the webhook URL, not the invite) on the deployment and redeploy. Set
  `PUBLIC_SITE_URL` if the public site origin is not
  `https://[SUBDOMAIN.]DOMAIN`.
- **Optional:** a role ping was deliberately not added; extending the payload
  with `content: "<@&ROLE_ID>"` and `allowed_mentions.roles` would need a new
  env var.
- **Rate limits:** each ranked start is one webhook call; Discord's ~30/min
  limit is not a concern for this traffic pattern, but a spammy host creating
  and starting many ranked lobbies would be visible to Discord as the same
  webhook. No dedupe beyond once-per-game exists.
