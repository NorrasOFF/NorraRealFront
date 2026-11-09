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

## Retreats are free and twice as fast

The retreat (cancel-attack) cost and delay were removed/halved:

- `AttackExecution.ts`: the `malusForRetreat = 25` constant and the
  `malusPercent` parameter of `retreat()` are gone. A land attack that retreats
  against a player now refunds **all** surviving troops; previously 25% were
  killed and an `events_display.attack_cancelled_retreat` message was shown. The
  translation key stays in `en.json` but is now unreferenced. `retreat()` no
  longer uses `renderTroops`/`MessageType`, so those imports were removed.
- `TransportShipExecution.ts`: the same 25% malus on a boat arriving at a tile
  the attacker already owns (auto-retreat) is removed — the full boat troop
  count is refunded and no `ATTACK_CANCELLED` message is emitted.
- `RetreatExecution.ts`: `cancelDelay` is now `10` (was `20`). A retreat ordered
  via `orderRetreat` resolves to `executeRetreat` in half the ticks. The delay
  is part of the retreat checkpoint, so save/resume captures it exactly.

Test impact: `tests/Attack.test.ts` "Boat penalty on retreat Transport Ship
arrival" became "No troop penalty on retreat Transport Ship arrival" and asserts
`defender.troops() >= player_start_troops` after the refund.

## Missile/anti-missile ships step every 1.5 ticks

`FleetFormation.shipMoveInterval` now returns `1.5` (was `2`) for
`MissileShip`/`MissileDefenseShip`; warships stay at `1`. Such a ship therefore
takes two movement steps every three ticks instead of one every other tick.

Because `1.5` is not an integer, the old `ticks % interval` test cannot be used.
`FleetFormation.shipShouldMove(ticksPerMove, ticks)` decides a step with integer
half-tick math: the ship has moved `floor(ticks * 2 / rateX2)` times by `ticks`
(`rateX2 = ticksPerMove * 2`, so `1 -> 2`, `1.5 -> 3`). This matches the old
modulo for integer rates, so a resumed checkpoint with `fleetMoveRate = 2` still
steps on even ticks.

`computeFleetMoveRate` returns `1.5` for a fleet containing a missile ship, and
`WarshipExecution`/`MissileShipExecution`/`MissileDefenseShipExecution` all gate
movement through `shipShouldMove`, so a mixed fleet steps at 1.5. `fleetMoveRate`
is part of the unit checkpoint, so save/resume captures the rate exactly.

Tests: `tests/core/FleetFormation.test.ts` pins the rate and the step pattern
(two moves per three ticks; gaps of 1 or 2; integer-2 backward compatibility).

Health: `MissileShip`/`MissileDefenseShip` still have `maxHealth: 1000` (same as
a `Warship`) and no per-level health bonus — the +10%/level HP scaling added in
`e74f86897` was removed in `1413b7445` together with the speed penalty. So
leveling these ships increases health by 0 today.

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

## Empty-map resume (round 2)

A resume that opened the game on an empty map with the clock at 0 was the client
skipping the saved base turns it never restored. Guards now in place:

- `sendStartGameMsg` always sets `numTurns` (the authoritative total). With a
  checkpoint the frame's `turns` are only the suffix, so a client that read
  `turns.length` as the total mis-set `turnsSeen` and injected empty turns.
- `POST /api/saves/:id/resume` decodes the checkpoint (`decodeCheckpointWire`)
  and drops it if the current build cannot read it, so the client gets a full
  history instead of a suffix over a fresh game.
- `GameManager.restoreGame(save, force)` and the resume route rebuild a live
  game that has no clients, so an abandoned started game reopens as a lobby
  rather than auto-starting an empty game.
- `ClientGameRunner` warns
  `resume: server sent turns from N but no checkpoint was restored`.

The deployed `GIT_COMMIT` is `"unknown"`, so the `commitMatches` guard never
rejects an old save; the server-side decode check is what protects resume.

## Other pre-existing suite failures (verified on the clean tip)

Unrelated to save/resume, present with these changes stashed:

- `tests/server/GameServerPhase.test.ts` — `prunes on tick, not on a
lobby-browser read` (`numClients` is already 0 before `gm.tick()`). Verified
  on the clean tip by stashing the account-tier work.
- `tests/server/HostedLobbyListing.test.ts` — `never schedules or sets
countdowns on hosted lobbies` (no `createGame` messages observed).
- `tests/server/GameServerWire.test.ts` — `matches the golden transcript for a
scripted game`. The golden snapshot predates `sendStartGameMsg` always
  sending `numTurns` (commit `9d6f30109`), so every `start` frame now has an
  extra `numTurns` key. Fails on the clean tip too (verified by stashing).

## Resume full view sync (B2 view half)

A resumed save that skips the pre-checkpoint turns left the client view in
spawn phase with an almost-empty map: the view is rebuilt from worker updates,
so it never saw the base territory, the pre-existing units, or the one-shot
`SpawnPhaseEnd` update (all emitted before the checkpoint).

`GameImpl.restoreFromCheckpoint` now sets `needsFullViewSync`; the first
`executeNextTick` after a restore calls `emitFullViewSync`, which records every
owned/flagged tile, re-emits `SpawnPhaseEnd`, re-emits each live unit's update,
and clears `PlayerImpl.lastSentUpdate` so the tick's player diff is a full
snapshot. `GameRunner` also forces name placements on that tick. This only adds
view updates — simulation state and hashes are unchanged.

Guards: `tests/core/ResumeFullViewSync.test.ts` (core side: first post-restore
tick has a `SpawnPhaseEnd`, >10 tile updates and >0 unit updates) and
`tests/client/view/ResumeViewSync.test.ts` (client side: one synthetic
full-sync update leaves spawn phase and rebuilds territory + a city). The
client test stubs `localStorage`, so it also passes under Node 26.

The many `localStorage`/WebGL client failures seen in a full local `vitest run`
are the documented environment-only failures above.

## Resume reuses a lobby, never a running game

`POST /api/saves/:id/resume` used to return an already-live game whenever any
client was still connected (`liveClients > 0`). That is correct while the game
is still waiting in its lobby, but once it has resumed, returning it makes the
joining client receive a `start` frame and drop straight into the running game.
Reproduction: be in the same save on a second device while the first imports or
resumes it, then join — no lobby, straight into the game.

Fixes:

- `GameServer.isWaitingInLobby()` = `restored && !resumeStarted` (=
  `isResumeCountingDown()`, which now delegates to it). The resume route reuses
  a live instance only when this is true.
- A live game that has already resumed is rebuilt from the save
  (`gm.restoreGame(save, true)`), so reopening a save always lands in a lobby.
- The ownership check now runs before the live-game fast path, so a
  non-creator can no longer read another account's live game via `resume`.
- `?force=1` makes the resume always rebuild. The file-import path
  (`SavesModal.onImportLobbyFile` → `resumeSavedLobby(id, { force: true })`)
  passes it so the just-imported file wins even if an older live copy of the
  same game is still waiting in its lobby.

Tests: `tests/server/GameServerSave.test.ts` (`isWaitingInLobby` before/after
start), `tests/client/GameServerApiCallers.test.ts` (the `?force=1` URL), and
`tests/client/SavesModalResume.test.ts` (import calls resume with `force`).

