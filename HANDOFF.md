# Handoff — save/resume: server save is not persisting on the Fly deployment

> Future sessions: this file is the current handoff. When you write your own,
> **overwrite this file** (`HANDOFF.md`) rather than appending — keep only the
> latest handoff here.

Audience: the next session debugging why a saved private-lobby game does not
appear under "Resumable lobbies". Companion notes: `testnotes.md`,
`docs/SaveResumeLongGames.md`, `DEPLOYMENT.md` ("SAVE_DIR").

## 1. Where things are

- Repo: `C:\Users\ai51940\OpenFrontIO` (private fork).
- Working branch: `feature/save-resume-checkpoints`.
- **Deployed branch is now `main`, and `main` == the feature tip** (the Fly.io
  GitHub integration auto-deploys `main`; there is no deploy workflow). Latest:
  - `7008b22bb` Report the server save outcome to the host (save_ack) (this session)
  - `c3e96b250` Ride out gateway cold starts and give the worker a writable save dir
  - `0c8f030b3` Make server-side save failures diagnosable
  - `0c07e594e` Note that future sessions should overwrite the handoff
- Push auth (do not print the token):
  ```powershell
  $tok = (Get-Content -Raw "H:\Documents\Hexfront token.txt").Trim()
  $b64 = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("x-access-token:$tok"))
  git -c http.extraheader="Authorization: Basic $b64" push origin feature/save-resume-checkpoints:main feature/save-resume-checkpoints
  ```
- App: https://openfrontio.fly.dev (Fly app `openfrontio`, `NUM_WORKERS=1`).

## 2. The bug being chased

Private lobby, 2 players, host presses **Save checkpoint** → client shows
"Checkpoint saved" → opening **Load** shows "Resumable lobbies" **empty**
(later with no error banner at all; earlier once with `worker 0: HTTP 502`).

What is already established:

- The server-side feature **is deployed**: `GET /w0/api/saves` on the live app
  returns `400 {"error":"Authorization header required"}`, a route that only
  exists in the save/resume feature. `origin/main` has the on-demand
  `scheduleSave()` in `GameServer.ts` (`acceptCheckpointWire`).
- The client "Checkpoint saved" toast fires in
  `ClientGameRunner` `setCheckpointCallback` **unconditionally**, before/without
  any server acknowledgement. It is not proof the save persisted.
- All in-repo tests pass (`MemorySaveStore` and `FilesystemSaveStore`
  round-trip/list are covered). So this is a runtime/deployment failure, not a
  covered-by-tests code path.

## 3. What this session changed (pushed)

**Self-diagnosing Save (commit `7008b22bb`)** — so the host does not need logs.

- New server→client `ServerSaveAckSchema` (`save_ack`, appended last in the
  `ServerMessageSchema` union so wire indices of every other message are
  unchanged): `{status: "persisted"|"dropped"|"failed", reason?, ticks?}`.
- `GameServer.sendSaveAck` targets the client that pressed Save (or the host);
  every rejection path acks with a short reason (`not_host`, `no_account`,
  `not_started`, `public_game`, `too_large`, `unreadable`, `tick_out_of_range`,
  `not_newer`, `too_many_chunks`, `rate_limited`, `bad_encoding`,
  `write_failed`). `persistSave` reports `persisted`/`failed`.
- Client: on capture, a server-backed save shows `save_game.checkpoint_pending`
  ("Saving checkpoint…"); the `save_ack` replaces it with
  `save_game.checkpoint_saved` or a red `save_game.checkpoint_not_saved`
  carrying the reason. A local/non-host save still confirms immediately.

**Diagnostics (commit `0c8f030b3`)** — the point of the session: make the next
run conclusive.

- `GameServer.handleClientCheckpoint` / `handleClientCheckpointChunk`: log every
  early return (not started, public, no creator account, **not the lobby
  creator**, oversized, bad chunk count, rate limit, over byte budget).
- `GameServer.acceptCheckpointWire`: log unreadable blob, tick out of range,
  not-newer-than-held, and — on success — `accepted host checkpoint, persisting
save` with `{ticks, turns, bytes}`.
- `ClientGameRunner.uploadCheckpoint`: log the client-side skip reason (local
  game, not the lobby host, not newer, over the transfer cap).
