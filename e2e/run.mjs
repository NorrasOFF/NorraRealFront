// End-to-end smoke test for OpenFront on Windows (or any machine with Chrome).
//
// Starts the Vite client, drives a real single-player game in headless Chrome,
// and writes screenshots + a state log to e2e/artifacts/ so the run can be
// inspected visually and programmatically.
//
//   node e2e/run.mjs                 # full interactive solo smoke
//   node e2e/run.mjs --observe       # load home + solo modal, screenshot only
//   node e2e/run.mjs --headed        # watch the browser
//   node e2e/run.mjs --attach        # drive a Chrome already on :9222
//   node e2e/run.mjs --bots 50 --map Africa --keep-server
//
// Prereqs: `npm install --no-save --no-package-lock playwright` (one-time).
// Uses installed Chrome via channel "chrome" — no browser download.
import { spawn as spawnProcess } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  attach,
  BASE_URL,
  gotoHome,
  launch,
  openSoloModal,
} from "./driver.mjs";
// Reuse the existing in-game helpers — no game logic duplicated here.
import {
  attack,
  findExpansionTile,
  findSpawnTile,
  gameState,
  openRadialMenu,
  spawn,
  waitForGameReady,
  waitForSpawnPhaseEnd,
  waitForTick,
} from "../.claude/skills/run-openfront/game.mjs";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const ARTIFACTS = path.join(REPO_ROOT, "e2e", "artifacts");
const DEV_LOG = path.join(ARTIFACTS, "dev-server.log");