## Defense-post drag upgrades existing posts (5× via double-tapping the keybind)

The left-drag "draw a line of defense posts" gesture previously emitted one
`build_unit` intent per sampled tile. On a tile that already holds a defense
post the build simply failed. Now the line decides per tile:

- Empty tile → build a new defense post (unchanged).
- Tile with an owned, active, not-under-construction defense post → upgrade it.

`BuildPreviewController.onDefenseLineComplete` builds a `tile → unitId` map from
`myPlayer.units(UnitType.DefensePost)` (skipping under-construction posts) and
calls the new exported pure helper `planDefenseLineActions(tiles, postIdAt,
upgradeAmount)`, which returns a `build`/`upgrade` action per tile. Upgrades are
sent as a **single** `SendUpgradeStructureIntentEvent(unitId, DefensePost,
amount)` per post. A single intent with `amount` is required: `UpgradeStructureExecution`
runs its `amount` upgrade loop before `beginDefensePostUpgrade()`, so a bulk
amount stacks levels in one tick. Emitting several separate intents would make
all but the first fail, because the post is under construction after the first
(which is also why the legacy Shift-click 5× upgrade path — 5 separate intents
with `amount = upgradeMultiplier` — only lands one level on a defense post when
Instant Build is off).

The upgrade amount comes from `uiState.upgradeMultiplier` (the active build
amount), not Shift. `InputHandler.setGhostStructure` already sets
`upgradeMultiplier = 5` when the currently-active structure keybind is pressed a
second time, so **double-tapping the defense-post keybind (4)** arms a 5-level
upgrade; a single tap leaves it at 1, and scrolling while the ghost is active
cycles 1/5/10/50. This also means double-tap-4 + a single click upgrades a post
5 levels through `createStructure` (one intent with `amount = 5`). Shift is
untouched: a defense-post ghost does not override the Shift
`boxSelectWarships` gesture.

Tests: `tests/client/controllers/BuildPreviewController.test.ts`
(`planDefenseLineActions`: mixed build/upgrade, amount, all-empty, all-existing);
the double-tap multiplier behavior is covered by `tests/InputHandler.test.ts`
("pressing the active build hotkey selects five upgrades").
`tests/core/utilities/DefensePostLine.test.ts` and
`tests/core/executions/UpgradeStructureExecution.test.ts` still pass.

## Ctrl+drag conquest avoidance is a region toggle

The ctrl+drag that excludes frontline tiles from conquest no longer toggles each
tile independently. `AvoidConquestController.onBoxComplete` now snaps the whole
selection to one uniform state via the exported `planAvoidConquest` helper:

- If fewer than half (a tie included) of the selected frontier tiles are already
  avoided, every selected tile is frozen.
- If a majority are already avoided, every selected tile is re-enabled.

A fresh zone therefore freezes completely and a fully-excluded zone unfreezes
completely, instead of leaving a patchwork where the rectangle overlapped mixed
states. Only tiles whose state actually changes are sent in the `avoid_conquest`
intent, so the core's per-tile toggle (`AvoidConquestExecution`) still lands on
the desired uniform state. Tests:
`tests/client/controllers/AvoidConquestController.test.ts`.

## Trains have no diminishing return per stop

`Config.trainGold` no longer reduces the payout as a train visits more city/port
stations. The `citiesVisited` parameter and the `5_000`-per-stop `distPenalty`
(after a 10-stop free window, flooring at `5_000`) are gone. Every stop pays the
full base for the relation: `25_000` for `self`/`team`/`other`, `35_000` for
`ally`, scaled by `goldMultiplierFor(player)`. So a train that has already
visited any number of stations still earns `25_000` per stop (the ally rate
stays `35_000`).

Callers updated: `TrainStation.TradeStationStopHandler` now calls
`config.trainGold(rel, owner)` (it still tracks `tradeStopsVisited` on the
execution and in the checkpoint, but the value is no longer read).
`NationStructureBehavior.buildReachableStations` drops its `0` stop argument
(its weights were already based on zero stops, so behavior is unchanged there).