- `Worker.ts`: log `resumable save store: <dir>` at startup.

**Hardening (commit `c3e96b250`)**

- `src/client/Api.ts`: retry the save endpoints (`list`, `resume`, `delete`,
  `seats`) on `502/503/504` with backoff `[800,1600,3200,6400] ms` — a
  cold-starting/rolling Fly machine otherwise looks exactly like "no saves".
- `src/client/SavesModal.ts`: a failed lookup now shows the diagnostic + a
  **Retry** button instead of "No resumable lobbies"; added `save_game.retry`.
- `Dockerfile` `start.sh`: create `SAVE_DIR` (default `/usr/src/app/saves`) and
  `chown -R node:node` it. The worker runs as the unprivileged `node` user but
  both `/usr/src/app` and a mounted Fly volume are root-owned, so writes fail
  with `EACCES` and are swallowed by `persistSave` (logged only). **Unverified
  as the cause** — kept as required hardening.

Tests: `tests/client/GameServerApiCallers.test.ts` covers the retry (rides out a
transient 502; surfaces a persistent one after retries).

## 4. Verification this session

- `npx tsc --noEmit` — clean.
- `npm run lint` (oxlint + eslint) — clean.
- Targeted: `tests/client/GameServerApiCallers.test.ts`,
  `tests/client/SavesModalResume.test.ts`, `tests/EnJsonSorted.test.ts`,
  `tests/zbin/wire.test.ts`, `tests/server/SaveStore.test.ts`,
  `tests/server/GameServerSave.test.ts` — all passed (the last now covers both
  `save_ack` persisted and dropped-not-host).
- Full suite NOT re-run this session.

## 5. Next step (do this before changing more)

Re-test on the deployed app. As of `7008b22bb` the **in-game toast names the
outcome**: a red "Checkpoint not saved on the server (…)" carries the reason, so
you may not need the logs at all. If you do want them, they name the failure:

```
fly logs -a openfrontio --no-tail
```

Expected, and what each means:

- `resumable save store: <dir>` — confirms the path the worker will write.
- `checkpoint upload ignored: not the lobby creator` / `no creator account` /
  `game not started` — the host's upload was dropped; look at
  `isLobbyCreator()`/`lobbyCreatorID` (host `clientID` vs `creatorPersistentID`).
- `checkpoint upload ignored: too large` / `dropping checkpoint: …` — size or
  tick/commit validation.
- `accepted host checkpoint, persisting save` then `failed to persist game save`
  — the write failed (EACCES/ENOSPC): the writable-save-dir fix is the answer.
- `accepted host checkpoint` but NO `persisted`/`failed` line — `scheduleSave()`
  was a no-op (`isPublic()` / `creatorPersistentID === undefined`).
- Browser console `uploading checkpoint to server: …` vs `checkpoint not
uploaded: …` tells you whether the client even sent it.

## 6. Other open items (unchanged from the previous handoff)

- **End-to-end save pipeline is still not proven in-repo** (client capture →
  encode → upload → `/api/saves` accept → store → restart → resume). The
  `0c8f030b3` logs are the first step; a real test driving the HTTP routes +
  `FilesystemSaveStore` would be the P0.
- **Durability:** `fly.toml` sets no `SAVE_DIR` and declares no volume. Saves
  land on the machine's ephemeral disk and are lost on redeploy. If the logs
  show a successful write but the list is still empty after a deploy, mount a
  volume and set `SAVE_DIR` (see `DEPLOYMENT.md`); the `chown` fix in the
  Dockerfile is what makes a mounted volume writable.
- **Cold start:** `auto_stop_machines='stop'` + `min_machines_running=0` means
  an idle machine 502s while it starts; the client retry masks it, but keeping
  one machine warm is the real fix if this keeps biting.
- `docs/SaveResumeLongGames.md` §2.4 still says saves are creator-leave-only;
  the on-demand Save-button path is newer and undocumented there.
