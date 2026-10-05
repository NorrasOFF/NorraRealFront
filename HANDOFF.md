# Handoff — defense-post drag upgrades existing posts (5× via double-tapping keybind 4)

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

Dragging a defense-post line now upgrades defense posts the line passes over,
instead of only failing to build on occupied tiles.

- `src/client/controllers/BuildPreviewController.ts` — new exported pure helper
  `planDefenseLineActions(tiles, postIdAt, upgradeAmount)` returns a
  `build`/`upgrade` action per sampled tile. `onDefenseLineComplete` builds a
  `tile → unitId` map from `myPlayer.units(UnitType.DefensePost)` (skipping
  under-construction posts) and emits one `BuildUnitIntentEvent` per empty tile
  and one `SendUpgradeStructureIntentEvent(unitId, DefensePost, amount)` per
  existing post. `amount = uiState.upgradeMultiplier || 1`.
- No `InputHandler` change net of the earlier session: a defense-post ghost does
  **not** override the Shift `boxSelectWarships` gesture. The 5× trigger is the
  pre-existing build-amount mechanism, not Shift.
- `tests/client/controllers/BuildPreviewController.test.ts` — tests for
  `planDefenseLineActions`.
- `testnotes.md` — "Defense-post drag upgrades existing posts (5× via
  double-tapping the keybind)".

How the 5× works: `InputHandler.setGhostStructure` sets
`uiState.upgradeMultiplier = 5` when the currently-active structure keybind is
pressed a **second** time (see InputHandler.ts:1277 and the existing test
"pressing the active build hotkey selects five upgrades"). So double-tapping
`4` (buildDefensePost) arms 5×; a single tap leaves 1; scrolling while the ghost
is active cycles 1/5/10/50. The drag reads that multiplier. Double-tap + a
single click also upgrades 5 levels via `createStructure`.

Why a single upgrade intent with `amount`, not N intents: `UpgradeStructureExecution`
runs its `amount` loop before calling `beginDefensePostUpgrade()`, so a bulk
amount stacks levels in one tick. Separate intents fail after the first because
the post is then under construction. (The legacy Shift-click 5× path still sends
5 separate intents and therefore only lands 1 level on a defense post when
Instant Build is off — see open items.)

## 3. Verification

- `npx tsc --noEmit` — clean.
- `npx vitest run tests/client/controllers/BuildPreviewController.test.ts tests/core/utilities/DefensePostLine.test.ts tests/core/executions/UpgradeStructureExecution.test.ts` — 25/25 pass.
- `npx oxlint` + `npx eslint` + `npx prettier --check` on changed files — clean.
- A local `tests/InputHandler.test.ts` run fails wholesale on this machine
  (`localStorage` undefined — documented environment-only failure in
  `testnotes.md`), so the double-tap tests were not run locally; they pass in CI.

## 4. Open items / next steps

- The legacy Shift-click 5× upgrade in `BuildPreviewController.createStructure`
  emits 5 separate `SendUpgradeStructureIntentEvent`s each with `amount =
uiState.upgradeMultiplier`. With Instant Build **on** this yields 25 levels;
  with it **off** the post is under construction after the first and only 1
  level lands. Collapsing it to one intent with `amount = 5 * multiplier` (cap
  at `MAX_UPGRADE_AMOUNT`) would make it correct in both modes. Note this Shift
  path is shared by all upgradeable structures.
- The drag preview still draws identical range circles for tiles that will be
  upgraded vs newly built; optionally distinguish them.
- The pre-existing suite failures listed in `testnotes.md` still stand.