Tests: `tests/core/game/TrainStation.test.ts` ("Config.trainGold has no per-stop
penalty": self/other/team `25_000`, ally `35_000`) and the mock in
`tests/NationStructureBehavior.test.ts`.

## Remove-railroad radial button

Clicking a tile on a railroad that is on your own territory now offers a red
"Remove Railroad" action (the same red-X delete style as Delete Unit /
Disconnect Grid) that destroys that single rail segment. It is a new radial
`Slot.Railroad` element (`destroyRailroadElement`) added to
`rootMenuElement.subMenu` only when `GameView.hasRailroadAt(tile)` is true, so
the wheel stays uncluttered away from tracks.

Wire/sim: new `destroy_railroad` intent (`DestroyRailroadIntentSchema`,
`{ type, tile }`, appended at the **end** of `IntentSchema`/`Intent` so existing
binary variant ordinals are unchanged). `DestroyRailroadExecution` resolves the
tile to a railroad and removes it; `RailNetwork.railroadsAt(tile)` returns the
segments whose tile list contains the tile (sorted by id for determinism across
clients/checkpoints) and `RailNetwork.removeRailroad(rail)` deletes the edge and
marks the endpoint clusters dirty so the per-tick
`RecomputeRailClusterExecution` splits any cluster the cut disconnected. The
two endpoint stations are left standing.

Ownership rule: a player may only cut rails on tiles they own
(`mg.owner(tile) === player`), so a railroad crossing your land can be pruned
even if its stations belong to someone else; a non-owner's intent is rejected
with a `SECURITY` warning. At a junction several segments can share the clicked
tile, so the execution prefers a segment where the tile is interior (not an
endpoint), falling back to the lowest-id segment.

Tests: `tests/core/executions/DestroyRailroadExecution.test.ts` (removal on an
interior tile, removal on an endpoint tile, rejection by a non-owner, no-op on a
rail-less owned tile) and the `Slot.Railroad` cases in
`tests/client/graphics/RadialMenuElements.test.ts`. `tests/zbin` still pass
(appending a union variant does not move existing tags).

Browser-verified end to end (headless Chrome, throwaway `e2e` driver reusing
`driver.mjs`/`game.mjs`): built a City + Factory with `instantBuild` +
`infiniteGold`, waited for trains, right-clicked a real rail tile, found the
`path[data-id="railroad"]` radial slice present, dispatched its click, and
confirmed `GameView.hasRailroadAt(ref)` went `true -> false` and the client
`RailroadCache` held 0 railroads. Artifacts: `e2e/artifacts/07-game-train.png`
(trains on the rail + a `+25.0K` train-gold popup) and
`08-game-remove-railroad.png` (the radial slice). The throwaway driver was
deleted; re-create it from this note if the flow needs re-running.

## Defense-post drag can start on the hotbar; HUD icons are not draggable

Pressing an already-selected build hotbar icon and dragging onto the map was
swallowed by the browser's native image drag: the `<img>` icons in the hotbar
(`UnitDisplay`) and build menu (`BuildMenu`) had no `draggable="false"`, so a
press-and-drag from an icon showed the OS "no-drop" cursor (the reported "stop
sign") and never reached the canvas, so the defense-post line gesture never
started.

- `UnitDisplay.renderUnitItem`: the icon `<img>` sets `draggable="false"`, the
  item container cancels `dragstart`, and a `@pointerdown` on an already-selected
  icon emits the new `BeginBuildDragEvent`.
- `BeginBuildDragEvent` (`InputHandler.ts`) makes `InputHandler` start pointer
  tracking (`pointerDown`, `pointerDownFromHud`, the down position) so the
  following `window` `pointermove` runs the defense-post line branch and
  `pointerup` completes it. A press that began on the HUD and did not become a
  line drag returns early in `onPointerUp` (`pointerDownFromHud` guard), so the
  hotbar's own `@click` still toggles selection; `window.blur` clears the flag.
- `BuildMenu` icon + gold `<img>`s set `draggable="false"`.

Only the defense-post ghost starts a line this way; other build icons keep their
click-only behavior. Browser-verified in headless Chrome (throwaway `e2e` driver
reusing `driver.mjs`/`game.mjs`): a hotbar press-drag built a post on an empty
sample and upgraded the post under the end sample by +5 (double-tap
multiplier), with zero native `dragstart` events.

## Defense-post drag upgrades every post the line passes over

`planDefenseLineActions` (`BuildPreviewController.ts`) no longer matches posts
by exact sample tile. It now takes the owned posts and the dragged segment and
upgrades **every** post within `structureMinDist` (15) of the segment
(`distanceSqToSegment`, also exported), then builds on each sampled tile that
has no post within that radius. So dragging across a cluster of posts upgrades
all of them, even when their tiles fall between the 55-unit build samples.

The controller (`onDefenseLineComplete`) passes the live post list (owned,
active, not under construction) and the segment; the radius is
`config().structureMinDist()`, matching the radius a click uses to offer an
upgrade. Unit tests: `tests/client/controllers/BuildPreviewController.test.ts`
(post on the line upgrades + far samples build; posts between samples all
upgrade; off-line posts untouched; samples near a post aren't built on;
`distanceSqToSegment` cases).

Browser-verified: built a row of 4 posts 55 tiles apart with the line tool, then
re-dragged shifted 5 tiles (so no build sample lands on any post) — all four
went level 1 -> 6 at the 5x multiplier. Under the old exact-tile matcher none
would have upgraded.

## Factory rail links are an informational "Railroad" unit

A private-fork feature: two of **the same player's own factories** that are
joined by rail become a persistent `UnitType.Railroad` unit, shown only in that
player's own info menu (the radial `PlayerPanel`) in a fleet-display-shaped list
with a small red delete button per entry.

- `UnitType.Railroad = "Railroad"` (`Game.ts`, appended last so existing binary
  union ordinals are unchanged). `Config.unitInfo` gives it `cost: () => 0n`,
  no `maxHealth`, no construction; it is not in `Structures`/`BuildMenus`/
  `PlayerBuildable`, is never rendered (it is absent from the client
  `ALL_UNIT_TYPES`, so `UnitPass`/`StructurePass` skip it) and is created with
  `setTargetable(false)`. `PlayerImpl.canSpawnUnitType` returns `false` for it.
- `RailroadLinkExecution` (added in `GameRunner.init` right after
  `RecomputeRailClusterExecution`, only when Factory is not disabled) reconciles
  links every tick. Two factories count as connected when their `TrainStation`s
  share a `Cluster` (i.e. **any rail path**, through any intermediate stations).
- Link state lives on `PlayerImpl._railroadLinks` (factoryId -> partner/unitId;
  both endpoints share one entry pair) and is captured by
  `PlayerCheckpoint.railroadLinks` (optional field for old blobs). The
  execution only tracks `prevConnected` (checkpointed as `kind:
"railroad_link"`) to turn connectivity into events.
- Semantics (per the feature request): a link is created on the transition into
  "connected" and then persists even if the rail is torn down and rebuilt (the
  same unit is reused, because the pair is not _newly_ connected on rebuild).
  It is dropped when either factory dies, or when one of the two factories
  connects to a different factory (newest connection wins). Manual deletes
  stick until the pair actually reconnects.
- Delete: client `SendDeleteRailroadIntentEvent` -> `delete_railroad { unitId }`
  intent -> `DeleteRailroadExecution`, which cuts the station-path rail between
  the two factories and removes the link/unit.
- Tests: `tests/core/executions/RailroadLinkExecution.test.ts` (create,
  no-link when disconnected, persist across teardown/rebuild, replace on
  reconnect, drop on factory death, delete cuts the rail).

Browser-verified end to end (headless Chrome, throwaway `e2e` driver reusing
`e2e/driver.mjs` + `.claude/skills/run-openfront/game.mjs`; deleted afterwards):
built two factories for one player, opened the radial info menu on own
territory, and confirmed the panel showed `Factory Rail Links | 1 |
<ax>,<ay> ↔ <bx>,<by>`; clicking the rail's ✕ (`aria-label="Delete rail
link"`) removed the link (`count 1 -> 0`) while both factories stayed standing.
The panel's own close button also renders "✕", so a test must match the rail
button by its `aria-label`, not by text.

## Railroad factory links survive checkpoints (targeted regression test)

`tests/core/executions/RailroadLinkCheckpoint.test.ts` closes the save gap left
by the `RailroadLinkExecution` feature: the original test only exercised live
behavior, never a capture/restore. The new test builds two rail-connected
factories for one player, runs `RailroadLinkExecution`, captures a checkpoint and
restores it into a fresh game, then asserts the player link table, the
`UnitType.Railroad` unit and its `targetUnit` all survive, and that a 30-tick
suffix replays to identical hashes.

Determination for the latest 5 commits (2026-10-08): only `75a0c64a9` (the
Railroad feature) touches save state — `PlayerCheckpoint.railroadLinks`, the
`railroad_link` execution checkpoint kind, and a new persistent unit type. The
other four are docs and client-only input/HUD changes with no checkpoint or wire
impact (`6bb4049ce`, `fc09efa75`) or pure documentation (`aa09b0fb8`,
`911865cdb`). The exhaustive `EndgameSaveResume` soak documented above is **not
needed** for these commits: the new state is additive and backward compatible
(optional player field, `CHECKPOINT_VERSION` left at 5, so old blobs restore it
empty), and the targeted round-trip test above proves the new state resumes
deterministically at a fraction of the cost — no save regression for games saved
after the commit.

## Railroad Center replaces the factory rail-link feature

The informational `UnitType.Railroad` link (and `RailroadLinkExecution`,
`DeleteRailroadExecution`, the `delete_railroad` intent, `PlayerCheckpoint.
railroadLinks`, and the `PlayerPanel` list) is gone. In its place is a buildable
`UnitType.RailroadCenter` structure that boosts train speed.

- Boost is applied per train **journey** based on the two endpoint stations:
  `TrainExecution.computeSpeed()` boosts when `source.unit.owner() ===
destination.unit.owner()`, by `Config.railroadCenterSpeedMultiplier(N)` where
  `N = Σ 2^(level-1)` over that owner's active Railroad Centers. Curve
  `min(2, 1 + 0.375*ln(1+N))` (1 center ≈ 1.26x, 10 ≈ 1.90x, cap 2 at ~14).
  This is endpoint-based, **not** per-segment (see `HANDOFF.md` §4).
- Train speed may now be fractional. `TrainExecution` keeps `currentTile` whole
  via `speedAccumulator` (scaled by `TRAIN_SPEED_SCALE = 100`, exported from
  `MotionPlans.ts`); `packMotionPlans` stores `round(speed*100)` and unpack
  divides it back, and `GameView.advanceTrainMotionPlannedUnits` replays the same
  integer accumulator. Base speed is still 2, so unboosted trains are unchanged
  (accumulator stays 0).
- `TrainExecutionCheckpoint.speedAccumulator` is **optional**: old blobs restore
  it as 0 and `CHECKPOINT_VERSION` stays **5**. `tests/core/executions/
RailroadCenter.test.ts` covers the curve, boost, cross-nation no-boost,
  level-2 ≡ two level-1, and a checkpoint round-trip.
- Stats: `otherUnits` / `unitTypeToOtherUnit` gained `railc`;
  `PlayerStatsTable` now lists 8 buildings (its test was updated from 7 to 8).
- Rendering: `resources/atlases/icon-atlas.png` is now 512×64 (8 columns, col 7
  = Railroad Center); `structure.frag.glsl` has the matching index-7 branch.

## Pre-existing full-suite failures observed on the clean tip

Diffing a full `npx vitest run` against an unmodified `HEAD` worktree showed the
only new failure from this work was `tests/client/PlayerStatsTable.test.ts`
(now fixed). Everything else was already failing on the clean tip, including two
not called out before:

- `tests/EnJsonSorted.test.ts` — **resolved in the v34/tutorial/maps session**:
  `"unit_display"` now precedes `"unit_type"`, and the
  `build_aac_carrier*` / `build_missile_carrier*` / `build_units_caps_lock_hint`
  keys are in alphabetical order. The test passes again.
- `tests/TranslationSystem.test.ts` — four unused keys
  (`error_modal.turnstile_error`, `events_display.attack_cancelled_retreat`,
  `main.clans`, `main.inventory`). `main.leaderboard` is now used by the home
  Leaderboard button.

## Node `Buffer` map terrain was lost through the plain checkpoint codec

Found by the new `tests/core/RailroadCenterSaveResume.test.ts` (the first
Railroad-Center test that round-trips a checkpoint through the REAL wire codec
instead of restoring an in-memory `GameCheckpoint`).

`tests/util/Setup.ts` passes `fs.readFileSync(...)` (a Node `Buffer`) straight
to `genTerrainFromBin`, and `GameMapImpl` stores it as `this.terrain`. A `Buffer`
is a `Uint8Array`, so the codec's `replacer` intends to tag it with `$u8` — but
`JSON.stringify` invokes `Buffer.prototype.toJSON()` BEFORE the replacer, so the
replacer saw `{ type: "Buffer", data: number[] }` and the plain tagged-JSON path
encoded that object verbatim. On decode it stayed a plain object, so
`importMapState` threw `map state buffer size mismatch: terrain undefined/...`
(`state.terrain.length` was `undefined`). The gzip/binary path was unaffected:
`buildBinaryParts` moves the terrain into the raw-byte section via
`value instanceof Uint8Array`, before any JSON.

Fixes:

- `CheckpointCodec.replacer` re-tags the `{ type: "Buffer", data: [...] }` shape
  as `$u8` base64, so any Node `Buffer` in a checkpoint survives the plain path.
- `GameMapImpl.exportMapState` returns `new Uint8Array(this.terrain)` (a plain
  copy) instead of `this.terrain.slice()` (which returns a `Buffer`). This is the
  real map boundary and also avoids building a huge intermediate `data` array.

Regression test: `CheckpointCodec` "round-trips a Node Buffer terrain".

## Exhaustive Railroad Center save/resume test

`tests/core/RailroadCenterSaveResume.test.ts` drives a long, multi-segment
boosted train journey (stations 0/60/120, level-1 + level-2 centers), captures a
checkpoint at 9 ticks spanning both segments, sends each through
`encodeCheckpointWire`/`decodeCheckpointWire`, restores into a fresh game and
compares the per-tick `GameImpl.hash()` for the whole suffix. It also appends a
center and spawns a second (faster) train after some checkpoints, so earlier
checkpoints must replay the spawn and later ones carry it in restored state. It
asserts `speed`/`speedAccumulator` survive the wire exactly, that at least one
mid-step accumulator is non-zero, and (separately) that a fractional motion-plan
speed round-trips through `packMotionPlans`/`unpackMotionPlans`.

## Railroad Center: level cap 5 + spawn-throughput buff (rebalance)

Two changes to the buildable `UnitType.RailroadCenter`:

- **Aggregate level cap 5 (per player).** A player may hold at most 5 summed
  Railroad Center levels across all their centers (`Config.railroadCenterMaxTotalLevels()`
  = `RAILROAD_CENTER_MAX_TOTAL_LEVELS`). Enforced in `PlayerImpl.isUnitValidToUpgrade`
  (blocks any upgrade once `unitsOwned(RailroadCenter) >= 5`) and in the
  `UnitType.RailroadCenter` case of `canSpawnUnitType` (blocks building a new
  center at the cap). `ConstructionExecution` already gates on `player.canBuild`,
  so the intent path is covered; the client `buildableUnits` ghost reads the same
  check. So 5 level-1 centers are allowed but a 6th (or any upgrade) is refused.
- **Flat cost.** Every Railroad Center level now costs a flat `2_000_000` gold
  (`RAILROAD_CENTER_COST`), replacing the `min(1M, 2^n*125k)` curve — the cost
  function ignores `numUnits`, so build and each upgrade are 2M.
- **Spawn throughput +10%/level.** `Config.railroadCenterSpawnMultiplier(total)`
  = `1 + 0.1 * total` (`RAILROAD_CENTER_SPAWN_BONUS_PER_LEVEL`), where `total`
  is the summed active Railroad Center levels owned by the station's player.
  `TrainStationExecution.shouldSpawnTrain` divides the base `trainSpawnRate` odds
  by this multiplier, so each center level raises the per-tick spawn chance by
  ~1.10x. A maxed center is +50%. This is the lever that actually moves train
  gold, since income = spawn rate × gold/stop (the speed buff does not).

- **Captured centers are trimmed to the cap.** Capturing an enemy Railroad
  Center bypasses the build/upgrade checks, so `PlayerImpl.captureUnit()` calls
  `enforceRailroadCenterCap()`. Excess levels are removed from the newly
  captured center first: if its level exceeds the excess it is downgraded
  (`decreaseLevel`), otherwise the whole unit is deleted. Previously a player
  at 5 levels could capture another level-5 center and hold 10 levels.
- **Cap UI.** The Railroad Center card in the build menu and its hotbar icon
  show a `current/5` badge at the bottom of the icon, and the hotbar icon fades
  (`opacity-40`) once the player reaches the cap, so it cannot be selected for
  a new build (the build menu already disables the card via `canBuild`).

Note: the boost is owner-wide (like the speed boost is route/owner-based) and
computed live from unit state, so it needs no new checkpoint field. It changes
the PRNG stream for factory stations, which is deterministic.

Tests: `tests/core/executions/RailroadCenter.test.ts` (multiplier curve, the
aggregate cap — 5 level-1 centers accepted, a 6th and any upgrade refused at the
cap — the flat 2M cost, and the spawn-odds scaling observed through
`shouldSpawnTrain`). This session also halved the train spawn cooldown (10→5),
raised the destination level-weight coefficient (0.25→0.30) and the self/team
train gold (25k→30k) — see those commits.

## v34 targeted backports

The full upstream `v34` merge was tested and aborted: 32 conflicted files,
including 10 hunks in `GameServer.ts`, 6 in `Schemas.ts`, and two generated
attack snapshots. Most conflicts were the fork's intentional removal of
Steam/store/ads/public-lobby paths, so the branch is not mergeable wholesale.

Three compatible v34 changes were backported instead:

- **Team win threshold:** both FFA and team games now use 80%
  (`PERCENT_TILES_OWNED_TO_WIN`). `WinCheckExecution.hasWon()` also treats a
  `null` max timer as “no timer”, fixing lobbies that declared a winner as soon
  as the timer was disabled. Nation MIRV victory-denial uses one whole-percent
  ladder for both modes.
- **Spawn phase:** non-random multiplayer spawns now last 200 ticks (20s)
  instead of 300 (30s). Random spawn stays at 150 ticks; singleplayer is
  unchanged.
- **Empty attacks:** `AttackExecution.init` retreats immediately when
  `toConquer` is empty. This closes the exploit where repeated attacks at
  non-bordered targets kept troop regen at its peak and refunded past
  `maxTroops`.

## In-game tutorial (v34)

Ported the old-layout v34 tutorial panel (`73c82be62`): `Tutorial.ts`,
`TutorialPanel.ts`, play-page card, Help Modal entry point, `Main` event
wiring, HUD highlights, spawn-ring/marked-player rendering, tutorial CSS, and
`UserSettings.tutorialDismissed()`. The tutorial starts only when
`tutorialDismissed()` is false and the game is not resumed from a save.

## Upstream main maps

Added the 17 maps present in upstream `main` but missing from the fork:
`babelmandebstrait`, `benelux`, `brainrot`, `canaryislands`, `capecod`,
`capeofgoodhope`, `centralamerica`, `channelislands`, `gulfofmexico`,
`hornofafrica`, `madagascar`, `newzealand`, `ommatrypta`, `pulicatlake`,
`qingchina`, `riodejaneiro`, `vancouverisland`.

Implementation notes:

- Runtime assets copied to `resources/maps/<map>/`; source assets copied to
  `map-generator/assets/maps/<map>/`.
- 43 missing nation flags copied into `resources/flags/`.
- `Maps.gen.ts` entries use `multiplayerFrequency: 5`, per-mode frequencies
  `-1`, no featured rank. `en.json` map names added.
- `brainrot` and `ommatrypta` layer WebP files are supported by a new
  `.png` → `.webp` fallback in both `BinaryLoaderGameMapLoader` and
  `FetchGameMapLoader`. PNG copies are also shipped so the existing layer tests
  pass.
- Fork custom maps `eightislands`, `sixislands`, and `fourislands` had stale
  manifests; they were resynced with their `info.json`, which lets
  `tests/MapConsistency.test.ts` pass.
- `resources/lang/en.json` was sorted so `tests/EnJsonSorted.test.ts` passes.

## Verification for this session

- `npx tsc --noEmit` clean.
- `npm run lint` clean.
- Tutorial/map tests: 61 passed
  (`Tutorial`, `MapConsistency`, `MapManifestFlags`, `MapLayers`,
  `EnJsonSorted`).
- `tests/core`: 519 passed, 1 known pre-existing failure
  (`SAMLauncherExecution` dynamic range).
- `node e2e/run.mjs --map Benelux --bots 10` completed SMOKE OK; the new map
  loaded and territory grew.
- `UserSettings.test.ts` still fails only because this Node setup lacks a
  `localStorage` implementation (documented environment-only failure).

## Home-menu Leaderboard button

The home menu now has a **Leaderboard** button beside Create Lobby / Join Lobby /
Load, linking to the single ranked ladder added in the previous session. It is
the fourth card in the same action row:

- Desktop (`grid-cols-3` to `grid-cols-4`) shows all four on one line.
- Mobile was one row of three (`grid-cols-3 h-14`); it is now a 2x2 grid
  (`grid-cols-2 auto-rows-[3.5rem]`) so the longer "Leaderboard" label fits
  instead of overflowing a quarter-width button.
- Text uses the existing `main.leaderboard` translation key, so `en.json` is
  unchanged (and stays sorted).
- `GameModeSelector.openLeaderboard()` calls
  `leaderboard-modal.open({ tab: "players" })`, which opens the modal through
  `BaseModal`/`modalRouter` (URL becomes `#modal=leaderboard&tab=players`) and
  selects the "Ranked" tab. It is not gated by the desktop update check because
  it is not a multiplayer entry point, but it is disabled while the username
  input is invalid, like the other cards in the row.

Tests: `tests/GameModeSelectorGatingWiring.test.ts` stubs `leaderboard-modal`,
asserts the button opens it with `{ tab: "players" }`, and asserts it still
opens while a desktop update is downloading (the multiplayer cards do not).
`npx vitest run` on the three `GameModeSelector*` files passes, and
`npx tsc --noEmit`, `npm run lint`, and Prettier are clean.

## Ranked ladder shows only Rank / Player / ELO / Games

Wins and losses are no longer tracked on the ranked ladder, and the win-rate
column is gone. The player tab now has exactly four columns: **Rank**,
**Player**, **ELO**, **Games** (the sticky "Your Ranking" footer matches).

- `RankedRatings.ts`: `PlayerRating`/`PlayerRatingSchema`/`defaultRating` drop
  `wins`/`losses`; `applyMatch` only increments `games`; the leaderboard rows
  no longer emit wins/losses.
- `ApiSchemas.ts`: `RankedLeaderboardEntrySchema` drops `wins`/`losses`, and
  the client-facing `PlayerLeaderboardEntrySchema` drops `wins`/`losses`/
  `winRate`.
- `LeaderboardPlayerList.ts`: `toPlayerEntry` maps only rank, player, ELO and
  games; the win-rate cells and the fifth `col`/header are removed.
  `peakElo` is still tracked and returned but is not displayed.
- Old `ranked-ratings.json` files still load: Zod strips the now-unknown
  `wins`/`losses` keys, and the file schema version stays 1. Clan/tribe
  leaderboards and player profile stats keep their own win/loss data.

Tests updated: `tests/server/RankedRatings.test.ts` (games counted, no
win/loss fields), `tests/ApiSchemas.test.ts`,
`tests/client/ApiPlayerLeaderboard.test.ts`, and
`tests/client/LeaderboardModal.test.ts`. The affected suites pass, with
`npx tsc --noEmit`, `npm run lint`, and Prettier clean.

## Ranked ladder shows only the top 5

`LeaderboardPlayerList` caps the ranked player tab at `TOP_PLAYER_LIMIT = 5`
entries. The first page is sliced to 5 and `hasMore` becomes false once the
cap is reached, so no further pages are requested and the table cannot grow
past five rows.

- A signed-in player outside the top 5 is no longer tracked as
  `currentUserEntry`, so the pinned "Your Ranking" footer does not appear.
- `tests/client/LeaderboardModal.test.ts`'s paging tests were replaced by a
  "Top-player limit" block: top-five cap, no page-2 request, no pinned row for
  a rank-20 user, and the retry state when the first page fails. The obsolete
  "pages the ladder until a short page" case was removed.

## Defense-post-aware attack prioritization

Attacks now prefer less-defended frontier tiles. Undefended tiles are conquered
before defended tiles, and among defended tiles lower defense-post levels are
conquered before higher ones. Terrain/adjacency/random/tick priority is
unchanged inside the same tier; the defense bonus formula itself is untouched.

- **Tier definition.** For a frontier tile, the tier is the highest level among
  the target player's active, not-under-construction `DefensePost` units within
  `Config.defensePostRange()` (30 tiles) — the same `highestLevelNearby()`
  coverage test `attackLogic` uses. `0` means undefended; a non-player target
  (terra nullius) has no tiers.
- **Heap.** `FlatBinaryHeap` stores a parallel `Uint16Array` tier and orders by
  `(tier ascending, priority ascending)`. `enqueue(tile, priority, tier = 0)`
  keeps the old priority-only behavior for callers/tiers of 0. `retier()` rewrites
  every slot's tier and runs a linear bottom-up heapify (`O(H)`), preserving each
  entry's tile and priority.
- **Initial sampling.** `AttackExecution.addNeighbors()` computes the tier via
  the new `defenseLevelAt()` and passes it to `enqueue()`, covering both the
  initial frontier and every newly exposed neighbor.
- **Dynamic re-sampling.** At the start of each attack tick, `refreshDefenseTiers()`
  clears the per-tick `Map<TileRef, number>` cache and compares a deterministic
  signature of the defender's posts (id-sorted
  `id:level:underConstruction:active`). On any change it calls
  `toConquer.retier(...)` before the conquest loop. This reacts to posts being
  built, completing construction, upgraded (upgrade start and finish), destroyed
  or captured. A coverage change made after the attack runs in a tick is picked
  up on the next attack tick.
- **Fast paths.** Bots/players with no posts short-circuit through
  `targetPlayer.unitCount(UnitType.DefensePost) === 0` (memoised), and
  `defenseLevelAt()` reuses one cached query per tile per tick, so
  `attackLogicInput()` and the ordering metric always agree.
- **Checkpoints.** `FlatBinaryHeap.snapshot()` stores non-zero tiers sparsely as
  `[heapSlot, tier]` pairs (omitted entirely when all entries are undefended);
  `restore()` defaults missing tiers to 0. Slot layout is preserved, so the
  dequeue order is identical after a restore. `CHECKPOINT_VERSION` stays 5.
  `restoreCheckpoint()` seeds the signature from the restored posts; only when
  the blob predates tier capture (no `tiers`) but posts exist is it left null, so
  the first post-restore tick re-tiers from live coverage.

Tests: `tests/FlatBinaryHeap.test.ts` (tier ordering, within-tier priority,
`retier`, sparse snapshot/restore, missing tiers) and the new
`tests/AttackDefensePostPriority.test.ts` (undefended before defended, level 1
before level 5, mid-attack build, destroy, under-construction ignored until
completion, upgrade start/finish, checkpoint snapshot + 20-tick suffix hash
equality, no-post fallback). `tests/AttackScenarios.test.ts` only changed for
"plains defender with one defense post at the border" (defended tiles now go
last): 26 ticks / 125 tiles instead of 19 / 57 for the same 10k attack. Every
non-post scenario snapshot is unchanged.

Measured on this machine (plains, 5k-tile defender half, 200 level-1 posts
across it, 193-entry frontier, 1M-troop attack):

- 200 ticks, static posts: 46 ms (~0.23 ms/tick).
- 200 ticks with one post's construction flag toggled every tick (a forced
  full re-tier every tick, worst case): 127 ms (~0.63 ms/tick, ~2.8x).
