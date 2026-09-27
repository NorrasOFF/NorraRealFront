# Handoff — resume-as-lobby: the creator now starts a resumed save by hand

> Future sessions: this file is the current handoff. When you write your own,
> **overwrite this file** (`HANDOFF.md`) rather than appending — keep only the
> latest handoff here.

Companion notes: `testnotes.md`, `docs/SaveResumeLongGames.md`, `DEPLOYMENT.md`
("SAVE_DIR").

## 1. Where things are

- Repo: `C:\Users\ai51940\OpenFrontIO` (private fork).
- Working/deployed branch: `feature/save-resume-checkpoints` (the Fly.io GitHub
  integration auto-deploys `main`; `main` is kept at the feature tip).
- Push auth (do not print the token):
  ```powershell
  $tok = (Get-Content -Raw "H:\Documents\Hexfront token.txt").Trim()
  $b64 = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("x-access-token:$tok"))
  git -c http.extraheader="Authorization: Basic $b64" push origin feature/save-resume-checkpoints:main feature/save-resume-checkpoints
  ```
- App: https://openfrontio.fly.dev (Fly app `openfrontio`, `NUM_WORKERS=1`).

## 2. The problem this session fixed

A running save ("started" stage) appeared under **Resumable lobbies**, but
clicking it did **not** open a lobby: the creator was dropped toward the game
and it froze at the checkpoint; the other account could not get in at all.

Root cause: `SavesModal.selectServerSave` opened `join-lobby-modal` for any
save whose stage was not `"lobby"`, and the server armed the resume countdown
**automatically on the first join** (`beginResumeCountdown`). There was no
host-controlled lobby for a running save.

## 3. New behavior

Pressing **Resume** on a server save now always reopens the **host lobby**
(`host-lobby-modal`, in a new `resume` mode) for the creator:

- The invite link/copy button and the live roster are there, as for a normal
  private lobby, so the original players can open the link and claim their
  saved nations (the seat picker is unchanged).
- The config editor is hidden (a resumed game owns its map/mode/turns; letting
  the form re-send defaults would clobber the saved map).
- The **host presses Start** when ready. Start arms a short resume countdown
  (`GameServer.RESUME_START_DELAY_MS`, 15 s) and then delivers the checkpoint +
  suffix, exactly as before. Pressing Start again cancels the countdown.
- The game is no longer resumed by a timer on join.

## 4. What changed (files)

Server (`src/server/GameServer.ts`):

- New `isResumeLobby()` = `restored && stage === "started" && !resumeStarted`.
- `joinClient` / `rejoinClient`: for a resume lobby, just keep the lobby roster
  broadcasting (`startLobbyInfoBroadcast(true)`) instead of arming the
  countdown. Late joiners to an already-resumed game are unchanged.
- `handleIntent("toggle_game_start_timer")`: in a resume lobby, arm
  (`beginResumeCountdown`) or cancel (`cancelResumeCountdown`, new) the countdown.
- `beginResumeCountdown` doc updated; still private.

Server (`src/server/IntentAuthorization.ts`):

- `IntentGameState.isResumeLobby?` added; `toggle_game_start_timer` is allowed
  after start only when `isResumeLobby` (a normal started game still 409s).

Client:

- `src/client/SavesModal.ts` — `selectServerSave` always opens
  `host-lobby-modal` with `{ existingLobbyId, resume: true }`.
- `src/client/HostLobbyModal.ts` — `resumeMode` state; hides the config editor
  and the public/private toggle, shows a "Resume Game" title + notice, Start is
  enabled with a single client, and Start skips `putGameConfig()`.
- `resources/lang/en.json` — `host_modal.resume_title`, `host_modal.resume_notice`.

Tests updated: `tests/server/GameServerSave.test.ts` (host-triggered start +
cancel), `tests/server/IntentAuthorization.test.ts`, `tests/client/SavesModalResume.test.ts`,
`tests/LateGameSaveResume.test.ts`, `tests/EndgameSaveResume.test.ts`.

