# Handoff — local save export/import + import-as-resumable-lobby

> Future sessions: this file is the current handoff. When you write your own,
> **overwrite this file** rather than appending — keep only the latest handoff.

Companion notes: `testnotes.md`, `docs/SaveResumeLongGames.md`, `DEPLOYMENT.md`
("SAVE_DIR").

## 1. Where things are

- Repo: `C:\Users\ai51940\OpenFrontIO` (private fork).
- Working/deployed branch: `feature/save-resume-checkpoints` (Fly.io GitHub
  integration auto-deploys `main`; `main` is kept at the feature tip).
- Push auth (do not print the token):
  ```powershell
  $tok = (Get-Content -Raw "H:\Documents\Hexfront token.txt").Trim()
  $b64 = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("x-access-token:$tok"))
  git -c http.extraheader="Authorization: Basic $b64" push origin feature/save-resume-checkpoints:main feature/save-resume-checkpoints
  ```
- App: https://openfrontio.fly.dev (Fly app `openfrontio`, `NUM_WORKERS=1`,
  1 machine, region `ams`, **no volume**). Fly token for CLI at
  `H:\Documents\Fly.io token.txt`.

## 2. Why this work exists

A private-lobby save vanished ~30 min after creation. Root cause is **not** the
retention policy — `fly.toml` has no `[mounts]`/`SAVE_DIR`, so **server saves are
on the machine's ephemeral rootfs and are wiped on every restart/redeploy** (every
push to `main` auto-deploys). See `DEPLOYMENT.md:41,45-47`,
`src/server/SaveStore.ts:55-60`.

Two save systems:

- **Local (browser IndexedDB)** — `src/client/SaveManager.ts` (autosave every
  25 turns + page-hide) → `src/client/SaveStore.ts`. Listed under **“Saved
  games”**; resumed client-side only (`SavesModal.resumeLocal`). Survives server
  wipes. Caps: 30 saves / 64 MiB each / 512 MiB sum.
- **Server (“Resumable lobbies”)** — lets other players rejoin via link;
  ephemeral without a volume. Retention defaults (only if a volume is ever
  added): 20/creator, 30 days, 2 GiB dir.

The user asked to keep saves **locally** instead of paying for a Fly volume, then
to also be able to turn a local file back into a **resumable lobby** (so others
can rejoin after a redeploy).

## 3. New behavior

**Local export/import** (`Load → Saved games`):

- **Export** on a local save row → downloads `<sanitized label>-<gameID>.json.gz`
  (gzipped `SavedGame`). Survives “Delete save”, browser eviction, redeploys.
- **Import** at the section header → gunzip, Zod-validate, write to the local
  store. Also accepts plain `.json`; re-import overwrites by `saveId`.

**Import as a resumable lobby** (`Load → Resumable lobbies` header):

- **Import as lobby** → decode the file, keep a local copy, POST the bytes to
  `POST /wN/api/saves/import` (creator-authenticated), which builds a server
  `SavedLobby` and persists it, then opens the **Resume Game** host lobby so the
  host can invite players and press Start (resumes from the checkpoint).

## 4. What changed (files)

Local export/import (commit `b29e119cc`):

- `src/client/SaveFile.ts` (new) — `encodeSaveFile`/`decodeSaveFile` (gzip or
  plain, size-bounded), `saveFileName`, `downloadSaveFile`.
- `src/client/SavesModal.ts` — Export/Import UI + handlers.
- `resources/lang/en.json` — `save_game.export`, `export_failed`, `import`,
  `import_failed`.
- `tests/client/SaveFile.test.ts` (new); `tests/client/SavesModalResume.test.ts`
  mock now stubs `saveGame`.

Import-as-lobby (this change):

- `src/server/SaveImport.ts` (new) — `decodeImportedSavedGame(bytes)` (gzip/plain,
  gzip-bomb capped), `savedLobbyFromSavedGame(save, {creatorPersistentID,
gitCommit, now})` (server owns creator/gitCommit; seals only the creator seat
  with their persistentID; keeps the checkpoint only when it decodes). Caps:
  64 MiB compressed / 256 MiB decompressed.
- `src/server/Worker.ts` — `POST /api/saves/import`: auth-header precheck before
  the body parser, `express.raw({type:()=>true, limit:64MiB})` (express.json
  ignores the non-JSON content type), then requireAccount → decode → worker-id
  check → refuse to overwrite another account's save → convert → `saveStore.save`.
- `src/client/Api.ts` — `importSavedLobby(gameID, bytes)` posting raw bytes to
  the owning worker.
- `src/client/SavesModal.ts` — “Import as lobby” button/handler: local store +
  upload + `resumeSavedLobby` + open `host-lobby-modal` in resume mode.
- `resources/lang/en.json` — `save_game.import_lobby`, `import_lobby_failed`.
- `tests/server/SaveImport.test.ts` (new) — decode (gzip/plain/reject), conversion
  (creator seat, checkpoint keep/drop), and persist→load→restore as a live game.

## 5. Verification

- `npx tsc --noEmit` — clean.
- `npm run lint` — clean.
- `npx prettier --check` on changed files — clean.
- `npx vitest run tests/server/SaveImport.test.ts tests/client/SaveFile.test.ts tests/client/SavesModalResume.test.ts tests/EnJsonSorted.test.ts`
  — 23 passed (includes a `MemorySaveStore` save→load→`restoreGame` round trip).

## 6. Next steps / open items

- **End-to-end on the deployed app:** play a private game → Export → delete the
  in-game save → **Import as lobby** → expect the Resume Game host lobby → Start
  → non-empty map past the checkpoint.
- **Still ephemeral:** imported server lobbies vanish on the next redeploy (no
  Fly volume). The file is the durable artifact; re-import after each deploy.
  A volume is still the real fix: `fly volumes create openfront_saves -a
openfrontio -s 3` + `[mounts]` + `SAVE_DIR=/data/saves`.
- Seats other than the creator's have a blank persistentID (the file has none),
  so they can only _claim_ via the invite link; they won't auto-reconnect.
- The HTTP route is not covered by an automated test (only the conversion +
  store/restore path is); a real express-route test with `FilesystemSaveStore`
  remains the P0 from the previous handoff.
- Optional: a “pin” flag so a local save escapes the 30/512 MiB eviction caps.