- `encodeCheckpointWire()` size: 188,583 chars with tiers vs 187,207 without
  (+1,376 chars, ~0.7%).
- `tests/AttackScenarios.test.ts`: 6.79 s before the change vs 6.95 s after
  (~2%); most scenarios have no defense posts and hit the fast path.

Verification: `npx tsc --noEmit` and `npm run lint` clean; `tests/core` 452
passed with only the documented pre-existing `SAMLauncherExecution` dynamic-range
failure; `Attack`, `AttackLogicGolden`, `AttackScenarios` and
`tests/core/Checkpoint.test.ts` pass.

## Core tick performance pass: allocation-free attack logic and hot loops

Benchmark harness: the existing `tests/perf/fullgame/FullGamePerf.ts` remains
the flame-graph/heap-profile tool (`npm run perf:game -- --map World
--ticks 900 --bots 300`). A new `tests/perf/fullgame/QuickBench.ts`
(`npm run perf:quick`) wraps it with profiling off, repeated runs, medians and
a saved baseline:

```powershell
npm run perf:quick -- --runs 5 --save tests/perf/output/baseline.json
# make/perf the change
npm run perf:quick -- --runs 5 --compare tests/perf/output/baseline.json
```

`--compare` prints mean/p50/p95/p99/total deltas and exits 1 if the final state
hash changed, so an optimization cannot silently alter the simulation.
Scenario used below: World, 900 ticks, 300 bots, seed `perf-default`; final hash
`966774948` at tick 1100.

