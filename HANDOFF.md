# Handoff — v34 backports, tutorial, and upstream maps

> Future sessions: this file holds the current handoff. Overwrite it rather than
> appending; keep only the latest handoff. Write one only when the session leaves
> open items or partially verified work.

Companion notes: `testnotes.md`.

## 1. Where things are

- Repo: `C:\Users\ai51940\OpenFrontIO`.
- Tokens (all authenticate as **`hexfront-dev`**):
  - `H:\Documents\Hexfront-token.txt` — write to the fork (`origin`).
  - `H:\Documents\Norrasoff-token.txt` — read-only on NorrasOFF.
  - `H:\Documents\Fly.io-token.txt` — Fly deploy token (app `openfrontio`).
- Remotes: `origin` = `hexfront-dev/NorraRealFront-Remus-`,
  `norrasoff` = `NorrasOFF/NorraRealFront`, `upstream` = `openfrontio/OpenFrontIO`,
  `hexfront` = `hexfront-dev/OpenFrontIO`.
- Current work branch: `upstream-v34-backports`.
- Latest local commits:
  - `c962acdcd` — targeted v34 backports (team win threshold, 20s spawn phase,
    reject empty attacks).
  - `e5464e855` — upstream v34 tutorial + 17 upstream maps.
- The full `v34` merge was tested and **aborted**. It conflicted in 32 files
  (81 code/test hunks plus two generated attack snapshots). Most conflicts were
  the fork’s intentional Steam/store/ads/public-lobby removals. Do not retry a
  wholesale `v34` merge without a dedicated integration session.

## 2. What landed this session

### Targeted v34 backports

- Team games now use the same **80% win threshold** as FFA.
- `WinCheckExecution` treats a `null` max timer as “no timer”, fixing lobbies
  that declared a winner immediately with the timer disabled.
- Multiplayer spawn phase shortened from **300 ticks (30s) to 200 ticks (20s)**.
- `AttackExecution` now rejects an attack that has nothing to conquer, closing
  the repeated non-border attack/troop-cap exploit.

### Tutorial

Ported the old-layout `v34` tutorial (`73c82be62`):

- `src/client/hud/Tutorial.ts`
- `src/client/hud/layers/TutorialPanel.ts`
- `tests/Tutorial.test.ts`
- Tutorial card on the play page, Help Modal entry point, Main event wiring,
  HUD highlights, spawn ring/marked-player rendering, tutorial CSS, and
  `UserSettings.tutorialDismissed()`.

### Maps

Added all 17 maps present in upstream `main` but missing from the fork:

`babelmandebstrait`, `benelux`, `brainrot`, `canaryislands`, `capecod`,
`capeofgoodhope`, `centralamerica`, `channelislands`, `gulfofmexico`,
`hornofafrica`, `madagascar`, `newzealand`, `ommatrypta`, `pulicatlake`,
`qingchina`, `riodejaneiro`, `vancouverisland`.

Also included:

- Runtime map assets under `resources/maps/<map>/`.
- Source assets under `map-generator/assets/maps/<map>/`.
- 43 missing nation flag SVGs in `resources/flags/`.
- `Maps.gen.ts` enum/list entries and `en.json` map names.
- `map_layers` names for `brland`, `eyeland`, and `eyewater`.
- WebP layer fallback in both `BinaryLoaderGameMapLoader` and
  `FetchGameMapLoader` (new maps ship layer WebP; PNG is still preferred).
- Fork custom map manifests (`eightislands`, `sixislands`, `fourislands`) synced
  with their `info.json`, and `en.json` ordering fixed so the sorted-key test
  now passes.

All new maps use `multiplayerFrequency: 5`, `ffaFrequency/teamFrequency/
specialFrequency: -1`, and no featured rank. `npm run gen-maps` was **not** run.
If it is run later, the new `info.json` files already include
`multiplayer_frequency: 5`, so it should reproduce the current entries.

## 3. Verification

- `npx tsc --noEmit` — clean.
- `npm run lint` — clean.
- Targeted tutorial/map tests: **61 passed**
  (`Tutorial`, `MapConsistency`, `MapManifestFlags`, `MapLayers`,
  `EnJsonSorted`).
- `tests/core`: **519 passed, 1 failed** — the documented pre-existing
  `SAMLauncherExecution` dynamic-range failure.
- `node e2e/run.mjs --map Benelux --bots 10` — **SMOKE OK**. The new map loaded,
  the game spawned, territory grew, and the radial menu opened. Artifacts are in
  `e2e/artifacts/`.
- `tests/UserSettings.test.ts` still has the documented environment-only
  `localStorage` failures under this Node setup.

## 4. Open items

- Ship target is **`origin/main`**. At the time this handoff was written the
  work was on `upstream-v34-backports`; verify the remote tip against the local
  commits below before assuming it has not been pushed.
- The full `v34` / `main` merge remains undone. Keep using targeted backports.
- The tutorial is the v34 version, not the newer main tutorial with
  `KeyboardLayout`/AZERTY labels and later finish touches.
- Tutorial steps do not yet mention fork-only units (MissileShip,
  MissileDefenseShip, Tollhouse, RailroadCenter) or the fork’s custom train
  economy; extend `TUTORIAL_STEPS` if desired.
- New maps currently have no featured ranks and all use frequency 5. Adjust
  `Maps.gen.ts`/`info.json` if the fork wants a curated rotation.
- `resources/maps/brainrot` and `ommatrypta` ship both WebP layers (upstream)
  and PNG copies (fork tests). Keep both unless the layer test/loader is changed.
- Existing known failures remain: SAM dynamic range, localStorage-dependent
  client tests, and the three server suite failures listed in `testnotes.md`.
