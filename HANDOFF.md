# Handoff — self-service password reset with recovery codes

> Future sessions: this file holds the current handoff. Overwrite it rather than
> appending; keep only the latest handoff. Write one only when the session leaves
> open items or partially verified work.

Companion notes: `testnotes.md` (section "Self-service password reset
(recovery codes)") and `LOGIN.md` (full design and endpoint table).

## 1. Where things are

- Repo: `C:\Users\ai51940\OpenFrontIO`, branch `defense-post-priority`.
- Token `H:\Documents\Hexfront-token.txt` authenticates as **`hexfront-dev`**.
- Ship target: `origin` = `hexfront-dev/NorraRealFront-Remus-`, branch `main`
  (`git push origin HEAD:main`; use a credential-in-URL remote because the
  credential-manager prompts fail in this shell).
- This session's commit: **`18bfa70c6`** ("Add self-service password reset with
  recovery codes"), pushed to `main` and verified with `git ls-remote`. It sits
  on top of the four checkpoint/save commits from the previous session
  (`9c2b5f1e3..ae3a33f5e`), which were also pushed by this session.
- Live app: Fly app `openfrontio`, one machine, image built from
  `NorrasOFF/NorraRealFront` `main` — **the deploy still has to happen from that
  repo**. Nothing from this session or the previous checkpoint fix is live yet.

## 2. What landed

Password recovery for the self-hosted `LOCAL_AUTH` accounts. There is no email
address on file and no mail transport, so verification is a one-time
**recovery code** (100 bits, five 4-char groups, SHA-256 at rest), shown once at
registration and rotated on use.

- `POST /api/auth/reset` — username + recovery code + new password. Signs the
  browser in, revokes every session, rotates the code. Unknown username and
  wrong code share `401 invalid_recovery_code`.
- `POST /api/auth/password` — change while signed in (Bearer), current password
  required; keeps the requesting refresh session, revokes the rest.
- `GET/POST /api/auth/recovery` — status and regeneration for accounts created
  before the feature.
- Per-account failure window: 5 failed checks per 15 min → `429 rate_limited`,
  on top of per-IP limits (reset 10/15 min, other auth routes 20/15 min).
- Admin reset (`POST /api/admin/account-password`) now retires the recovery
  code.
- UI (`src/client/AccountModal.ts`): "Forgot password?" view, one-time code
  panel after signup/reset, and an "Account security" panel with change-password
  and regenerate-code forms.

## 3. Verification already done

- `npx tsc --noEmit`, `npm run lint`, Prettier clean.
- New suites: `tests/server/LocalAuthPasswordReset.test.ts`,
  `tests/server/LocalAuthResetRoutes.test.ts`,
  `tests/client/AccountModalReset.test.ts` (plus the pre-existing `LocalAuth*`
  and `AccountModal*` suites). 46–48 targeted tests pass.
- Full `tests/server`: 796 passed; only the 3 documented pre-existing failures
  (`GameServerPhase`, `GameServerWire` golden, `HostedLobbyListing`).
- `EnJsonSorted` passes; `TranslationSystem` fails only on its four documented
  pre-existing unused keys.
- Browser-verified end to end against `npm run dev` (`LOCAL_AUTH=1`, temp
  `AUTH_DIR`, throwaway `e2e` script): register → one-time code → signed-in
  security panel → clear session → reset with the code → rotated code shown →
  new password accepted → wrong code shows the generic error → no page errors.
  Screenshots in `e2e/artifacts/reset-0*.png`; the driver script was deleted.

## 4. Open items

- **Deploy** `NorrasOFF/NorraRealFront` `main` (this feature plus the previous
  metadata-only checkpoint validation and health check). Nothing is live yet.
- After deploy, do one real reset in production and confirm
  `accepted host checkpoint` still follows a large chunked upload.
- Two known limits, both intentional and documented in `LOGIN.md`:
  - JWTs already issued stay valid until expiry (≤15 min) after a reset; only
    refresh sessions are revoked.
  - The per-account failure window is in memory, so a master restart clears it
    (the code entropy, not the window, is the real protection).

## 5. Operational caveats (carried forward)

- `fly.toml` deliberately has `min_machines_running = 0`. Do not set it to 1
  without asking the owner.
- `AUTH_DIR` must stay on the `openfront_auth` volume (`/data/auth`); accounts
  written into the image or an ephemeral path vanish on deploy.
- The game worker has 472 MB RAM / 1 shared vCPU; large checkpoints are the
  known way to wedge the master. The metadata-only decode fix is in `main` but
  not deployed.
