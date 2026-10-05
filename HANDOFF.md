# Handoff — missile/anti-missile ships step every 1.5 ticks

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

The 2-tick movement slowdown for **Missile Ship** and **Missile Defense Ship** is
now 1.5 ticks (two steps every three ticks). Warships still step every tick.

- `src/core/execution/FleetFormation.ts` — `shipMoveInterval` returns `1.5` for
  the two ship types (was `2`). New `shipShouldMove(ticksPerMove, ticks)` gates a
  step with integer half-tick math (`floor(ticks * 2 / rateX2)`,
  `rateX2 = ticksPerMove * 2`), since `ticks % 1.5` is invalid. Equivalent to the
  old modulo for integer rates.
- `MissileShipExecution.ts`, `MissileDefenseShipExecution.ts` — `patrol()` and
  `moveToPatrolTile()` use `shipShouldMove`.
- `WarshipExecution.ts` — `moveToPatrolTile()` uses `shipShouldMove`, so a fleet
  containing a missile ship steps at the fleet's 1.5 rate too.
- `tests/core/FleetFormation.test.ts` (new) pins the rate and step pattern.
- `testnotes.md` — "Missile/anti-missile ships step every 1.5 ticks".

## 3. Verification

- `npx tsc --noEmit` — clean.
- `npx vitest run tests/core/FleetFormation.test.ts tests/MissileDefenseShip.test.ts tests/core/CheckpointShips.test.ts` — 12/12 pass.
- `npx oxlint` + `npx eslint` on all changed files — clean.

## 4. Open items / next steps

- **Health does not increase per level.** Both ships are flat `maxHealth: 1000`
  (same as a `Warship`); the +10%/level HP scaling from `e74f86897` was removed in
  `1413b7445` alongside the speed penalty. The user asked how much health
  increases — the answer is **0**. If a per-level HP bonus is wanted, re-add it in
  `UnitImpl` (`effectiveMaxHealth()` is still present but unconditional) without
  reintroducing the speed penalty.
- The step change alters movement timing, so any golden transcript / recorded-game
  expectation covering ship movement will diverge — expected for a gameplay
  change. The pre-existing suite failures in `testnotes.md` still stand.
