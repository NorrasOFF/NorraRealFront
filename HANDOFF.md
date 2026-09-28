# Handoff — fix "Import as lobby" failing for large (multi-player) saves

> Future sessions: this file is the current handoff. When you write your own,
> **overwrite this file** rather than appending — keep only the latest handoff.

Companion notes: `testnotes.md`, `docs/SaveResumeLongGames.md`, `DEPLOYMENT.md`
("SAVE_DIR").

## 1. Where things are

- Repo: `C:\Users\ai51940\OpenFrontIO` (private fork).
- Working/deployed branch: `feature/save-resume-checkpoints`; `origin/main` is
  kept at the feature tip (Fly.io GitHub integration auto-deploys `main`).
- Push auth (do not print the token):
  ```powershell
  $tok = (Get-Content -Raw "H:\Documents\Hexfront token.txt").Trim()
  $b64 = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("x-access-token:$tok"))
  git -c http.extraheader="Authorization: Basic $b64" push origin feature/save-resume-checkpoints:main feature/save-resume-checkpoints
  ```
- App: https://openfrontio.fly.dev (Fly app `openfrontio`, `NUM_WORKERS=1`,
  1 machine, region `ams`, **no volume**). Fly token for CLI at
  `H:\Documents\Fly.io token.txt`. `GAME_ENV=dev`, so `verifyClientToken`
  accepts a bare UUID as a Bearer token — handy for curl against the API.
- Remote is `origin = hexfront-dev/OpenFrontIO`; `upstream` is the public repo.

## 2. The bug and the fix

Symptom: `Load → Import as lobby` on a save with more than one player showed the
generic red toast "Failed to import that file as a resumable lobby."

Cause: nginx (the container's reverse proxy, `nginx.conf` → mounted at
`/etc/nginx/conf.d/default.conf`) defaults to `client_max_body_size 1m`. A save
file is POSTed whole to `POST /wN/api/saves/import`, so any export over 1 MB was
rejected by nginx with **HTTP 413** before it reached the worker. A tiny
single-player export stayed under 1 MB and worked, which is why only larger
(multi-player) files failed. The worker itself was never the problem: its
`express.raw` cap is `MAX_SAVE_IMPORT_BYTES = 64 MiB`
(`src/server/SaveImport.ts`), above the client's `MAX_SAVE_FILE_BYTES`.

Fix (commit `f925901d0`): add `client_max_body_size 70m;` to the `server` block
of `nginx.conf`. 70 MB sits above the worker's 64 MiB cap so a maximal import is
not clipped by the proxy.

## 3. Files changed

- `nginx.conf` — new `client_max_body_size 70m;` with a comment explaining the
  1 MB default and the 64 MiB worker cap.
- `tests/NginxBodySize.test.ts` — new regression guard: parses every
  `client_max_body_size` from `nginx.conf` and asserts the largest is
  `>= MAX_SAVE_IMPORT_BYTES` (imported from `src/server/SaveImport`).

## 4. Verification

- Diagnosed by POSTing a real exported save to the deployed server with a
  dev UUID token: got `HTTP 413` and an `nginx/1.22.1` body (not a worker HTML
  error), confirming the proxy, not the app, rejected it.
- Confirmed the worker pipeline is sound first: decoded the real exports
  (`~/Downloads/World_JarvastadensJarnhand-gUf5wmUf.json.gz`, 2 players, 453
  turns; `.../Giant_World_Map_JarvastadensJarnhand-djHKVuXG.json.gz`, 12 players,
  31 465 turns) through `decodeImportedSavedGame` →
  `savedLobbyFromSavedGame` → `MemorySaveStore` → `makeGame({ restore })`; both
  restored with all seats intact. Temp tests were deleted afterwards.
- `npx tsc --noEmit` — clean.
- `npx oxlint` + `npx eslint` + `npx prettier --check` on the new test — clean.
- `npx vitest run tests/NginxBodySize.test.ts tests/server/SaveImport.test.ts` —
  14 passed.

## 5. Open items / next steps

- **Verify on the deployed app after this deploy:** `Load → Import as lobby` a
  multi-player export (the two files in `~/Downloads` are ideal) → expect the
  Resume Game host lobby to open, Start → non-empty map past the checkpoint.
- **No automated coverage of the real HTTP route.** `tests/NginxBodySize.test.ts`
  only guards the nginx directive; the express import/resume routes still have
  no route-level test (standing P0 from earlier handoffs). A real express test
  with `FilesystemSaveStore` would catch app-side regressions.
- **Client "Import as lobby" errors are still opaque.** `importSavedLobby`
  throws `save import failed: HTTP <status> <body>` and `SavesModal` only logs
  it, then shows the generic lang string. Consider surfacing the status /
  distinguishing 413 ("file too large for the server") in the toast.
- **Still ephemeral:** server lobbies vanish on the next redeploy (no Fly
  volume). Export is the durable artifact; re-import after each deploy. A volume
  remains the real fix: `fly volumes create openfront_saves -a openfrontio -s 3`
  - `[mounts]` + `SAVE_DIR=/data/saves`.
- **Singleplayer-origin saves** are still a known rough edge (origin not
  normalized to `Private` on import) — see the previous handoff history in git.
