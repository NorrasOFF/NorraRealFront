# Test Notes

## Pre-existing failure: SAM dynamic-range test

`tests/core/executions/SAMLauncherExecution.test.ts` →
"SAM intercepts incoming nuke during dynamic range expansion that is out of
level 1 range" fails on this branch (`expected 23.333… to be close to 25.555`).
It is unrelated to the save/resume work: it reproduces with the `src/core`
changes stashed at commit `aa4816a58`, and exercises no checkpoint/shell code.

## Known environment-only test failures (`localStorage`)

`UserSettings` reads/writes the global `localStorage` directly. On some local
setups (Node 22+ ships an experimental `localStorage` that is `undefined`
unless `--localstorage-file` is passed), the `localStorage` global is missing,
so tests that touch `UserSettings` fail with:

```
TypeError: Cannot read properties of undefined (reading 'getItem' / 'removeItem')
```

Affected test files include:

- `tests/UserSettings.test.ts`
- `tests/InputHandler.test.ts`
- `tests/client/InputHandlerGestureZoom.test.ts`

These are environment-only failures, **not code regressions**: they pass in CI
(where jsdom provides a working `localStorage`) and on machines where
`localStorage` is available.

## Same-nation trade ships

Trade ships may now pick a destination port owned by their own player (same
nation), not just foreign ports. Rules to keep in mind:

- Destination selection (`PortExecution.pickTradeDestination`): a same-nation
  port occupies one slot in the weighted pool while an equivalent foreign port
  occupies two, so a same-nation port is **half as likely** to be chosen.
- Payout (`TradeShipExecution.complete`): a same-nation arrival yields **half**
  the normal `tradeShipGold` and is paid to the single owner **once** (a normal
  trade pays the full amount to each of the two endpoint owners).
- A destination owned by the source owner is no longer treated as invalid, so
  the previous "delete the ship if the port changes to the current owner"
  behavior is gone.
- `StatsImpl.boatArriveTrade` skips the second `_addGold` when player ===
  target so same-nation trades are not double-counted in stats.

## Recorded endgame replay: harness fixes and new checkpoint version (v5)

`tests/EndgameSaveResume.test.ts` has a `ENDGAME_RECORD` mode that replays a
real archived game (its turns, with intents) instead of empty bot turns. It did
not actually work against the public archive; fixed here:

- `loadRecord` queried `GET /game/:id`, which 404s/403s. The archive lives at
  `GET /public/game/:id` (docs/API.md).
- The store's `ID` regex is `^[A-Za-z0-9]{8}$`, but archived public ids are 10
  chars. `wireGameId()` now maps any record id to a stable 8-char id used for the
  whole replay, so a real record can pass through `SavedLobbyHeadSchema`.

`CHECKPOINT_VERSION` is now **5** (was 4). New captures: a unit's target-unit
type/owner, the trade/transport pathfinder `stagger`, and a train's route and
endpoint station descriptors; nested unit state is deep-copied so a checkpoint is
a true snapshot. Old v4 blobs are rejected and fall back to full-history replay.

Real bugs found by replaying the 171-minute, 4-team private game
`dKLqTLUg9j` (20 players, nukes/transports/trains) and by the all-bot endgame:

- `ConstructionExecution` restored `ticksUntilComplete` as `0` when the live
  value was `undefined`, so a re-captured checkpoint differed. Now preserves the
  exact value.
- `UnitGrid.nearbyUnits` returned units in per-cell `Set` (insertion) order. A
  resumed game rebuilds the grid in checkpoint order, so equal-distance ties
  (e.g. warship target selection) resolved differently and the simulation
  diverged on the first suffix tick. Results are now ordered by
  `(distSquared, unit.id())`.
- The trade/transport pathfinder stagger was drawn from a process-global counter
  at `init`. A restored execution redrew it in a different order, so a
  re-captured checkpoint differed. The stagger is now assigned at construction
  and captured.
