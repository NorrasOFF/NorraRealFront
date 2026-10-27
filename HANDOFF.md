# Handoff — self-hosted username/password login

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
- Ship target is **`origin/main`**. This work was built and pushed from
  `upstream-v34-backports`, which shares history with `origin/main`.

## 2. What landed this session

Upstream login is delegated to the closed-source API at `api.<DOMAIN>`; the
fork's `api.openfrontio.fly.dev` does not resolve, so every login/refresh/JWKS
call failed. This session adds a local identity provider inside the game server.

### New server module

`src/server/LocalAuth.ts`:

- JSON account store at `AUTH_DIR/accounts.json` (atomic write + 0600), scrypt
  password hashes, case-insensitive usernames (3–20 chars, letters/numbers/
  spaces/`_`/`-`), 8–128-char passwords.
- Ed25519 JWT signing key at `AUTH_DIR/jwt-key.json` (generated on first run).
- 15-minute JWTs, 30-day rotating `hexfront_refresh` HttpOnly cookie
  (`SameSite=Lax`, `Secure` when the issuer is https).
- Routes on the game server: `POST /api/auth/register`,
  `POST /api/auth/login`, `POST /api/auth/refresh`, `POST /api/auth/logout`,
  `GET /api/users/@me`, `GET /api/.well-known/jwks.json` (+ root
  `/.well-known/jwks.json`).
- Register/login are IP rate-limited with `express-rate-limit`.

### Wiring

- `LOCAL_AUTH=1` enables it (`fly.toml`, `npm run dev`,
  `npm run start:server-dev`).
- `AUTH_DIR` defaults to `./auth-data` (`/usr/src/app/auth-data` in Docker);
  `Dockerfile` creates and chowns it.
- `LOCAL_AUTH_BASE` overrides the issuer/API base. Otherwise it is
  `https://$DOMAIN/api`, or `http://localhost:9000/api` when `DOMAIN=localhost`.
- `ServerEnv.jwtIssuer`/`jwkPublicKey`, `verifyClientToken`, and `getUserMe`
  use the local key and claims instead of fetching `api.<DOMAIN>`.
- `Worker` skips upstream join verification when local auth is on (same
  fail-open path as dev), so first joins do not require Turnstile.
- Client: `ClientEnv`/`getApiBase`/`jwtIssuer` use the injected local base;
  `Auth.ts` gained `localLogin`/`localRegister`.
- `AccountModal` shows a username/password form, a local "logged in as" view
  with Log out, and only the Account tab (stats/games/friends need the API).
- `Master` registers auth routes before the SPA fallback. The fallback moved
  into `registerSpaFallback()` and is installed in `startMaster()` so
  `GET /api/users/@me` is not swallowed by the app shell.
- `TokenPayloadSchema` gained optional `username`, so workers can resolve an
  account without re-reading a possibly stale `accounts.json`.

### Docs/config

`DEPLOYMENT.md`, `example.env`, `fly.toml`, `package.json`, `.gitignore`.

## 3. Verification

- `npx tsc --noEmit` — clean.
- `npm run lint` — clean.
- `npm run build-prod` — clean.
- New tests: `tests/server/LocalAuth.test.ts` (10) and
  `tests/server/LocalAuthRoutes.test.ts` (3) pass. `tests/Api.test.ts` local
  auth cases pass.
- `tests/server`: **669 passed, 2 failed** — both documented pre-existing:
  `GameServerWire` golden snapshot (`numTurns`) and `HostedLobbyListing`
  (no `createGame` messages).
- Browser-verified (headless Chrome, throwaway script, deleted): opened
  `#modal=account`, created `E2E896283`, reloaded, `/api/auth/refresh` +
  `/api/users/@me` returned the account, and the Account modal showed
  "Logged in as E2E896283" with Log out.
  Artifact: `e2e/artifacts/09-local-auth-account.png`.
- Known environment-only failures unchanged: `Api.test` localStorage fallback,
  `TranslationSystem` unused keys, `UserSettings`/client localStorage tests.

### Fly volume (mounted 2026-10-27)

- Volume `openfront_auth` (`vol_r1j7g8n6qx5y8nwr`), 1 GB, `ams`, attached to
  machine `8576399c13e748`; mounted at `/data`; `AUTH_DIR=/data/auth`.
- Live deploy verified: `https://openfrontio.fly.dev` serves
  `localAuth: true`, `apiBase: https://openfrontio.fly.dev/api`, JWKS is
  EdDSA, `/api/users/@me` and bogus login return 401.
- Persistence verified with a marker file across a machine restart. `/data/auth`
  contains `jwt-key.json` (0600, node-owned). Accounts will be written there.
- Deployment was run manually from the local working tree; the GitHub
  autodeploy source must contain the same commits or a later autodeploy will
  roll the app back.

## 4. Open items

- Confirm the GitHub autodeploy source/branch is `origin/main` of
  `hexfront-dev/NorraRealFront-Remus-`; this session pushed there. If it watches
  a different repo, push/cherry-pick the login + `fly.toml` commits there too.
- No password reset, email verification, account deletion, or username-change
  endpoint. `PUT /users/@me/username` and the nav "Change username" flow will
  fail for local accounts.
- Local accounts have no cosmetics/flares/currency; stats, shop, clans,
  leaderboards, friends, and game history remain unavailable.
- The in-game player name is still free-form; logging in does not force it to
  the account username.
- A single volume only works for one machine/region. Multiple machines need
  Postgres/Redis or shared storage.
- `GAME_ENV=dev` is still the deployment assumption. Local auth verification
  works in prod, but matchmaking/privilege/subscription polling still target
  `api.<DOMAIN>`.
