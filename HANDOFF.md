# Handoff — worker restart fix; plan for volume-backed saves

> Future sessions: this file holds the current handoff. Overwrite it rather than
> appending; keep only the latest handoff. Write one only when the session leaves
> open items or partially verified work.

Companion notes: `testnotes.md`.

## 1. Where things are

- Repo: `C:\Users\ai51940\OpenFrontIO`, branch `defense-post-priority`.
- Token `H:\Documents\Hexfront-token.txt` authenticates as **`hexfront-dev`**.
- Ship target: `origin` = `hexfront-dev/NorraRealFront-Remus-`, branch `main`.
  This session pushed **`e7b7d541c`** (`git push origin HEAD:main`).
- GitHub credential-manager prompts fail in this shell; push with a
  credential-in-URL remote (`https://x-access-token:<token>@github.com/...`).
- Fly app `openfrontio`, one machine `8576399c13e748`, image built from
  `NorrasOFF/NorraRealFront` `main` (`GIT_COMMIT` reports `unknown`). It is
  **not** built from this fork; the fix below is pushed to the fork only.
- `flyctl` at `C:\Users\ai51940\.fly\bin\flyctl.exe`; set `FLY_API_TOKEN` from
  `H:\Documents\fly-token.txt`.

## 2. What actually broke the saves

The import code was fine. For the reported save
(`Downloads/Five_Islands_Remus-KBmWoEVR.json.gz`, 4.0 MB → 5.8 MB JSON,
11 182 turns, 5.3 M-char checkpoint) the server log showed:

- 11:43:49 list 200, 11:43:54 export 200.
- **11:44:09 import → 200; 11:44:10 resume → 200** (the file imports and
  resumes correctly).
