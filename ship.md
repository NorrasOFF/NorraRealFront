# Tollhouse: changing its sprite and HUD UI

Dedicated Tollhouse art (a stack of coins with one to the side) now lives on
the map, in the build menu, and in the HUD. This note documents every place
that decides how the building is drawn so the art can be swapped again later.

The unit type is `UnitType.Tollhouse` (`src/core/game/Game.ts`), whose string
value is `"Tollhouse"`. The renderer keys everything off that string, so keep
the renderer's `UT_TOLLHOUSE` constant in sync.

The map sprite is the **last (7th) column** of `resources/atlases/icon-atlas.png`
(448×64, 64 px cells); the HUD glyph is
`resources/images/TollhouseIconWhite.svg`. Both are white-on-transparent so the
renderer can tint the map sprite with the owner's color.

## 1. Map sprite (what you see on the map)

Structures are drawn by `StructurePass` from a fixed-column sprite atlas
(`resources/atlases/icon-atlas.png`). The column is chosen by `STRUCTURE_ORDER`
in **both** passes, which must stay identical:

- `src/client/render/gl/passes/StructurePass.ts` — `STRUCTURE_ORDER`
- `src/client/render/gl/passes/StructureLevelPass.ts` — the same
  `STRUCTURE_ORDER` (draws the level number above the building)

`UT_TOLLHOUSE` is the 7th entry (index 6) in both arrays, matching its atlas
column. `UT_TOLLHOUSE` lives in `src/client/render/types/UnitType.ts` and is
re-exported from `src/client/render/types/index.ts`. It is also listed in
`STRUCTURE_TYPES` so the level pass treats it like any other structure. Its
frame shape is a circle, chosen in `structure.frag.glsl` `shapeSDF` by
`vAtlasIdx` (index 6), and its frame size/fill live under `structure.shapes.
Tollhouse` in `render-settings.json`.

### To give the Tollhouse new map art

1. Add/redraw the sprite as the 7th column of `resources/atlases/icon-atlas.png`
   (64 px cell, white on transparent; the atlas must stay `7 × 64` wide).
2. Keep `UT_TOLLHOUSE` as the 7th entry (index 6) of `STRUCTURE_ORDER` in
   **both** `StructurePass.ts` and `StructureLevelPass.ts`. The array index is
   the atlas column, so order matters.
3. No wire/schema change is needed — the unit type already travels on
   `UnitUpdate.unitType`.

## 2. Build-menu HUD icon

`src/client/hud/layers/BuildMenu.ts`:

- The Tollhouse entry at the bottom of `buildTable` uses
  `icon: tollhouseIcon` (`assetUrl("images/TollhouseIconWhite.svg")`). The same
  asset is exported from `HotbarIcons.ts` for the HUD.

## 3. Player info overlay (unit count chip + toll slider)

`src/client/hud/layers/PlayerInfoOverlay.ts`:

- `displayUnitCount(player, UnitType.Tollhouse, tollhouseIcon)` — the small
  count chip next to City/Factory/Port.
- `renderTollRate(player)` — the 0–100% toll slider shown when clicking another
  nation. It reads `myPlayer.tollRateForSmallID(...)` and emits
  `SendSetTollRateIntentEvent` (`src/client/Transport.ts` →
  `set_toll_rate` intent). Styling lives in that template; no icon involved.

## 4. Translations

Only `resources/lang/en.json` is edited by hand (Crowdin owns the rest):

- `unit_type.tollhouse` — the building name.
- `build_menu.desc.tollhouse` — the build-menu description.
- `tollhouse.rate_label` — the slider label.

Keys must stay alphabetically sorted (`tests/EnJsonSorted.test.ts`).

## 5. Persistent range overlay & toll notifications

Two behaviours are wired outside the icon system and may need touching if the
Tollhouse is reworked:

- **Range overlay (all players).** `RangeCirclePass`
  (`src/client/render/gl/passes/RangeCirclePass.ts`) draws a persistent
  translucent amber circle per Tollhouse via `updateTollhouseRanges(...)`; the
  list is built in `Renderer.updateStructures()` using
  `config.tollhouseRange(level)`. Remove the
  `else if (u.unitType === UT_TOLLHOUSE ...)` branch in `Renderer.ts` and the
  `tollhouses` field/draw loop in `RangeCirclePass.ts` to drop it.
- **Toll notification.** Collecting a toll emits a private `MessageType.TOLL`
  event to the toller (`playerID = toller.id()`); text
  `events_display.toll_earned`, colored in `src/client/Utils.ts`
  (`getMessageTypeClasses`).

## 6. Other places that reference structure icons (optional polish)

These are not required for the City placeholder to work, but a dedicated icon
would normally be added there too:

- `src/client/components/baseComponents/stats/PlayerStatsSummary.ts` —
  `otherUnitIcons` (game-end summary rows). The stats wire key is `"toll"`
  (see `src/core/StatsSchemas.ts`).
- `src/client/hud/layers/lib/StatsColumns.ts` — leaderboard column registry.
- `src/client/hud/layers/UnitDisplay.ts` — the persistent hotbar counter
  (lists the Tollhouse with `tollhouseIcon`).
- `src/client/HelpModal.ts` — help/units reference panel (currently has no
  Tollhouse row, so no icon there yet).
- `src/client/components/GameConfigSettings.ts` — already lists the Tollhouse
  for the "disabled units" toggle (label only, no icon).
- `src/client/controllers/BuildPreviewController.ts` — the placement ghost's
  range circle uses `config().tollhouseRange(level)`; no sprite there.

## Quick reference: rules implemented

- Land structure, range = Factory range (`trainStationMaxRange()` = 100).
- Toll range: `+5%` per level, capped at `1.5x` base (level 11+).
- Toll capacity: `level` ships per `30`-tick window.
- A nation may toll a given ship at most once; the rate is a per-nation
  percentage (0–100) set from the other-nation info overlay.
- A ship bound for one of the toller's own ports is exempt (it passes free);
  only the ship's own owner is otherwise exempt, so allies/teammates still pay
  if a rate is set.
- Gold is paid to the Tollhouse owner the moment the ship is tolled, as a
  percentage of the value the ship will have at its destination (projected from
  the remaining route); that already-paid amount is subtracted from the trade
  endpoints' payout at arrival (`src/core/execution/TradeShipExecution.ts`).
- Config lives in `src/core/configuration/Config.ts`:
  `tollhouseBaseRange`, `tollhouseRange`, `tollhouseMaxRange`,
  `tollhouseMaxTollsPerWindow`, `tollhouseTollCooldown`.