- `UnitImpl.checkpoint()` stored live references to `warshipState`/`nukeState`/
  `transportShipState`/`samLauncherState`, so a held checkpoint mutated as the
  game kept ticking. Captured (and restored) as copies.
- A train can outlive a station on its route (the station's unit was destroyed):
  only the endpoints were required to exist, so restore failed with
  `cannot restore execution kind train`. Route/endpoints are now captured as
  `{id, unitId, ownerId, type, tile}` and a removed station is rebuilt as an
  inert stub; a destroyed car becomes an inert stub too.
- A unit can outlive its `targetUnit` (train cars target the destination station
  unit). Restore dropped the dangling reference, changing `Unit.hash()`. The
  target's type/owner are captured and the reference is restored as an inert
  stub.

Validate a real long game (defaults for this record; nations are disabled, so
`nation` must not be required):

```
$env:ENDGAME_TEST="1"
$env:ENDGAME_RECORD="<path to record.json, or a game id>"
$env:ENDGAME_TICKS="60000"; $env:ENDGAME_MIN_UNITS="300"
$env:ENDGAME_REQUIRED_KINDS="player,nuke,warship,transport_ship,train,trade_ship,port,city,factory,missile_silo,sam_launcher,defense_post,attack"
$env:ENDGAME_SUFFIX="60"; $env:ENDGAME_CYCLES="1"
npx vitest run tests/EndgameSaveResume.test.ts
```

The gated soak timeout was raised from 15 to 30 minutes so a 60 000-tick replay
plus resume cycles fits. The re-captured-checkpoint comparison is structural
(`checkpointDiffs`), not byte-identical: encoded bytes are also sensitive to JSON
key insertion order, which is not deterministic state. When a raw wire still
differs the test logs `re-captured wire differs only by encoding order`, which is
benign.

Remaining known gap: this fork replays records with upstream ids/intents, so some
intents fail locally (`cannot build ...`, `Failed to spawn warship ...`). That is
expected and does not affect the save/resume comparison, which only requires the
local source and its resumed copies to agree.

## Resume-as-lobby: the host starts a resumed save by hand

A server save whose stage is `"started"` is no longer resumed on a timer when
the first player joins. `SavesModal.selectServerSave` always reopens
`host-lobby-modal` with `{ existingLobbyId, resume: true }`; the game waits in
the lobby (`GameServer.isResumeLobby()`) until the host presses Start, which
runs the usual 15 s `RESUME_START_DELAY_MS` countdown and then delivers the
checkpoint + suffix. `toggle_game_start_timer` arms/cancels that countdown and
is authorized after start only for a resume lobby
(`IntentGameState.isResumeLobby`).

Notes for future test edits:

- Tests that restore a started save and expect a `start` frame must first drive
  the host start, e.g.
  `game.handleIntent({ type: "toggle_game_start_timer" }, { clientID, isLobbyCreator: true, isAdmin: false, isAdminBot: false })`
  (see `hostStart` in `tests/server/GameServerSave.test.ts`).
- `isResumeCountingDown()` still means "restored and not yet resumed", so it is
  `true` both while waiting in the lobby and during the countdown.
- A resumed save (`resume: true`) hides the host-lobby config editor and Start
  skips `putGameConfig()`, so the saved map/config is never clobbered. This also
  fixes the unstarted-save (`stage === "lobby"`) path, which previously re-sent
  the form defaults on Start.

## Other pre-existing suite failures (verified on the clean tip)

Unrelated to save/resume, present with these changes stashed:

- `tests/server/MapPlaylistOvertime.test.ts` — `always enables overtime in FFA
lobbies` (`publicGameModifiers.isCompact` is `true`, expected `undefined`).
- `tests/server/HostedLobbyListing.test.ts` — `never schedules or sets
countdowns on hosted lobbies` (no `createGame` messages observed).

The many `localStorage`/WebGL client failures seen in a full local `vitest run`
are the documented environment-only failures above.
