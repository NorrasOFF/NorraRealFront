# Handoff — robust save/resume for long private-lobby games

> Future sessions: this file is the current handoff. When you write your own,
> **overwrite this file** (`HANDOFF.md`) rather than appending — keep only the
> latest handoff here.

Audience: the next session working on `feature/save-resume-checkpoints`.
Companion notes: `testnotes.md`, `docs/SaveResumeLongGames.md`.

## 1. Where things are

- Repo: `C:\Users\ai51940\OpenFrontIO` (private fork).
- Branch: `feature/save-resume-checkpoints`, pushed to
  `hexfront-dev/OpenFrontIO` (remote `origin`). Push auth uses the token in
  `H:\Documents\Hexfront token.txt` (see "Pushing" below).
- Latest commits (newest first):
  - `53e567c6b` Make recorded endgame replay work and fix checkpoint restore asymmetries (this session)
  - `16cd9ce0a` Fix endgame checkpoint restore bugs found by a chained save/resume test
  - `aa4816a58` Restore trade ships whose source port was destroyed mid-voyage
  - `40cb37936` Fix late-game checkpoint save/resume correctness
- `CHECKPOINT_VERSION` is now **5**. v4 blobs are rejected and fall back to
  full-history replay.

## 2. What this session changed

### Harness — real records now replay

- `tests/EndgameSaveResume.test.ts` `loadRecord` queried `GET /game/:id` (403).
  Fixed to `GET /public/game/:id` (docs/API.md).
- Archived public ids are 10 chars; the store's `ID` regex is `^[A-Za-z0-9]{8}$`.
  Added `wireGameId()` to map any record id to a stable 8-char id used for the
  whole replay (source + resumed + `SavedLobby`).
- Added `checkpointDiffs()` (structural, path-printing) and made the
  re-captured-checkpoint comparison structural instead of byte-identical (JSON
  key order is not deterministic state). Logs a benign note when raw wires
  differ only by encoding order.
- Gated soak timeout raised 15 → 30 min so a 60 000-tick replay fits.

### Core fixes (all found by the deep replay / all-bot endgame)

- `ConstructionExecution`: `ticksUntilComplete` was restored as `0` when the
  live value was `undefined`, breaking re-capture. Now preserves the exact value.
- `UnitGrid.nearbyUnits`: returned per-cell `Set` insertion order; a resumed
  game rebuilds the grid in checkpoint order, so equal-distance tie-breaks
  (warship target selection) differed and the sim diverged on the **first**
  suffix tick. Results now ordered by `(distSquared, unit.id())`.
- Trade/transport pathfinder `stagger` was drawn from a process-global counter
  in `init`; a restore redrew it in a different order. Now assigned at
  construction and captured (`data.stagger`).
- `UnitImpl.checkpoint()` returned live references to
  `warshipState`/`nukeState`/`transportShipState`/`samLauncherState`, so a held
  blob mutated. Now deep-copied on capture and restore.
- `TrainExecution`: a train can outlive a route station (its unit was destroyed),
  and a unit can outlive its `targetUnit` (train cars target the destination
  station unit). Restore used to throw `cannot restore execution kind train`.
  Route + endpoints are now captured as `{id, unitId, ownerId, type, tile}`
  descriptors and a removed station/car/target is rebuilt as an inert stub
  (`resolveStation`, `resolveCar`, `missingUnitStub`).

Files touched: `src/core/Checkpoint.ts`, `src/core/execution/{Construction,ExecutionCheckpoints,TradeShip,Train,TransportShip}Execution.ts`,
`src/core/game/{UnitGrid,UnitImpl}.ts`, `testnotes.md`, `tests/EndgameSaveResume.test.ts`.

## 3. Verification status (this session)

- `npx tsc --noEmit` — clean.
- `npx oxlint` / `npx eslint .` — clean.
- `tests/core/Checkpoint*`, `tests/server/SaveStore`, `tests/server/GameServerSave`,
  `tests/SaveManager` — 94 passed.
- All-bot endgame: `ENDGAME_TICKS=10000 ENDGAME_SUFFIX=120 ENDGAME_CYCLES=3` — passed.
- Real record `dKLqTLUg9j` (171 min, 4-team, 20 players, 6.5 MB JSON): passed at
  **20 000** and **60 000** ticks.
- Full `npx vitest run`: failure set is **identical to the pre-change baseline**
  (438 failed / 3988 passed; all pre-existing `localStorage`/environment). Zero
  regressions.

## 4. Running the gated tests

All-bot endgame (World, nations on):

```powershell
$env:ENDGAME_TEST="1"; $env:ENDGAME_TICKS="10000"; $env:ENDGAME_SUFFIX="120"; $env:ENDGAME_CYCLES="3"
npx vitest run tests/EndgameSaveResume.test.ts
```

Real record (`dKLqTLUg9j`; nations disabled, so do NOT require `nation`). The
record is cached at
`C:\Users\ai51940\AppData\Local\Temp\opencode\openfront_record_dKLqTLUg9j.json`;
you can also pass a game id and it will fetch `/public/game/:id`:

```powershell
$env:ENDGAME_TEST="1"
$env:ENDGAME_RECORD="C:\Users\ai51940\AppData\Local\Temp\opencode\openfront_record_dKLqTLUg9j.json"
$env:ENDGAME_TICKS="60000"; $env:ENDGAME_MIN_UNITS="300"
$env:ENDGAME_REQUIRED_KINDS="player,nuke,warship,transport_ship,train,trade_ship,port,city,factory,missile_silo,sam_launcher,defense_post,attack"
$env:ENDGAME_SUFFIX="60"; $env:ENDGAME_CYCLES="1"
npx vitest run tests/EndgameSaveResume.test.ts
```

