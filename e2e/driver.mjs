// Cross-platform headless-Chromium driver for OpenFront.
//
// The Linux-oriented `.claude/skills/run-openfront/driver.mjs` downloads a
// Playwright chromium plus hand-extracted system libraries. On Windows (and on
// any machine with Chrome installed) that is unnecessary: drive the installed
// Chrome via Playwright's `channel: "chrome"`.
//
// Usage (dev server on :9000 must already be up):
//   node e2e/run.mjs
// or import { launch, gotoHome, openSoloModal } from it in a script inside the
// repo (so `playwright` resolves from node_modules).
//
// Requires a one-time `npm install --no-save --no-package-lock playwright`.
import { chromium } from "playwright";

export const BASE_URL = process.env.OPENFRONT_URL ?? "http://localhost:9000";

// Flags tuned for headless software rendering:
//  - Swiftshader gives WebGL2 without a GPU; `--enable-unsafe-swiftshader` is
//    what lets Chrome use it when hardware acceleration is unavailable.
//  - The disable-*-throttling flags keep the simulation turn loop and timers
//    running even though the page is backgrounded/headless.
const DEFAULT_ARGS = [
  "--enable-unsafe-swiftshader",
  "--use-angle=swiftshader",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--no-first-run",
  "--no-default-browser-check",
];

// Installed once per page (runs before any app code):
//  1. Throttle requestAnimationFrame. Swiftshader costs seconds of CPU per
//     frame; an unthrottled loop starves the main thread (timers fire late and
//     the singleplayer turn loop crawls). One frame per interval is enough for
//     screenshots while the sim runs near full speed.
//  2. Hide the software renderer string. src/client/render/gl/initGL.ts gates
//     the game behind a "not software" check on the unmasked renderer; without
//     this the game shows the "WebGL unavailable" screen instead of playing.
const INIT_THROTTLE = (interval) => {
  let last = 0;
  window.requestAnimationFrame = (cb) => {
    const now = performance.now();
    const wait = Math.max(0, interval - (now - last));
    return setTimeout(() => {
      last = performance.now();
      cb(last);
    }, wait);
  };
  window.cancelAnimationFrame = (id) => clearTimeout(id);
};

const INIT_WEBGL = () => {
  const proto = globalThis.WebGL2RenderingContext?.prototype;
  if (proto) {
    const orig = proto.getParameter;
    proto.getParameter = function (p) {
      const v = orig.call(this, p);
      return typeof v === "string"
        ? v.replace(/swiftshader|llvmpipe|software/gi, "E2EHarnessGPU")
        : v;
    };
  }
  // Some Chrome builds refuse a context when `failIfMajorPerformanceCaveat`
  // is set and only software rendering is available. Retry once without it.
  const origGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    const ctx = origGetContext.call(this, type, attrs);
    if (ctx || (type !== "webgl2" && type !== "webgl")) return ctx;
    if (attrs && attrs.failIfMajorPerformanceCaveat) {
      const relaxed = { ...attrs };
      delete relaxed.failIfMajorPerformanceCaveat;
      return origGetContext.call(this, type, relaxed);
    }
    return ctx;
  };
};

// opts:
//   viewport      - {width, height}, default 1400x1000
//   rafIntervalMs - throttle requestAnimationFrame to one frame per interval.
//                   REQUIRED for in-game work (see INIT_THROTTLE).
//   headed        - run a visible browser window (for a human to watch).
//   channel       - Playwright browser channel, default "chrome".
//   args          - extra Chromium flags appended to the defaults.
export async function launch({
  viewport,
  rafIntervalMs,
  headed = false,
  channel = "chrome",
  args,
} = {}) {
  const browser = await chromium.launch({
    channel,
    headless: !headed,
    args: [...DEFAULT_ARGS, ...(args ?? [])],
  });
  const context = await browser.newContext({
    viewport: viewport ?? { width: 1400, height: 1000 },
  });
  if (rafIntervalMs) {
    await context.addInitScript(INIT_THROTTLE, rafIntervalMs);
  }
  await context.addInitScript(INIT_WEBGL);
  const page = await context.newPage();
  page.on("pageerror", (e) =>
    console.log("PAGEERROR:", e.message.split("\n")[0]),
  );
  page.on("crash", () => console.log("PAGE CRASHED"));
  return { browser, context, page };
}

// Attach to an already-running Chrome started with `--remote-debugging-port`
// (default 9222). Lets a human keep a visible window open while the agent
// drives it.
export async function attach({ url = "http://localhost:9222" } = {}) {
  const browser = await chromium.connectOverCDP(url);
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = context.pages()[0] ?? (await context.newPage());
  page.on("pageerror", (e) =>
    console.log("PAGEERROR:", e.message.split("\n")[0]),
  );
  return { browser, context, page };
}

export async function gotoHome(page) {
  await page.goto(BASE_URL, { waitUntil: "load", timeout: 60000 });
  // Lit components render client-side after load.
  await page.waitForTimeout(3000);
}

// The single-player button is labeled "SOLO!". There are multiple SOLO buttons
// in the DOM (responsive layouts) — only one is visible.
export async function openSoloModal(page) {
  await page.locator("button:visible", { hasText: /solo/i }).first().click();
  await page.waitForTimeout(1500);
}
