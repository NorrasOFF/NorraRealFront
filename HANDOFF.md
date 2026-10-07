# Handoff — defense-post drag from the hotbar (no more stop-sign cursor)

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

Report: "I had [defense post] selected, tried to drag over a defense post to
upgrade several at once, but couldn't — my mouse turned into a stop sign."

Root cause: the HUD hotbar/build-menu icons are `<img>` elements with no
`draggable="false"`, so a press-and-drag that started on the defense-post
hotbar icon became a native image drag. The browser shows its "no-drop" (stop
sign) cursor over the canvas, and because the press began on the HUD the
canvas `pointerdown` never fired, so the defense-post line gesture never
started.

Fix (client-only):

- `src/client/hud/layers/UnitDisplay.ts` — icon `<img>` `draggable="false"`,
  item `@dragstart` prevented, and a `@pointerdown` on an already-selected icon
  emits the new `BeginBuildDragEvent`.
- `src/client/InputHandler.ts` — new `BeginBuildDragEvent`; on receipt (only for
  an active `UnitType.DefensePost` ghost) it sets `pointerDown` +
  `pointerDownFromHud` and the down position so the existing window
  `pointermove` runs the defense-post line branch and `pointerup` completes it.
  `onPointerUp` early-returns for a HUD press that never became a line drag, so
  the hotbar `@click` still toggles selection; `window.blur` clears the flag.
- `src/client/hud/layers/BuildMenu.ts` — icon + gold `<img>` `draggable="false"`.

## 3. Verification

- `npx tsc --noEmit` — clean.
- `npx prettier --check`, `npx eslint`, `npx oxlint` on the three changed files —
  clean.
- `npx vitest run tests/client/controllers/BuildPreviewController.test.ts` —
  15 passed. (`tests/InputHandler.test.ts` still fails wholesale in this
  environment on the documented `localStorage is undefined` issue; it aborts in
  `InputHandler.initialize` before touching this change. CI/jsdom is unaffected.)
- Real-browser e2e (throwaway driver reusing `e2e/driver.mjs` +
  `.claude/skills/run-openfront/game.mjs`; deleted afterwards — recreate from
  `testnotes.md`):
  - Map drag from post A to post B upgraded both endpoints (`1,1,1 -> 2,1,2`).
  - Hotbar press-drag from the defense-post icon onto the map upgraded the post
    under the line's end sample by +5 (double-tap multiplier) and built a post
    on an empty sample (`2 -> 7,1`).
  - `0` native `dragstart` events fired during the hotbar drag.

## 4. Open items / next steps

- **Sample alignment (pre-existing, unchanged).** `onDefenseLineComplete` only
  upgrades a post when a sample tile lands _exactly_ on it. Samples are spaced
  `2 * defensePostRange() - 5` = 55 world units, and the start/end tiles are
  always included. So a drag over a post whose tile is not a sample still
  builds/skips instead of upgrading. If users expect "drag across N posts =>
  upgrade all N", change the `postIdAt` callback to resolve the nearest owned
  post within `structureMinDist` (15) of a sample (mirrors the core's click
  upgrade radius) — `planDefenseLineActions` itself needs no change.
- Other HUD `<img>`s (e.g. `PlayerPanel`, `PlayerInfoOverlay`) are still natively
  draggable; only the build-origin icons were changed. If a stop-sign cursor is
  reported from another HUD area, add `draggable="false"` there too.
- The pre-existing suite failures listed in `testnotes.md` still stand.
