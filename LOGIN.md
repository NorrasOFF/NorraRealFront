# Login / accounts (self-hosted)

Quick map of the fork's username/password login. Read this before digging into
the auth code.

## TL;DR

- Enabled by `LOCAL_AUTH=1`. There is no dependency on `api.<DOMAIN>` for
  registration, login, refresh, logout, `/users/@me`, or JWT verification.
- Accounts are **username + password**, stored server-side in
  `AUTH_DIR/accounts.json`; the Ed25519 signing key is
  `AUTH_DIR/jwt-key.json`.
- On Fly: `AUTH_DIR=/data/auth`, backed by the `openfront_auth` volume mounted
  at `/data` (see `fly.toml`).
- Login issues a 15-minute JWT (memory-only on the client) plus a 30-day
  rotating `hexfront_refresh` HttpOnly cookie.
- The account UUID in `sub` is the player's **persistentID**; game joins and
  saved lobbies use it exactly like an upstream account ID.
- Stats, shop, clans, leaderboards, friends, game history, and cosmetics are
  **not** provided by local auth.
- Passwords can be changed while signed in (current password required) and
  reset after a forgotten password with a one-time **recovery code**, because
  there is no email address on file and no mail transport. See
  [Password reset](#password-reset).

## Files touched

| File                                                                                           | Role                                                                                                                                 |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `src/server/LocalAuth.ts`                                                                      | Everything server-side: account store, scrypt hashes, JWT signing/verification, refresh sessions, routes.                            |
| `src/server/Master.ts`                                                                         | `initLocalAuth()`, `registerLocalAuthRoutes()`, and `registerSpaFallback()` (fallback must be registered **after** auth GET routes). |
| `src/server/ServerEnv.ts`                                                                      | `localAuthEnabled()`, `localAuthBase()`, local branch in `jwtIssuer()` / `jwkPublicKey()`.                                           |
| `src/server/jwt.ts`                                                                            | `verifyClientToken()` and `getUserMe()` local branches.                                                                              |
| `src/server/Worker.ts`                                                                         | Skips upstream `join_verify` when local auth is on (same path as dev).                                                               |
| `src/client/Auth.ts`                                                                           | `localLogin()` / `localRegister()`; existing refresh/logout work against the local API base.                                         |
| `src/client/Api.ts`                                                                            | `getApiBase()` returns the local base when enabled.                                                                                  |
| `src/client/ClientEnv.ts`                                                                      | Bootstrap values `localAuth` and `apiBase`; `jwtIssuer()` follows the same base.                                                     |
| `src/client/AccountModal.ts`                                                                   | Username/password form, local "logged in as" view, Account tab only.                                                                 |
| `src/core/ApiSchemas.ts`                                                                       | `TokenPayloadSchema.username` (optional claim).                                                                                      |
| `src/core/configuration/Config.ts`, `index.html`, `src/server/RenderHtml.ts`, `vite.config.ts` | Bootstrap config plumbing.                                                                                                           |
| `Dockerfile`                                                                                   | Creates/chowns `AUTH_DIR` in the container.                                                                                          |
| `fly.toml`                                                                                     | `LOCAL_AUTH=1`, `AUTH_DIR=/data/auth`, `[[mounts]] openfront_auth → /data`.                                                          |
| `tests/server/LocalAuth.test.ts`                                                               | Store, password, JWT, refresh/logout, server-integration tests.                                                                      |
| `tests/server/LocalAuthRoutes.test.ts`                                                         | HTTP route tests (register/login/me/refresh/logout/JWKS).                                                                            |
| `tests/server/LocalAuthPasswordReset.test.ts`                                                  | Store tests for recovery codes, password changes, throttling, and admin resets.                                                      |
| `tests/server/LocalAuthResetRoutes.test.ts`                                                    | HTTP route tests for reset/change-password/recovery-code endpoints.                                                                  |
| `tests/client/AccountModalReset.test.ts`                                                       | Forgot-password and one-time recovery-code UI in the account modal.                                                                  |

## Configuration

| Env               | Meaning                                                                                                                                                              |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LOCAL_AUTH`      | `1`/`true` enables local auth.                                                                                                                                       |
| `AUTH_DIR`        | Account + key directory. Default `./auth-data` (`/usr/src/app/auth-data` in Docker). Fly: `/data/auth`.                                                              |
| `LOCAL_AUTH_BASE` | Optional JWT issuer / API base. Default `https://$DOMAIN/api`, or `http://localhost:9000/api` when `DOMAIN=localhost`. Must match the browser origin used for login. |

The browser receives `localAuth` and `apiBase` via `window.BOOTSTRAP_CONFIG`.
`getApiBase()` therefore becomes same-origin `/api` (or the explicit base)
instead of `https://api.<DOMAIN>`.

## HTTP endpoints

All live on the game server (master process), not a separate API service.

| Method | Path                         | Auth                                                                                                 |
| ------ | ---------------------------- | ---------------------------------------------------------------------------------------------------- |
| `POST` | `/api/auth/register`         | JSON `{username,password}`; sets refresh cookie                                                      |
| `POST` | `/api/auth/login`            | JSON `{username,password}`; sets refresh cookie                                                      |
| `POST` | `/api/auth/refresh`          | `hexfront_refresh` cookie; rotates it                                                                |
| `POST` | `/api/auth/logout`           | `hexfront_refresh` cookie; revokes it                                                                |
| `POST` | `/api/auth/reset`            | JSON `{username,recoveryCode,newPassword}`; sets refresh cookie and returns a rotated `recoveryCode` |
| `POST` | `/api/auth/password`         | Bearer JWT + JSON `{currentPassword,newPassword}`; keeps this cookie's session, revokes the rest     |
| `GET`  | `/api/auth/recovery`         | Bearer JWT; `{enabled}`                                                                              |
| `POST` | `/api/auth/recovery`         | Bearer JWT + JSON `{currentPassword}`; returns a rotated `recoveryCode`                              |
| `GET`  | `/api/users/@me`             | `Authorization: Bearer <JWT>`                                                                        |
| `GET`  | `/api/.well-known/jwks.json` | public                                                                                               |

`/api/users/@me` and the JWKS route exist because the client and other server
components expect the upstream API shape.

## Data model

`accounts.json`:

```json
{
  "version": 1,
  "accounts": [
    {
      "id": "uuid",
      "username": "Alice",
      "passwordHash": "scrypt$16384$8$1$<salt>$<hash>",
      "createdAt": 0,
      "sessions": [{ "tokenHash": "sha256", "createdAt": 0, "expiresAt": 0 }],
      "recovery": { "hash": "sha256", "createdAt": 0 }
    }
  ]
}
```

- Usernames are unique case-insensitively, 3–20 chars, letters/numbers/spaces/
  `_`/`-`.
- Passwords are 8–128 chars, scrypt (`N=16384`, `r=8`, `p=1`).
- Refresh tokens are random 32-byte base64url strings; only their SHA-256 hash
  is stored. Max 10 sessions per account.
- `recovery` is optional (accounts created before the feature have none). Only
  the SHA-256 of the normalized recovery code is stored; the code itself is
  never persisted or logged.
- Writes are atomic (temp file + rename). Files/dir are 0600/0700 where possible.

## Password reset

The fork has no email field and no mail transport, so verification is
something the account holder **has**: a recovery code issued once and shown
once.

- **Format.** 20 random symbols from a 32-symbol alphabet (`ABCDEFGHJKLMNPQRSTUVWXYZ23456789`,
  ambiguous `I O 0 1` omitted) in five 4-char groups: `ABCD-EFGH-JKLM-NPQR-STUV`.
  That is 100 bits, so a plain SHA-256 is safe for at-rest storage. Input is
  case-insensitive and separators are ignored.
- **Issued at registration**, shown in the account modal with a copy button,
  and only then. The user is told it is the only way to recover a forgotten
  password.
- **Regenerated while signed in** from the account tab (current password
  required). The old code stops working immediately. This is how pre-existing
  accounts get a code.
- **Forgot-password reset** (`POST /api/auth/reset`): username + code + new
  password. A correct code sets the new password, revokes **every** device,
  rotates the code, sets a fresh refresh cookie and signs the browser in. The
  new code is shown once.
- **Change while signed in** (`POST /api/auth/password`): current password
  required, so a stolen JWT alone cannot take the account over. Every other
  refresh session is revoked; the session that made the request is kept.
- **Verification failures are indistinguishable.** An unknown username and a
  wrong code both return `401 {error:"invalid_recovery_code"}` after the same
  SHA-256 work, and attempt counting is per account, not just per IP.
- **Throttling.** The reset route has an IP rate limit of 10 per 15 minutes, on
  top of the shared auth limiter (20/15 min). Independently, five failed
  recovery-code/current-password checks for one account return
  `429 {error:"rate_limited"}` for 15 minutes. The per-account window is
  in memory, so a master restart clears it; the code entropy is the real
  protection.
- **Admin fallback.** `POST /api/admin/account-password` (admin tier or the
  admin-bot key) still sets a password directly and now also **retires** the
  recovery code, covering the account that lost both.
- **Known limit.** A JWT already issued stays valid until it expires (≤15 min)
  after a reset or password change; only refresh sessions are revoked. Fixing
  that would require per-request account lookups in `verifyClientToken`, which
  the WebSocket path deliberately avoids.

JWT claims: `jti`, `sub` = base64url(UUID), `iat`, `iss` = `LOCAL_AUTH_BASE`,
`aud` = `DOMAIN`, `exp` = 15 min, `provider: "local"`, `username`.

## Flow

1. Page load: `userAuth()` tries `/auth/refresh`; 401 means logged out.
2. Account modal (logged out + `localAuth` bootstrap) shows the local form.
3. Register/login stores the JWT in memory and the refresh cookie in the
   browser. Registration first shows the recovery code once; the reload happens
   when the player confirms they saved it. A successful forgot-password reset
   behaves the same way (and also signs the player in).
4. Join: `getPlayToken()` returns the JWT; the worker verifies it locally and
   uses `sub` as the persistentID. `getUserMe()` returns a synthetic profile
   (username from the claim, empty flares/friends).
5. After 15 minutes `userAuth()` refreshes via the cookie.
6. Logout revokes the refresh session and clears client state.

## Gotchas

- **Route order matters.** `Master` used to register the SPA catch-all at module
  load, which swallowed `GET /api/users/@me`. `registerSpaFallback()` is now
  called in `startMaster()` _after_ auth routes.
- **Workers must not rely on `accounts.json`.** A worker may have loaded the
  file before a new account was registered. The `username` JWT claim lets
  `getUserMe()` answer without a fresh account lookup.
- **Single Fly machine only.** One volume cannot be shared by multiple Fly
  machines/regions. Node cluster workers inside the one machine share the disk.
- **`GAME_ENV=dev` is still the deployment assumption.** Local verification
  works in prod, but matchmaking/privilege/subscription polling still targets
  `api.<DOMAIN>`.
- **Missing features:** email verification, account deletion, username changes
  (`PUT /users/@me/username`), local cosmetics/currency, and
  stats/friends/history tabs. The in-game player name is still free-form.
  Password reset does not involve email: see [Password reset](#password-reset).
- Login/register are rate-limited to 20 requests per 15 minutes per IP.
- Do not put `AUTH_DIR` inside the app image or an ephemeral path; accounts will
  vanish on deploy.
