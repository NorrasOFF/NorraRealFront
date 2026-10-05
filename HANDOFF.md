# Handoff — remove-railroad button + no train diminishing return

> Future sessions: this file holds the current handoff. Overwrite it rather than
> appending; keep only the latest handoff. Write one only when the session leaves
> open items or partially verified work.

Companion notes: `testnotes.md` (feature/bug detail + pre-existing failures).

## 1. Where things are

- Repo: `C:\Users\ai51940\OpenFrontIO`.
- Token: `H:\Documents\Hexfront-token.txt`. Authenticates as **`hexfront-dev`**.
- Push target: `origin` = `https://github.com/hexfront-dev/NorraRealFront-Remus-.git`,
  branch `main`. Other remotes: `norrasoff` = `NorrasOFF/NorraRealFront`,
  `upstream` = `openfrontio/OpenFrontIO`, `hexfront` = `hexfront-dev/OpenFrontIO`.
- Push command (do not print the token):
  ```powershell
  $tok = (Get-Content -Raw "H:\Documents\Hexfront-token.txt").Trim()
  $b64 = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("x-access-token:$tok"))
  git -C "C:\Users\ai51940\OpenFrontIO" -c http.extraheader="Authorization: Basic $b64" `
    push origin HEAD:main
  ```

## 2. What changed this session

Two features, both committed together on `main`:

1. **Trains have no diminishing return per stop.** `Config.trainGold` dropped
   its `citiesVisited` param and the `5_000`/stop `distPenalty`; every stop pays
   the full base (`25_000` self/team/other, `35_000` ally). Callers in
   `TrainStation.ts` and `NationStructureBehavior.ts` updated.
2. **Remove-railroad radial button.** Clicking a railroad on your own territory
   shows a red "Remove Railroad" slice (same delete style as Delete Unit) that
   destroys that single segment between its two stations.

New/edited pieces for (2):

- `src/core/Schemas.ts` — `DestroyRailroadIntentSchema` (`{type:"destroy_railroad",
tile}`), type `DestroyRailroadIntent`, added to the `Intent` union and appended
  at the **end** of `IntentSchema` (existing binary tags unchanged).
- `src/core/execution/DestroyRailroadExecution.ts` — new; ownership check
  (`mg.owner(tile) === player`), resolves the railroad via the network, prefers
  an interior tile at junctions, removes it. Instantaneous (`active=false` in
  `init`), no checkpoint (same as `DisableTrainStationExecution`).
- `src/core/execution/ExecutionManager.ts` — `case "destroy_railroad"`.
- `src/core/game/RailNetwork.ts` / `RailNetworkImpl.ts` — `railroadsAt(tile)`
  (walks stations, sorted by railroad id) and `removeRailroad(rail)` (delete edge
  - mark endpoint clusters dirty).
- `src/client/Transport.ts` — `SendDestroyRailroadIntentEvent` + handler.
- `src/client/hud/layers/PlayerActionHandler.ts` — `handleDestroyRailroad(tile)`.
- `src/client/hud/layers/RadialMenuElements.ts` — `Slot.Railroad`,
  `destroyRailroadElement`, included in `rootMenuElement` only when
  `game.hasRailroadAt(tile)`.
- `src/client/view/GameView.ts` — `hasRailroadAt(tile)` reads
  `railroadCache.railroadState`.
- `resources/lang/en.json` — `radial_menu.remove_railroad_title/_description`.

## 3. Verification

- `npx tsc --noEmit` — clean.
- `npx vitest run tests/core/executions/DestroyRailroadExecution.test.ts
tests/core/game/RailNetwork.test.ts tests/core/executions/TrainExecution.test.ts
tests/core/CheckpointRail.test.ts tests/zbin
tests/client/graphics/RadialMenuElements.test.ts tests/radialMenuElements.test.ts`
  — all pass.
- `npx prettier --check`, `npx oxlint`, `npx eslint` on changed files — clean.
- Browser e2e (headless Chrome, throwaway driver): built City + Factory with
  `instantBuild`/`infiniteGold`, let trains spawn, right-clicked a rail tile, saw
  the `path[data-id="railroad"]` slice, clicked it, and confirmed the rail was
  removed (`hasRailroadAt` `true -> false`, cache held 0 railroads). Artifacts:
  `e2e/artifacts/07-game-train.png`, `08-game-remove-railroad.png`.
- `tests/server/GameServerWire.test.ts` still fails only on the pre-existing
  `numTurns` golden mismatch documented in `testnotes.md` — unrelated.
- A full `npx vitest run` is expected to still show the documented
  `localStorage`/WebGL environment-only failures.

## 4. Save/resume review (commits of 2026-10-04/05)

Checked every core-touching commit from the last two days against the
checkpoint system (`CHECKPOINT_VERSION = 5`, `src/core/Checkpoint.ts`). No
structural/serialization break:

- `6cedd0249` (weighted train destinations) and `764866e9f` (flat train payout)
  add no persistent state; the destination weighting draws once per eligible
  station exactly as before (`PseudoRandom` sequence length unchanged) and uses
  deterministic `DetMath.log`.
- `911682e5c` (ships step every 1.5 ticks) stores fractional `fleetMoveRate` in
  `warshipState`, which is part of the unit checkpoint. The checkpoint codec is
  JSON+tags (`CheckpointCodec.ts`), not zbin, so `1.5` round-trips fine; the new
  `shipShouldMove` matches the old modulo for integer rates, so restored v5
  blobs with `fleetMoveRate: 2` behave identically.
- `49e1435ea` (retreats) and the defense-post client commits add no checkpointed
  state (defense-post work is client-only). `RetreatExecution` still captures
  `startTick`; only the constant changed.
- The remove-railroad change adds `railroadsAt`/`removeRailroad` (the latter
  marks endpoint clusters dirty, which the rail checkpoint already captures) and
  an instantaneous execution with no checkpoint, like `DisableTrainStationExecution`.

Empirical: `tests/core/Checkpoint*.test.ts`, `tests/LateGameSaveResume.test.ts`
and `tests/SaveManager.test.ts` all pass on the working tree (48 passed, 1
skipped).

**Soft risk (not a crash):** none of these commits bumped `CHECKPOINT_VERSION`,
so a save captured on an older build is still accepted and then simulated under
today's rules. In-flight retreats resolve at 10 ticks instead of 20, missile
ships move at 1.5, train destinations weight toward high-level stations, and
train payouts are flat. Cross-build fidelity was already impossible (zbin
requires all peers on one build; the deployed `GIT_COMMIT` is `"unknown"`);
within one build, save/resume is deterministic. If old saves must be rejected
explicitly rather than silently re-simulated, bump `CHECKPOINT_VERSION` to 6
(that forces a full-history fallback, which also re-simulates under new rules —
neither path restores the original run). Recommendation: leave as-is for this
fork unless cross-day save fidelity is a requirement.

## 5. Open items / next steps

- **Junction ambiguity.** If several segments share the clicked tile, the
  execution removes the lowest-id _interior_ segment (or the lowest-id segment if
  all are endpoints). There is no per-segment picker yet; if users expect to
  choose, the intent should carry a railroad id the client reads from
  `RailroadCache.getRailroads()`.
- **No cooldown / refund semantics.** Unlike Delete Unit (which has a cooldown
  and staged destruction) this removes instantly and costs nothing. Decide
  whether a cooldown is wanted.
- **Trains mid-segment** on a cut edge finish their current segment and then
  despawn when `nextStation()` finds no edge (no path). This is intentional but
  untested explicitly.
- The pre-existing suite failures listed in `testnotes.md` still stand.