### Measured result (5 runs each, medians)

| metric       | before | after |  delta |
| ------------ | -----: | ----: | -----: |
| mean ms/tick |   6.00 |  5.70 |  -5.0% |
| p50 ms/tick  |   5.70 |  5.37 |  -5.8% |
| p95 ms/tick  |  11.10 | 10.10 |  -9.0% |
| p99 ms/tick  |  15.80 | 14.00 | -11.4% |
| total sim ms |   5396 |  5132 |  -4.9% |

Run-to-run noise is about ±5% on this machine (the best run improved from 5.78
to 5.08 ms/tick, -12%; earlier paired samples averaged ~9%), so quote p95/p99 as
the more stable signal. Under the sampling profiler (which inflates both runs
equally) mean tick time went 8.70 → 6.64 ms (-24%). Sampled game-phase
allocations went **1823 MB → 956 MB (-48%)**; this is the robust number.

### What changed

- `AttackExecution`: reusable `AttackLogicInput`/attacker/defender/result
  scratch objects (the old code allocated all four per conquered tile — a top-3
  allocation site); `Config.attackLogic` takes an optional `out` result and its
  `terrainAttackBase` object is inlined; the defender's type/traitor/
  disconnected flags and the fallout ratio are cached per tick; `defenseLevelAt`
  returns 0 before touching the cache when the defender has no defense posts
  (the old code cached a 0 for every queried tile, filling the map on undefended
  attacks); `handleDeadDefender` returns once the target has 0 tiles instead of
  calling `conquerPlayer` again for every remaining conquered tile.