function parseArgs() {
  const argv = process.argv.slice(2);
  const opts = {
    observe: false,
    headed: false,
    attach: false,
    keepServer: false,
    bots: 10,
    map: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--observe") opts.observe = true;
    else if (a === "--headed") opts.headed = true;
    else if (a === "--attach") opts.attach = true;
    else if (a === "--keep-server") opts.keepServer = true;
    else if (a === "--bots") opts.bots = Number(argv[++i]);
    else if (a === "--map") opts.map = argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

async function serverUp(timeoutMs = 1500) {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(BASE_URL, { signal: controller.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

// Start the Vite client (single-player needs no game server) if :9000 is down.
async function ensureServer() {
  if (await serverUp()) {
    console.log(`[e2e] dev server already up at ${BASE_URL}`);
    return null;
  }
  console.log(`[e2e] starting dev server (npm run start:client)…`);
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const out = fs.openSync(DEV_LOG, "w");
  const child = spawnProcess("npm", ["run", "start:client"], {
    cwd: REPO_ROOT,
    shell: true,
    windowsHide: true,
    env: { ...process.env, SKIP_BROWSER_OPEN: "true" },
    stdio: ["ignore", out, out],
  });
  child.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      console.log(`[e2e] dev server exited with code ${code}`);
    }
  });
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (await serverUp()) {
      console.log(`[e2e] dev server ready at ${BASE_URL}`);
      return child;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`dev server did not become ready; see ${DEV_LOG}`);
}

function stopServer(child) {
  if (!child || child.killed) return;
  if (process.platform === "win32") {
    // npm spawns vite as a child; kill the whole tree.
    spawnProcess("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
  } else {
    child.kill("SIGTERM");
  }
}

// Fork-specific replacement for the skill's startSoloGame: this fork labels the
// button with `game_settings.start` ("START GAME"), while the skill clicks a
// stale `single_modal.start` key. Match by visible text so label/key churn does
// not break the runner. Option fields are set as Lit element properties.
async function startSoloGame(page, opts = {}) {
  if (Object.keys(opts).length > 0) {
    await page.evaluate((o) => {
      const modal = document.querySelector("single-player-modal");
      if (o.bots !== undefined) modal.bots = o.bots;
      if (o.map !== undefined) modal.selectedMap = o.map;
    }, opts);
    await page.waitForTimeout(300);
  }
  await page
    .locator("single-player-modal o-button button:visible")
    .filter({ hasText: /start/i })
    .first()
    .click();
  await waitForGameReady(page);
}

async function main() {
  const opts = parseArgs();
  fs.mkdirSync(ARTIFACTS, { recursive: true });

  const shots = [];
  const stateLog = [];
  const errors = [];

  const shot = async (page, name) => {
    const file = path.join(ARTIFACTS, `${name}.png`);
    await page.screenshot({ path: file });
    const kb = Math.round(fs.statSync(file).size / 1024);
    shots.push(file);
    console.log(`[e2e] screenshot ${file} (${kb} KB)`);
  };
  const record = async (page, label) => {
    const state = await gameState(page);
    stateLog.push({ label, state });
    console.log(`[e2e] ${label}: ${JSON.stringify(state)}`);
    return state;
  };

  const child = ops_attach(opts) ? null : await ensureServer();

  let browser = null;
  try {
    let page;
    if (opts.attach) {
      console.log("[e2e] attaching to Chrome on :9222");
      ({ browser, page } = await attach());
      await gotoHome(page);
    } else {
      console.log("[e2e] launching headless Chrome (channel=chrome)");
      const launched = await launch({
        rafIntervalMs: 3000,
        headed: opts.headed,
      });
      browser = launched.browser;
      page = launched.page;
    }

    page.on("console", (msg) => {
      if (msg.type() !== "error") return;
      const text = msg.text();
      // Auth/cosmetics/ads/telemetry are absent or third-party in dev, and the
      // lobby socket has no game server behind it (single-player only needs the
      // Vite client). These are noise, not failures.
      if (
        /Failed to load resource|Failed to fetch|ramp\.|ERR_CONNECTION_REFUSED|:8787|net::ERR|cloudflareinsights|\/lobbies|WebSocket|Max WebSocket/i.test(
          text,
        )
      ) {
        return;
      }
      errors.push(text);
      console.log(`[e2e] CONSOLE[error]: ${text}`);
    });

    await gotoHome(page);
    await shot(page, "01-home");
    await openSoloModal(page);
    await shot(page, "02-solo-modal");

    if (opts.observe) {
      console.log("[e2e] observe mode: stopping after the solo modal");
    } else {
      console.log(`[e2e] starting solo game (bots=${opts.bots})…`);
      await startSoloGame(page, { bots: opts.bots, map: opts.map });
      await record(page, "spawn-phase");
      await shot(page, "03-game-spawn-phase");

      console.log("[e2e] spawning…");
      const tile = await spawn(page, await findSpawnTile(page));
      console.log(`[e2e] spawned at (${tile.x},${tile.y})`);
      await waitForSpawnPhaseEnd(page);
      const spawned = await record(page, "spawned");
      await shot(page, "04-game-spawned");

      console.log("[e2e] expanding (attack unowned land)…");
      const target = await findExpansionTile(page, tile);
      if (target === null) throw new Error("no expansion tile found");
      await attack(page, target.x, target.y);
      await waitForTick(page, spawned.ticks + 50);
      const expanded = await record(page, "expanded");
      if (
        !expanded.myPlayer ||
        expanded.myPlayer.tilesOwned <= (spawned.myPlayer?.tilesOwned ?? 0)
      ) {
        throw new Error("territory did not grow after attack");
      }
      console.log(
        `[e2e] territory grew ${spawned.myPlayer.tilesOwned} -> ${expanded.myPlayer.tilesOwned} ✓`,
      );
      await shot(page, "05-game-expanded");

      console.log("[e2e] opening radial (build) menu…");
      const radialOpen = await openRadialMenu(page, tile);
      console.log(`[e2e] radial menu visible: ${radialOpen}`);
      await shot(page, "06-game-radial-menu");

      if (!radialOpen) throw new Error("radial menu did not open");
    }

    fs.writeFileSync(
      path.join(ARTIFACTS, "state.json"),
      JSON.stringify(stateLog, null, 2),
    );

    if (errors.length > 0) {
      throw new Error(`${errors.length} unexpected console error(s)`);
    }
    console.log("\n[e2e] SMOKE OK");
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (child && !opts.keepServer) stopServer(child);
  }
}

// Small helper so the attach path skips dev-server management.
function ops_attach(opts) {
  return opts.attach;
}

main().catch((err) => {
  console.error(`\n[e2e] FAILED: ${err.message}`);
  process.exit(1);
});
