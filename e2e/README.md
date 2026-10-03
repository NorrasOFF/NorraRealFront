# End-to-end testing (`e2e/`)

Drive the real game in headless Chrome and inspect the result.

This is the Windows-friendly companion to the Linux-oriented
[`run-openfront` skill](../.claude/skills/run-openfront/SKILL.md). It reuses
that skill's in-game helpers (`game.mjs`) and adds a browser launcher that uses
the **installed Chrome** instead of downloading a Playwright chromium.

## One-time setup

```powershell
npm install --no-save --no-package-lock playwright
```

`playwright` is intentionally not a project dependency (this mirrors the
skill's own `setup.sh`). System Chrome is used via Playwright's
`channel: "chrome"`, so no browser download is required.

## Run

```powershell
node e2e/run.mjs                 # full interactive single-player smoke test
node e2e/run.mjs --headed        # watch it in a real window
node e2e/run.mjs --observe       # home + solo modal, screenshots only
node e2e/run.mjs --attach        # drive a Chrome already started on :9222
node e2e/run.mjs --bots 50 --map Africa --keep-server
```

`run.mjs` starts `npm run start:client` automatically if nothing is serving
`http://localhost:9000` (single-player needs only the Vite client, not the Node
game server). `--keep-server` leaves it running afterwards.

## Output

Everything lands in `e2e/artifacts/` (gitignored):

- `01-home.png` … `06-game-radial-menu.png` — screenshots of each step, showing
  the real WebGL-rendered map.
- `state.json` — ground-truth simulation state captured at each step.
- `dev-server.log` — Vite output, when the runner started the server.

A run exits non-zero if territory fails to grow, the radial menu does not open,
or an unexpected console error appears.

## How it works

- `driver.mjs` launches Chrome headless with SwiftShader
  (`--enable-unsafe-swiftshader`) and injects two page scripts: a
  `requestAnimationFrame` throttle (software rendering is slow; an unthrottled
  loop starves the sim) and a WebGL renderer-string spoof (the game gates out
  software renderers in `src/client/render/gl/initGL.ts`).
- `run.mjs` imports the in-game helpers from
  `.claude/skills/run-openfront/game.mjs` and drives a solo game end to end.
- Ground-truth state is read from `<build-menu>.game` (a `GameView`), the same
  live hook the Linux skill uses — no repo changes required.