- `PlayerImpl`: `pruneTransient`'s four per-tick extractor closures are hoisted
  to module constants; `getEmbargoes()` returns a frozen shared empty list;
  `maxTroops` loops over cities instead of `filter/map/reduce`; `toUpdate`
  reuses the previous `AttackUpdate` arrays when attack membership is unchanged
  (troop deltas are packed before the in-place troop refresh) and filters
  incoming attacks into a reusable scratch buffer; dead players whose state is
  final return `null` without rebuilding a full snapshot every tick;
  `computeNearby`/`shoreReachableNeighbors` use `forEach` instead of the
  `TileSet.values()` generator.
- `PlayerExecution.calculateClusters`: the 8-neighbour flood fill is inlined
  (same dx-major visit order as `forEachNeighborWithDiag`) instead of using two
  callbacks per tile; this was ~14% of inclusive tick time.
- `GameRunner`: name placement is cached per player by `tileChangeVersion`, so
  the 30-tick rebuild only recomputes players whose territory changed (forced on
  spawn end and resume full-view sync).
- `NameBoxCalculator.placeName`: uses a flat `Uint8Array` grid and an inlined
  histogram allocation path; `tests/client/NameBoxCalculatorFlat.test.ts`
  compares it against the original 2D implementation over all 1–3 cell grids
  and 200 pseudo-random larger grids.