- 11:44:20 a second import of the same file → 200.
- 11:45:02 **two `DELETE /w0/api/saves/KBmWoEVR` → 200** (the save was deleted
  from the UI, which is why the later resume attempts 404'd).
- 11:45:20 `resume?force=1` hung for nginx's 60 s `proxy_read_timeout` → 504;
  11:45:27 delete/resume → 404. That 504/404 surfaced in the UI as the generic
  "failed to import that file as a resumable lobby".
- 11:51:11 the **worker process died**. Nothing restarted it: the master read
  `WORKER_ID` from `worker.process.env` in the cluster `exit` handler, but
  `worker.process` is `null` after exit, so it logged
  `worker crashed could not find id` and returned. The dead worker stayed in
  `MasterLobbyService`, was re-killed twice a second forever, and every `/wN`
  request (import, list, resume, **and the game websocket**) answered 502 until
  the machine was restarted by hand.

Local repro confirms this: kill the worker PID of `npm run start:server`, the
master logs `crashed could not find id` and never restarts it. With this fix it
logs `died with code … / Restarting worker 0…` and a new worker is ready ~1 s
later (`/w0/api/saves` goes 502 → 400 auth-required).

## 3. What changed (commit `e7b7d541c`)

- `src/server/ClusterWorkerIds.ts` (new): cluster worker id → logical
  `WORKER_ID`, recorded at fork and consumed on exit.
- `src/server/Master.ts`: forks through one `spawnWorker()`, removes the shard
  from the lobby service on exit, and respawns it after 1 s (with a gap-filling
  fallback if the id is somehow unknown).
- `src/server/MasterLobbyService.ts`: broadcasts and create/update sends skip a
  worker whose `isDead()` is true, and are wrapped so a synchronous channel
  error cannot abort the loop.
- `src/client/SavesModal.ts` + `resources/lang/en.json`: if the import succeeds
  but opening its lobby fails, the modal now says the save **was imported**,
  refreshes the server list, and keeps the modal open instead of claiming the
  import failed (which invited destructive re-imports). New key
  `save_game.import_lobby_resume_failed`.
- Tests: `tests/server/ClusterWorkerIds.test.ts`, two broadcast cases in
  `tests/server/MasterLobbyServiceHealth.test.ts`, one import-resume-failure
  case in `tests/client/SavesModalResume.test.ts`.

## 4. Verification

- `npx tsc --noEmit`, Oxlint, ESLint, Prettier clean.
- `ClusterWorkerIds`, `MasterLobbyServiceHealth`, `SavesModalResume`,
  `EnJsonSorted`: pass. `TranslationSystem` still fails only on the four
  documented unused keys (`error_modal.turnstile_error`,
  `events_display.attack_cancelled_retreat`, `main.clans`, `main.inventory`).
- Real-process check: killed the local worker; master restarted it and the
  worker HTTP API answered normally.
- Production was **restarted** (`fly machine restart`) to restore service; the
  worker came back (400 auth-required, not 502). The restart fix is not in the
  deployed image yet.

## 5. Open items

- **Deploy needed.** Port `e7b7d541c` to `NorrasOFF/NorraRealFront` `main` (or
  deploy it from this fork). Until then a worker crash is permanent again until
  a manual `fly machine restart`.
- The 60 s resume 504 was **not reproduced** locally: import + resume took
  0.5–1.1 s, and import-twice + load + checkpoint decode + restore took ~2.4 s
  on this machine. It may have been a side effect of the second import racing
  the deleted save, or of the worker being memory-starved on the 512 MB Fly
  machine. If it recurs, the master now logs the worker's exit code/signal.
- Saves are still written to `/usr/src/app/saves` (container rootfs), so they
  die on a deploy/machine replacement. See §6 for the fix under discussion.
- The import route still appends the full turn log to an existing history file
  on a re-import (`saveStore.save(lobby, 0)`). It is harmless (small gzip, read
  de-dupes by `turnNumber`) but could be truncated on import if that ever
  matters.

## 6. Should saves live on the Fly volume? (analysis, not implemented)

**Current state.** `fly.toml` mounts a **1 GB** volume `openfront_auth` at
`/data` (auth only: `AUTH_DIR=/data/auth`). `ServerEnv.saveDir()` defaults to
`<cwd>/saves` = `/usr/src/app/saves` for each worker, which is the container
rootfs. A Fly rootfs is ephemeral: it survives a stopped/started machine (Fly
bills it while stopped) but is lost when a Machine is replaced by a deploy.

**Proposed change (one line).** Add `SAVE_DIR = "/data/saves"` to `[env]` in
`fly.toml`; the existing `FilesystemSaveStore` already creates the directory,
writes head/history/checkpoint atomically, enforces retention (20 saves per
creator, 30 days, 2 GiB per worker) and prunes. No code, wire, or client change.

**Cost.** Volumes are `$0.15/GB-month` of _provisioned_ capacity, billed while
attached and while the machine is stopped (Fly pricing page). The current 1 GB
volume is already ~$0.15/month. Saves should not share the 1 GB with auth (a
full disk would break login), so extend to 3 GB: **+$0.30/month**. Fly waives
bills below `$5/month`, and this app is far below that, so the visible bill
will most likely not change. Volume snapshots (daily, automatic) are free up to
10 GB, giving a free backup. Import/export traffic is unchanged (egress is
`$0.02/GB`; a 4 MB save is negligible).

**Is it safer?**

- Yes versus manual export/import: saves survive deploys, no host action, no
  file left in Downloads, and the existing PII-stripping export/import stays as
  an offsite backup. `SaveStore` already handles crash-consistency and
  retention.
- Not a complete disaster-recovery story: one machine, one volume, one zone.
  The daily volume snapshot is the recovery point; keep offering Export for
  copies off Fly.
- Single-attach constraint: a Fly volume attaches to one machine at a time.
  With `NUM_WORKERS=1` on one machine that is a non-issue. If the app is ever
  scaled to multiple Machines, each needs its own volume (the store is already
  per-worker, and gameID sharding already routes saves to the owning worker).

**Is it simpler?** Yes. It is one config line on top of an already-implemented
store; the current export→file→import dance becomes a fallback instead of the
only way to survive a redeploy.

**Recommendation.** Do it: extend the volume to 3 GB, set
`SAVE_DIR=/data/saves`, deploy, then create a save and confirm
`/data/saves/w0/*.head.json` exists after a `fly machine restart`. If 2 GiB of
saves is more than wanted, lower `DEFAULT_SAVE_DIR_BUDGET_BYTES` (currently a
constant in `src/server/SaveStore.ts`) to ~1 GiB to leave headroom for auth.
