# Handoff — account tiers and the home ranked-lobby browser

> Future sessions: this file holds the current handoff. Overwrite it rather than
> appending; keep only the latest handoff. Write one only when the session leaves
> open items or partially verified work.

Companion notes: `testnotes.md`.

## 1. Where things are

- Repo: `C:\Users\ai51940\OpenFrontIO`.
- Tokens (all authenticate as **`hexfront-dev`**):
  - `H:\Documents\Hexfront-token.txt` — write to the fork (`origin`).
  - `H:\Documents\Norrasoff-token.txt` — read-only on NorrasOFF.
  - `H:\Documents\Fly.io-token.txt` — Fly deploy token (app `openfrontio`).
- Remotes: `origin` = `hexfront-dev/NorraRealFront-Remus-`,
  `norrasoff` = `NorrasOFF/NorraRealFront`, `upstream` = `openfrontio/OpenFrontIO`,
  `hexfront` = `hexfront-dev/OpenFrontIO`.
- Ship target is **`origin/main`**.

## 2. What landed this session

### Account tiers replace the subscription gate for ranked hosting

All account records now have an optional `tier` in `accounts.json`
(`src/server/LocalAuth.ts`):

- `player` (default, also the value for every existing account) — cannot list a
  ranked lobby.
- `host` — can list a ranked lobby.
- `admin` — can list and can grant/revoke tiers.
- `OWNER_USERNAME` / `OWNER_USERNAMES` (comma-separated, case-insensitive) is a
  bootstrap override: matching accounts always resolve to `admin`. The Fly app
  `openfrontio` now has the secret `OWNER_USERNAME=Remus`, so **Remus is the
  owner** once this code is deployed.
- `/api/users/@me` maps `canCreatePublicLobbies` to `tierCanHostRanked(tier)`,
  so the existing host-modal Ranked toggle reflects the tier.
- The Worker listing endpoint (`src/server/Worker.ts`,
  `POST /api/game/:id/listing`) rejects non-host accounts with
  `403 { error: "host_tier_required" }`. **The old `GAME_ENV=dev` bypass is
  gone for local-auth deployments.** Non-local deployments still use the
  upstream `canCreatePublicLobbies` API entitlement.
- Master is the only writer of `accounts.json`. Worker processes reload it
  when its mtime changes (`ensureAccountsFresh`), so grants take effect on the
  next request without restarting workers.
- `UserMeResponse` is unchanged; `trustTier`/`unlimitedRanked` remain as before.
  Tier `admin` does **not** set the JWT `role`, so it does not grant existing
  in-game admin powers; it only grants host + tier management.

### Admin tier-grant endpoint

Mounted on the master by `registerAccountTierRoutes` in
`src/server/AccountTierRoutes.ts` (local auth only):

- `GET /api/admin/account-tier?identifier=<publicId|username>`
- `POST /api/admin/account-tier` with
  `{ "publicId"?: "...", "username"?: "...", "tier": "player"|"host"|"admin" }`
- Authorization: `x-admin-bot-key: <ADMIN_BOT_API_KEY>` **or** a Bearer token
  whose account currently has tier `admin`.
- Responses: `{ publicId, username, tier, canHostRanked, canManageTiers }`;
  `401 unauthorized`, `403 admin_required`, `404 account_not_found`.

Examples:

```powershell
curl.exe -X POST http://localhost:3000/api/admin/account-tier `
  -H "Content-Type: application/json" `
  -H "x-admin-bot-key: $env:ADMIN_BOT_API_KEY" `
  -d '{"username":"Alice","tier":"host"}'

curl.exe http://localhost:3000/api/admin/account-tier?identifier=Alice `
  -H "Authorization: Bearer <admin-or-owner-jwt>"
```

### Ranked lobbies on the home screen

`src/client/GameModeSelector.ts` now renders all `games.hosted` entries (listed
= ranked lobbies) as map cards in the center of the home screen:

- While at least one ranked lobby is open, they **replace** the scheduled
  FFA/Team/Special playlist cards.
- With none open, the playlist cards render exactly as before (fallback).
- Clicking a card uses the existing `join-lobby` → `JoinLobbyModal` path.
- Cards show "Waiting for players" until the host starts, then the countdown.
- The Join Lobby modal's own bottom "Ranked Lobbies" list still exists.
- Cluster-wide cap is still `MAX_HOSTED_LOBBIES = 10`
  (`src/core/Schemas.ts`); raise it if more concurrent ranked lobbies are needed.

### Client text

- New key `private_lobby.listing_host_tier_required`.
- The host modal's explanation dialog now says ranked hosting is not enabled
  for the account and uses `host_modal.ranked_host_{ok,required_body,required_title}`.
  The old subscription-required keys and `view_subscriptions` were removed
  from `resources/lang/en.json` (only `en.json` is edited; Crowdin owns the rest).

## 3. Verification

- `npx tsc --noEmit` — clean.
- `npm run lint` — clean.
- Prettier on all changed files — clean.
- `npx vitest run tests/server/AccountTiers.test.ts tests/server/LocalAuth.test.ts tests/server/LocalAuthRoutes.test.ts tests/GameModeSelectorGatingWiring.test.ts tests/EnJsonSorted.test.ts`
  — 36 passed.
- `npx vitest run tests/server` — **689 passed, 3 failed**, all verified
  pre-existing on the clean tip by stashing this work:
  - `GameServerWire.test.ts` golden `numTurns` snapshot drift.
  - `HostedLobbyListing.test.ts` "never schedules or sets countdowns..."
  - `GameServerPhase.test.ts` "prunes on tick, not on a lobby-browser read".
  - `tests/TranslationSystem.test.ts` still reports 4 unused keys
    (`error_modal.turnstile_error`, `events_display.attack_cancelled_retreat`,
    `main.clans`, `main.inventory`); also pre-existing.
- `node e2e/run.mjs --observe` — SMOKE OK; home + solo modal render, so the
  playlist fallback is intact.

## 4. Open items

- **Deploy**: the code was pushed but not deployed. The Fly secret
  `OWNER_USERNAME=Remus` is already set, so the next deploy makes Remus
  `admin` (host + tier management) and every other account `player`.
- **No tier UI**: grants are HTTP/curl only. An in-game admin panel was not
  built.
- **Grants are cluster-local**: tiers live in `accounts.json`, which is a
  single-volume file suitable for this Fly deployment. Multi-machine
  deployments need shared storage.
- **Join is unchanged**: anyone signed in may still join ranked lobbies; only
  hosting is tier-gated.
- `MAX_HOSTED_LOBBIES` is 10; the home browser shows all of those but cannot
  show delisted overflow.
- Owner bootstrap is by username, so renaming the owner account would require
  updating the Fly secret. Local accounts currently have no rename endpoint.