No schema, wire, checkpoint, or `CHECKPOINT_VERSION` changes. The final hash is
identical before/after.

### Verification

- `npx tsc --noEmit` clean; `npm run lint` clean.
- `tests/core`: 452 passed, only the documented pre-existing
  `SAMLauncherExecution` dynamic-range failure.
- Targeted suites pass: `AttackDefensePostPriority`, `AttackLogicGolden`,
  `core/executions/PlayerExecution`, `PlayerUpdateDiff`, `PackedPlayerUpdates`,
  `PlayerImpl`, `GameRunner`, `PlayerTransientPrune`, `Cluster`.
- Full `npm test` is still dominated by the documented environment-only
  `localStorage` failures (453 failing tests, mostly client components).
  Additionally, `tests/DeleteUnitExecution.test.ts` fails **on the clean tip
  too** (verified by stashing this work) with `Error: Player has no tiles` in
  `beforeEach`; it is a spawn/map setup issue in this environment, unrelated to
  these changes.

## Entity-heavy stress: trains, stations, defense posts and defense tiers

`tests/perf/entity/EntityStressPerf.ts` (`npm run perf:entities`) is a dedicated
late-game-style stress harness. On `big_plains` (200x200) it:

- splits the map between an attacker (left 25%) and defender (rest),
- builds 70 Factories + 70 Cities (a connected rail network) and 5 Railroad
  Centers; factories create 209 train stations in one cluster,
- builds 320 defense posts (levels 1-5) across the front and defender territory,
- keeps ~120 live trains alive (5 cars each = 7 units per train),
- runs a sustained attack on the defended frontier. By default one defense
  post's `underConstruction` flag is flipped every tick, so the attack's
  defense-post signature changes every tick and `retier()` runs on the whole
  conquest heap every attack tick (worst case),
- optionally reports execution/CPU/GC profiles and checkpoint capture, plain
  JSON encode, and wire (gzip) encode time/size.

Flags: `--ticks --posts --buildings --trains --train-min-dist --map --seed
--toggle-post/--no-toggle-post --attack-troops --profile --cpu-profile --gc
--no-checkpoint`.

### Measured result (3 runs each, medians)

Scenario: 600 ticks, 320 posts, 160 buildings, 120 target trains. Final state:
1,816 units, 209 stations, 117 live trains, 1,685 trains spawned over the run,
320 defense posts, 1 active attack. Checkpoint hash `1655327024` is identical
before/after.

| metric       | before | after |      delta |
| ------------ | -----: | ----: | ---------: |
| mean ms/tick |   1.08 |  0.63 | **-41.7%** |
| p95 ms/tick  |   2.06 |  1.07 | **-48.1%** |
| p99 ms/tick  |   3.30 |  2.15 | **-34.8%** |

Checkpoint (autosave) is unchanged, as expected:

| metric       |                before |                 after |
| ------------ | --------------------: | --------------------: |
| capture      |           ~4.1-4.6 ms |           ~4.1-4.7 ms |
| plain encode | 18.8-21.6 ms, 1.89 MB | 18.6-21.3 ms, 1.89 MB |
| wire encode  | 48.7-54.7 ms, 0.14 MB | 51.1-61.1 ms, 0.14 MB |

So the tick path got much faster in an entity-heavy game while save size and
encode cost did not move (the checkpoint format is untouched).

### What changed for this scenario

- `UnitImpl.delete()`/`captureUnit()` replaced `owner._units =
owner._units.filter(...)` with `indexOf` + `splice`. The old form copied the
  owner's entire unit array for every deleted/captured unit; a 600-tick run
  deletes ~6,000 train units, so this was ~18% of profiled self time.
  `PlayerExecution`'s two loops that delete/capture while iterating
  `player.units()` now use index loops that do not advance after an in-place
  removal (the live array shrinks under them). Order is preserved, so hashes
  are unchanged.
- `UnitGrid.highestLevelNearby` hoists the query point and inlines the
  active/construction/owner/distance checks instead of calling
  `unitIsInRange`/`squaredDistanceFromTile` per candidate unit. This is the
  defense-tier lookup used by every `retier()` and every conquered tile.

### Verification

- `npx tsc --noEmit` and `npm run lint` clean.
- `tests/core` + `tests/Attack.test.ts` + `PlayerUpdateDiff` +
  `PackedPlayerUpdates`: 498 passed, only the documented pre-existing
  `SAMLauncherExecution` dynamic-range failure.
- Full-game hash unchanged: `npm run perf:quick -- --runs 1` still ends at
  `966774948`.
- Entity-stress checkpoint hash unchanged (`1655327024`) before/after.
- `node e2e/run.mjs --map Benelux --bots 10` -> SMOKE OK.

## Bulk warship build: double-tap the warship hotkey for x5

Warship (`CapsLock+Digit1` by default; Caps Lock is a toggle, not part of the
double-tap) now uses the same "press the active build hotkey again" gesture
that already arms a 5-level structure upgrade. Double-tapping the warship
hotkey sets `uiState.upgradeMultiplier = 5`, and the next water click sends one
`build_unit` intent with `amount: 5`. The ghost also shows the usual `x5` badge
and the 5-ship cumulative price. The same applies to `MissileShip` and
`MissileDefenseShip` (the other two `WarShips`) so the three ship hotkeys behave
consistently; structures and nukes keep their existing behavior.

Wire/sim: no schema change — `BuildUnitIntent.amount` already existed (nukes).
`ConstructionExecution` now loops the `Warship`/`MissileShip`/
`MissileDefenseShip` cases `amount` times, each spawning the existing execution,
which validates and charges separately. So the player pays the escalating
per-ship price (`250k / 500k / 750k-capped`) for exactly the ships they can
afford; with gold for only one ship, one spawns.

Client:

- `BuildPreviewController`: exported `supportsBulkAmount(bu)` and
  `bulkBuildAmount(unitType, upgradeMultiplier)`; ships now report/consume the
  armed multiplier. `createStructure` sends the amount for ships (and still for
  AtomBomb). Selecting a different hotbar buildable resets the multiplier to 1
  (`UnitDisplay` click) so a stale x5 cannot leak into another type. Do **not**
  reset it in `createGhostStructure`: a double-tap faster than one controller
  tick would be wiped out.
