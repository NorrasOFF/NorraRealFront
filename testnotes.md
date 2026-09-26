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
