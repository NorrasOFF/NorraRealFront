# Handoff — local save export/import (gzip)

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
  1 machine, region `ams`, **no volume**).

## 2. Why this session exists

The user's private-lobby save vanished ~30 min after making it. Root cause is
**not** the retention policy — it is that `fly.toml` has no `[mounts]` /
`SAVE_DIR`, so server saves land on the machine's ephemeral rootfs and are wiped
on every restart/redeploy (and every push to `main` auto-deploys). See
`DEPLOYMENT.md:41,45-47`, `HANDOFF.md` history, `src/server/SaveStore.ts:55-60`.

Two independent save systems:

- **Local (browser IndexedDB)** — `src/client/SaveManager.ts` autosaves every
  25 turns + on page-hide; `src/client/SaveStore.ts` stores it. Listed under
  **“Saved games”**; resumed entirely client-side (`SavesModal.resumeLocal`).
  Survives server wipes. Caps: 30 saves / 64 MiB each / 512 MiB sum.
- **Server (“Resumable lobbies”)** — lets other players rejoin a link; ephemeral
  without a volume. Retention defaults (if a volume is ever added): 20/creator,
  30 days, 2 GiB dir (pruned on start + hourly).

The user asked to keep saves **locally** rather than pay for a Fly volume, and
chose **export/import files**.

## 3. New behavior

In **Load → Saved games**:

- Each local save row has an **Export** button → downloads
  `<sanitized label>-<gameID>.json.gz` (gzipped `SavedGame` JSON) to the
  player's machine. Survives “Delete save”, browser eviction, and redeploys; the
  game never touches it (only the OS/user does).
- An **Import** button at the section header opens a file picker; the file is
  gunzipped, Zod-validated (`SavedGameSchema`), and written into the local store.
  Plain `.json` saves are also accepted (defensive), and a re-import of the same
  save overwrites by `saveId`.

## 4. What changed (files)

- `src/client/SaveFile.ts` (new) — `encodeSaveFile` (gzip via
  `CompressionStream`), `decodeSaveFile` (gzip or plain, size-bounded to defeat
  a gzip bomb), `saveFileName` (sanitize/truncate label), `downloadSaveFile`.
  Caps: `MAX_SAVE_FILE_BYTES` 64 MiB (input), `MAX_SAVE_FILE_UNCOMPRESSED_BYTES`
  256 MiB (decompressed).
- `src/client/SavesModal.ts` — Export/Import UI, `exportSave`, `onImportFile`,
  hidden `#save-import-input`.
- `resources/lang/en.json` — `save_game.export`, `export_failed`, `import`,
  `import_failed` (kept alphabetically sorted).
- `tests/client/SaveFile.test.ts` (new) — filename sanitizing, gzip round-trip,
  plain-JSON fallback, rejects garbage/foreign JSON/wrong version, size bound,
  import-into-store.
- `tests/client/SavesModalResume.test.ts` — mock now stubs `saveGame`.

## 5. Verification this session

- `npx tsc --noEmit` — clean.
- `npm run lint` — clean.
- `npx prettier --check` on changed files — clean.
- `npx vitest run tests/client/SaveFile.test.ts tests/client/SavesModalResume.test.ts tests/EnJsonSorted.test.ts tests/SaveStore.test.ts tests/SaveManager.test.ts`
  — all pass (45 tests).
- Known env-only `localStorage` failures and the pre-existing SAM/MapPlaylist/
  HostedLobby failures are unchanged (see `testnotes.md`).

## 6. Next steps / open items

- **End-to-end on the deployed app:** play a private game, open Load, Export,
  confirm the `.json.gz` downloads; delete the in-game save; Import the file;
  Resume and confirm the map/clock restore.
- **Server “Resumable lobbies” are still ephemeral.** If the user later wants
  other players to rejoin after a redeploy, create a Fly volume
  (`fly volumes create openfront_saves -a openfrontio -s 3`) and add
  `[mounts]` + `SAVE_DIR=/data/saves` to `fly.toml`. Not done (user declined the
  paid volume).
- Optional follow-ups: a “pin” flag so a chosen local save is never auto-evicted
  by the 30/512 MiB caps; an “export as plain JSON” toggle.