## 4b. Round 2: the resumed start showed an empty map at tick 0

After the lobby change, a resume still failed _inside_ the game: the checkpoint
was not applied, the map was empty and the clock sat at 0. Causes fixed:

- **The server now validates the checkpoint before serving it.** `restoreCheckpoint`
  trusted a save that carried `checkpointTurn` without ever decoding the blob, so
  a legacy/corrupt/other-build checkpoint was handed to the client, which could
  not decode it, skipped the saved base turns, and stalled. `Worker`
  `POST /api/saves/:id/resume` now `decodeCheckpointWire`s the blob; if it cannot
  be decoded the checkpoint is dropped and the game replays the full history.
- **The start frame always carries `numTurns`** (`GameServer.sendStartGameMsg`).
  With a checkpoint the `turns` are only the suffix; without the authoritative
  total the client read the suffix length as the total and set `turnsSeen`
  wrong (or not at all), injecting thousands of empty turns ahead of the suffix.
- **A stale live game is rebuilt, not reused.** The resume route returns a live
  game only when it still has clients; otherwise it `restoreGame(save, true)`s
  (new `force` flag) so an abandoned started game reopens as a lobby instead of
  auto-starting again. `GameManager.restoreGame(save, force)`.
- Client (`ClientGameRunner`): `startTotal` now derives from `numTurns` (falling
  back to the last turn number), and it warns loudly if a suffix arrives without
  a restored checkpoint (the old empty-map failure mode), plus info logs for the
  decoded checkpoint tick.

## 5. Verification this session

- `npx tsc --noEmit` — clean.
- `npm run lint` (oxlint + eslint) — clean.
- `npx vitest run tests/server/GameServerSave.test.ts tests/server/IntentAuthorization.test.ts tests/client/SavesModalResume.test.ts tests/EnJsonSorted.test.ts` — 66 passed.
- `npx vitest run tests/server` — only two failures, both **pre-existing**
  (verified on the clean tip): `MapPlaylistOvertime` (`isCompact`),
  `HostedLobbyListing > never schedules or sets countdowns on hosted lobbies`.
- Full `npx vitest run` shows the known environment-only `localStorage`
  failures (see `testnotes.md`), not regressions.
- The deployed `GIT_COMMIT` is `"unknown"` (see index.html), so the
  `commitMatches` build guard is a no-op in production; a checkpoint from any
  build is accepted. That is why the server-side decode validation above
  matters.

## 6. Next step

Re-test on the deployed app with two accounts:

1. Start a private game, play a few turns, press **Save checkpoint**.
2. Load → **Resumable lobbies** → Resume: expect the **Resume Game** host lobby
   (invite link + roster), not an immediate game.
3. Second account opens the invite link and claims its nation; then the host
   presses **Start** and both should enter the restored game past the
   checkpoint (non-empty map, clock past 0).

If it still fails, capture the browser console around `start`. The new logs name
the failure: `resume: decoded server checkpoint at tick N` (good) vs
`dropping unreadable server checkpoint` (the base state is missing). The server
logs `resume: dropping unreadable checkpoint, full replay` when it rejects the
blob; `flyctl logs -a openfrontio --no-tail` (needs `flyctl auth login`).

## 7. Open items

- **End-to-end save pipeline still not proven in-repo** (capture → encode →
  upload → `/api/saves` → store → restart → resume) — a real HTTP-route test
  with `FilesystemSaveStore` remains the P0.
- **Durability:** `fly.toml` sets no `SAVE_DIR` / volume; saves land on the
  machine's ephemeral disk (see `DEPLOYMENT.md`).
- **Cold start:** `auto_stop_machines='stop'` + `min_machines_running=0`; the
  client retries `502/503/504` but keeping a machine warm is the real fix.
- For an **unstarted** save (`stage === "lobby"`) the same host-lobby screen is
  now used, which also fixes a latent bug where Start re-sent the form's
  default config and reset the saved map.
- `docs/SaveResumeLongGames.md` §2.4 still describes the older
  creator-leave-only save path; the on-demand Save button is newer.