- `BuildableUnit.buildCosts?: Gold[]` (core): cumulative 1..50 ship prices,
  computed only when `buildNew && WarShips.has(type)`. `bulkCost` /
  `maxBulkAmount` prefer `upgradeCosts`, then `buildCosts`, then flat `cost *
amount`, so the x5 label shows the true 3,000,000 for five fresh warships.

Tests:

- `tests/economy/ConstructionBulkShips.test.ts`: 5 ships from amount 5, correct
  patrol tile, escalating charge, single spawn with no amount, affordability
  cap, and `buildableUnits` cumulative `buildCosts`
  (`[250k, 750k, 1.5M, 2.25M, 3M]`).
- `tests/InputHandler.test.ts`: double-tapping the warship hotkey arms 5.
- `tests/client/controllers/BuildPreviewController.test.ts`: ships carry the
  amount, structures/MIRV do not, `supportsBulkAmount` matrix.

Verification (this session):

- `npx tsc --noEmit`, Oxlint, ESLint, Prettier clean.
- `tests/core` + `tests/economy`: 461 passed, only the documented pre-existing
  `SAMLauncherExecution` dynamic-range failure.
- `tests/nukes` + `tests/client/controllers`: 63 passed.
- `tests/InputHandler.test.ts` with a working `localStorage`
  (`NODE_OPTIONS=--localstorage-file=...`): 68/69 pass. The one failure,
  `Shift keydown discards active ghostStructure`, **also fails on the clean
  HEAD** (verified by stashing) — the keydown handler deliberately no longer
  clears the ghost (see the comment at `InputHandler`'s shift keydown), so the
  test is stale. It is not caused by these changes.
- Browser-verified in headless Chrome (throwaway `e2e` driver reusing
  `e2e/driver.mjs` + `.claude/skills/run-openfront/game.mjs`, deleted after):
  spawned on a coastal Benelux tile, built a port (hotkey 3 + click), fired two
  synthetic `keyup` events for `CapsLock+Digit1` with `getModifierState`
  overridden to true. Result: `ghost=Warship`, `multiplier=5`; one click on the
  adjacent water spawned exactly 5 warships and cleared the ghost. Note the
  build keybinds run on **keyup**, not keydown. Artifact:
  `e2e/artifacts/warship-x5.png`.

## Pre-existing failure: NewsBox expects a tournament entry

`tests/client/components/NewsBox.test.ts` > "contains a tournament entry" fails
on clean HEAD (verified by stashing): `resources/news.json` only contains
`announcement` items, so `items.some((i) => i.type === "tournament")` is false.
Either add a tournament item when one is scheduled or drop that assertion. The
other `NewsBox` tests are content-agnostic and pass.

## Release v2.00.03 (ranked news)

`resources/version.txt` is now `2.00.03`, `resources/changelog.md` has the
matching entry, and `resources/news.json` gained a first item
`id: "ranked-live"` announcing that ranked works. Remember the release
convention: bump only `resources/version.txt` (not `static/version.txt`, which
the v2.00.02 release also left untouched), and the deployed build overwrites it
from the deploy version tag anyway.

## Bulk-spawned ships fan out instead of stacking on one tile

Five ships from the x5 gesture used to spawn on the port tile and then follow
identical patrol paths forever: every `WarshipExecution` /
`MissileShipExecution` / `MissileDefenseShipExecution` was seeded with
`mg.ticks()`, so each picked the same random patrol target and moved in lockstep.

- `FleetFormation.findWaterTilesNear` / `bulkShipSpawnTile`: a bulk build spawns
  on the nearest distinct water tiles around the port, filtered to the click's
  water component (no ship lands on the far side of an isthmus).
- `FleetFormation.shipRandomSeed(tick, index)`: index 0 (and single builds,
  which pass no index) keep the historical `mg.ticks()` seed; indices 1..n are
  offset so their random patrol streams differ.
- `ConstructionExecution` passes `bulkSpawnIndex: count > 1 ? i : undefined` to
  all three ship executions. It is init-only and not checkpointed; the PRNG
  state and unit tiles were already part of the checkpoint.
- Tests: `tests/economy/ConstructionBulkShips.test.ts` (five distinct spawn
  tiles, all in the patrol water component; no lockstep after 10 ticks) and
  `tests/core/FleetFormation.test.ts` (`shipRandomSeed`).
- Verification: `npx tsc --noEmit`, `npm run lint` and Prettier clean;
  `tests/core` + `tests/economy` 465 passed with only the documented
  pre-existing SAM dynamic-range failure; `node e2e/run.mjs --map Benelux
--bots 10` -> SMOKE OK.

## Ranked match announcements on Discord

Every time a ranked match starts, the server posts one message to the community
Discord server whose invite is linked in the page footer
(`https://discord.gg/SJSyRbVA`, `src/client/components/Footer.ts`).

- **Trigger:** `GameServer.start()` when the game is ranked (`isRanked()`,
  i.e. the private lobby was listed), plus `startResumedGame()` for a resumed
  save that keeps its ranked status. `notifyRankedStart()` is guarded by
  `rankedStartNotified`, so each game announces at most once. Unranked lobbies,
  delisted-before-start lobbies and resumed games that lost ranked status stay
  silent.
- **Config:** `DISCORD_RANKED_WEBHOOK_URL` (unset = feature off, no request is
  made at all). `PUBLIC_SITE_URL` overrides the link origin; otherwise it is
  `https://[SUBDOMAIN.]DOMAIN`. Both are documented in `example.env`.
- **Message:** embed titled "Ranked match started" (`Norrasoff Ranked` as the
  webhook username) with map, mode, `players/maxPlayers`, host username, and a
  clickable link to `/w<N>/game/<id>`. `allowed_mentions: { parse: [] }` means
  the post can never ping anyone, even if a username looks like `@everyone`.
- **Robustness:** `postDiscordWebhook` uses a 5 s AbortController timeout,
  treats a non-2xx or network error as `false` + a `warn` log, and never
  throws. `GameServer` also wraps the injected dep in try/catch, so Discord
  being down cannot block or fail a game start.
- **Code:** `src/server/RankedLobbyNotifier.ts` (`buildRankedMatchStartedPayload`,
  `postDiscordWebhook`, `rankedGameUrl`, `notifyRankedMatchStarted`),
  `ServerEnv.discordRankedWebhookUrl()` / `ServerEnv.publicSiteUrl()`, and
  `GameServerDeps.rankedStarted` (default is the real notifier; tests inject a
  spy).
- **Tests:** `tests/server/RankedLobbyNotifier.test.ts` (payload, link
  derivation, no-mention guarantee, POST/timeout/non-2xx handling, no-op when
  unconfigured) and `tests/server/RankedStartNotification.test.ts` (ranked start
  once with details, unranked and delisted silent, failing notifier
  non-blocking, resumed ranked save). `npx tsc --noEmit` and `npm run lint`
  clean; `tests/server` 732 passed with only the three documented pre-existing
  failures (`GameServerWire`, `HostedLobbyListing`, `GameServerPhase`).
