# Handoff — Railroad Center building replaces factory rail links; train speed boost

> Future sessions: this file holds the current handoff. Overwrite it rather than
> appending; keep only the latest handoff. Write one only when the session leaves
> open items or partially verified work.

Companion notes: `testnotes.md`.

## 1. Where things are

- Repo: `C:\Users\ai51940\OpenFrontIO`.
- Tokens (all authenticate as **`hexfront-dev`**):
  - `H:\Documents\Hexfront-token.txt` — write to the fork (`origin`).
  - `H:\Documents\Norrasoff-token.txt` — **read-only** (cannot push/PR NorrasOFF).
  - `H:\Documents\Fly.io-token.txt` — Fly deploy token (app `openfrontio`, org
    "Familjen Jacobsson"). `flyctl` at `C:\Users\ai51940\.fly\bin\flyctl.exe`;
    set `$env:FLY_API_TOKEN = (Get-Content -Raw ...).Trim()`.
- Remotes: `origin` = `hexfront-dev/NorraRealFront-Remus-`,
  `norrasoff` = `NorrasOFF/NorraRealFront`, `upstream` = `openfrontio/OpenFrontIO`,
  `hexfront` = `hexfront-dev/OpenFrontIO` (no write).
- This session's work sits on **`debug-pr14`** on top of `9cf071fb2` and was
  pushed to **`origin/main`** (force, because `origin/main` still held the PR #14
  revert `576389b13`; the revert is preserved on `origin/revert-pr-14`).

## 2. What changed this session (implemented + verified)

The informational `UnitType.Railroad` factory-link feature was **removed** and
replaced by a buildable **`UnitType.RailroadCenter`** structure that speeds up
trains.

- **Removed** the factory rail-link feature entirely: `UnitType.Railroad`,
  `RailroadLink`, `RailroadLinkExecution`, `DeleteRailroadExecution`,
  `Player.railroadLinks`/`setRailroadLink`/`removeRailroadLink`,
  `PlayerCheckpoint.railroadLinks`, the `delete_railroad` intent/schema, the
  `railroad_link` execution checkpoint kind, the client
  `SendDeleteRailroadIntentEvent`, and the `PlayerPanel` rail-link list. The
  unrelated `destroy_railroad` radial action (remove a rail segment) stays.
- **Added** `UnitType.RailroadCenter = "Railroad Center"`, registered in
  `Structures` so it is buildable/upgradable/visible like City/Factory. Cost and
  construction mirror City/Factory (`pow2(n) * 125_000`, 2 s, upgradable).
- **Speed boost** (`Config.railroadCenterSpeedMultiplier` /
  `railroadCenterBoostUnits`, `TrainExecution.computeSpeed`): a railroad whose
  two stops are owned by the same nation is boosted by that nation's centers.
  Curve is `min(2, 1 + 0.375 * ln(1 + N))` where `N` is the nation's effective
  center count (level L counts as `2^(L-1)`, so leveling a center equals adding
  a second one). 1 center ≈ 1.26x, 10 effective centers ≈ 1.90x, cap 2x at ~14.
- **Fractional train speed**: base speed is still 2, boosted trains get a
  fractional tiles/tick. The core carries the remainder in an integer
  accumulator (`TrainExecution.speedAccumulator`); the motion-plan wire scales
  speed by `TRAIN_SPEED_SCALE = 100` (`MotionPlans.ts`) and the client
  (`GameView.advanceTrainMotionPlannedUnits`) replays the identical integer
  accumulator, so rendered and authoritative positions stay in lockstep.
  `speedAccumulator` is captured in `TrainExecutionCheckpoint` (optional field,
  `CHECKPOINT_VERSION` stays 5, old blobs restore it as 0).
- **Client/UI**: build-menu entry + hotkey (`buildRailroadCenter`, default
  `Digit8`), `UnitDisplay` row, `HotbarIcons`, new
  `resources/images/RailroadCenterIconWhite.svg`, `UserSettingModal` keybind row,
  `GameConfigSettings`/`JoinLobbyModal` disable-units lists, `en.json` keys.
- **Rendering**: appended one 64px column to `resources/atlases/icon-atlas.png`
  (now 512×64 = 8 columns, col 7 = Railroad Center) and added the matching shape
  branch in `structure.frag.glsl`, `STRUCTURE_ORDER`, `STRUCTURE_TYPES`,
  `render-settings.json` (`structure.shapes` + `lightConfigs`) and
  `PointLightPass`.
- **Stats**: `otherUnits`/`unitTypeToOtherUnit` gained `railc`;
  `PlayerStatsTable` gained the building row/label; `UnitImpl` build/capture/
  destroy switches include the type.

## 3. Verification

- `npx tsc --noEmit` clean; `npm run lint` clean; prettier applied to touched
  files.
- New test `tests/core/executions/RailroadCenter.test.ts` (curve, boost,
  cross-nation no-boost, level-2 ≡ two level-1, checkpoint round-trip).
  `tests/client/PlayerStatsTable.test.ts` updated for the 8th building row.
- Full `npx vitest run` fail-set diffed against a clean `HEAD` worktree: the
  only delta was the PlayerStatsTable count, now fixed. All remaining failures
  are the documented environment-only ones (Node 26 missing `localStorage`,
  Howler/WebGL) plus the pre-existing `EnJsonSorted`/`TranslationSystem`
  failures (see `testnotes.md`).
- Browser-verified (headless Chrome via `e2e/run.mjs` helpers): smoke OK, and a
  throwaway driver built a Railroad Center in-game (`countMyUnits === 1`); the
  hotbar shows the new rail icon with its `8` hotkey.

## 4. Deliberate simplifications / open items

- **Boost is endpoint-based, not per-segment.** `computeSpeed` boosts the whole
  journey when the train's source and destination stops share an owner. The user
  asked for a boost on "railroads between 2 stops of that nation"; true
  per-segment would require re-recording the train motion plan at each station
  (the client resets its interpolation cursor on a `planId` bump, so car spacing
  would visibly reset). If per-segment is wanted, add a speed schedule to the
  train plan or re-record with an aligned path.
- **Nations do not build Railroad Centers** (`buildOrder` in
  `NationStructureBehavior` unchanged; `structureSpawnTileValue` would throw if
  added without a value fn). Human-only for now.
- **Optional polish not done**: `StatsColumns` leaderboard column,
  `PlayerInfoOverlay` count chip, `HelpModal` row, `SoundEffectController` build
  sound, `PlayerStatsSummary` metric.
- The `origin/main` force-push reverses the PR #14 revert; confirm that is the
  intended ship target. `debug-pr14` is the same tree if a branch is preferred.
- The pre-existing suite failures in `testnotes.md` still stand.

## 5. Perf note from the previous handoff is resolved

The old §3 performance concern was about `RailroadLinkExecution`'s per-tick
`stationManager.findStation` inner loop. That execution is deleted, so it no
longer applies.