Late-game harness is separately gated by `LATEGAME_TEST=1`.

Pushing (do not print the token):

```powershell
$tok = (Get-Content -Raw "H:\Documents\Hexfront token.txt").Trim()
$b64 = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("x-access-token:$tok"))
git -c http.extraheader="Authorization: Basic $b64" push origin feature/save-resume-checkpoints
```

## 5. Honest confidence statement

What is proven: a checkpoint captured at 20k–60k ticks of a real 4-team game and
of the 400-bot endgame, encoded/decoded through the real codec, restored into a
fresh game, reproduces the uninterrupted run's per-tick and periodic hashes over
a short suffix, and structurally re-captures an equal checkpoint. Several real
asymmetries were found and fixed this way.

What is NOT proven:

- The **end-to-end save pipeline** (client capture → size guard → gzip/chunk →
  server accept/store → restart → worker restore → other clients → catch-up
  render). The test bypasses all of it.
- **Long-horizon divergence.** Suffix is 60–120 ticks; real games resume for
  hours. The `stagger` path only matters after a **water nuke**, which the record
  never triggers (`doomsdayClock` disabled, no in-flight MIRVs at sampled ticks,
  `overtime` disabled).
- **`hash()` is incomplete** (it misses `nukeState.trajectoryIndex`,
  `warshipState`, `targetUnit`, many unit fields). Per-tick hash equality is
  necessary but weak; the structural re-capture only covers **captured** fields,
  so a symmetric capture+restore bug passes.
- **Cross-platform/cross-browser determinism** (float arithmetic, any
  wall-clock use) — one Node process on one machine cannot show this.
- **Roster/config drift** between capture and resume (players leaving/joining,
  team reassignment, anonymization blanking, different build/map/minimap scale).
- **Rare player state** (alliances, relations, embargoes, targets, tolls,
  donations, alliance history): the record is Team mode with ~0 alliances and ~1
  attack at capture, so those paths pass by absence, not by validation.
- **Fallback correctness (I1)**: `checkpoint()` undefined, decode failure,
  gitCommit/version mismatch, oversize, corrupt input, and the client/worker
  catch-and-replay path are untested end-to-end.

## 6. Prioritized next steps

**P0 — end-to-end save path + the fallback safety net.**
Add a test that drives the real pipeline for a private game: host capture →
`encodeCheckpointWire` → chunked upload frames → server `handleClientCheckpoint`
(creator/private/tick guards, byte budget) → `FilesystemSaveStore` → server
restart → `sendStartGameMsg` → client decode → worker `restoreFromCheckpoint`.
Include the negative cases that must degrade to full-history replay without
erroring: `checkpoint()` undefined, undersized/oversized blob, wrong gitCommit,
truncated/hostile base64, and a checkpoint whose tick is ahead of the server's
turn count. This is where a "working" core still becomes a broken feature.

**P1 — exercise the trigger-only state at scale.**
Either extend the record mode with a game that has water nukes / MIRVs /
doomsday enabled, or add the synthetic entity-injection test that was deferred:
one checkpoint containing in-flight nukes, MIRVs + warheads, transports, a
doomsday-clock rot front, SAMs, shells, trains, trade ships, plus rich player
state (relations/embargoes/targets/tolls/donations/alliance history). Assert the
checkpoint carries all required kinds, then restore + suffix-hash + structural
re-capture. Water nukes are the important one: they are the only thing that makes
the pathfinder `stagger` observable.

**P2 — roster/config drift.**
Restore a checkpoint into a game whose roster differs (a human seat dropped, a
bot added, different team assignment, anonymization on) and assert either a
correct restore or a clean fallback — never a throw. Decide whether
`restoreFromCheckpoint` should throw or return `false` for a missing construction
player, and make the client path honor it.

**P3 — remaining gap list (roughly in value order).**

- Encode-size/latency budget assertions for the maps in the test, and a
  large-map case (`giantworldmap`) that actually compresses under the cap.
- `SaveManager`/IndexedDB cadence + quota, and `beginCatchUp`/render-snapshot
  resume.
- Legacy tagged-JSON-gzip decode path and corrupt/truncated base64.
- Confirm/parametrize `ENDGAME_REQUIRED_KINDS` per adopted config (documented in
  `testnotes.md`; the record config requires the list in §4).
- A fresh-Node-process restore (not just a fresh `FilesystemSaveStore`) to catch
  any module-global leakage beyond the two pathfinder staggers.

## 7. Gotchas for the next session

- The trade/transport `stagger` is a **process-global** counter. The test runs
  the source and the resumed game in **separate phases, never interleaved**;
  ticking two games in one process at once makes them draw from the same counter.
  (This is why the earlier lockstep experiment produced bogus stagger diffs.)
- The checkpoint is captured from the **host**; what production actually needs is
  that every client restores the same blob to the same state. The test restores
  in one process.
- The re-capture comparison is structural. A raw-wire mismatch that is only JSON
  key order is logged and ignored; a _value_ mismatch is a hard failure.
- Record replay logs `cannot build ...` / `Failed to spawn warship ...` because
  the fork replays upstream intents. That is expected and does not affect the
  save/resume comparison (which only needs the local source and its copies to
  agree).
- Deep runs are slow (~16 min for 60 000 ticks) and memory-heavy; raise timeouts
  rather than shortening the tick count when validating endgame behavior.
