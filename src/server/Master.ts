import cluster, { type Worker as ClusterWorker } from "cluster";
import crypto from "crypto";
import express from "express";
import rateLimit from "express-rate-limit";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { GameEnv } from "../core/configuration/Config";
import { registerAccountTierRoutes } from "./AccountTierRoutes";
import { ClusterWorkerIds } from "./ClusterWorkerIds";
import { getDescriptor } from "./DesktopRelease";
import { initLocalAuth, registerLocalAuthRoutes } from "./LocalAuth";
import { logger } from "./Logger";
import { MapPlaylist } from "./MapPlaylist";
import { MasterLobbyService } from "./MasterLobbyService";
import { setNoStoreHeaders } from "./NoStoreHeaders";
import { registerRankedRoutes } from "./ranking/RankedRatings";
import { renderAppShell } from "./RenderHtml";
import { ServerEnv } from "./ServerEnv";
import { applyStaticAssetCacheControl } from "./StaticAssetCache";

const playlist = new MapPlaylist();
let lobbyService: MasterLobbyService;

const app = express();
const server = http.createServer(app);

const log = logger.child({ comp: "m" });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.json());

// Serve the shared app shell for the root document.
app.use(async (req, res, next) => {
  if (req.path === "/") {
    try {
      await renderAppShell(
        res,
        path.join(__dirname, "../../static/index.html"),
      );
    } catch (error) {
      log.error("Error rendering index.html:", error);
      res.status(500).send("Internal Server Error");
    }
  } else {
    next();
  }
});

// Desktop (Steam) shell release descriptor. See openfront-desktop's
// docs/superpowers/specs/2026-08-20-runtime-asset-updating-design.md.
//
// version.json is polled once a minute by every running desktop client, so it
// is deliberately tiny and separately cacheable; release.json is fetched only
// when that pointer changes. Both must be reachable without a bot challenge --
// see OPE-192.
const staticDir = path.join(__dirname, "../../static");
const descriptorOpts = () => ({
  clientVersion: ServerEnv.gitCommit(),
  cdnBase: ServerEnv.cdnBase(),
  // Production must have a CDN: without one this descriptor would point every
  // Steam client at this app server for ~570MB of assets. Dev and preprod have
  // no CDN, and same-origin is what the web client already does there.
  requireCdnBase: ServerEnv.env() === GameEnv.Prod,
});

app.get("/desktop/version.json", async (_req, res) => {
  try {
    const d = await getDescriptor(staticDir, descriptorOpts());
    res.setHeader("Cache-Control", "public, max-age=0, s-maxage=30");
    res.json({ clientVersion: d.clientVersion, coreVersion: d.coreVersion });
  } catch (error) {
    log.error("Error building desktop version pointer:", error);
    res.status(500).json({ error: "unavailable" });
  }
});

app.get("/desktop/release.json", async (_req, res) => {
  try {
    const d = await getDescriptor(staticDir, descriptorOpts());
    res.setHeader("Cache-Control", "public, max-age=0, s-maxage=30");
    res.json(d);
  } catch (error) {
    log.error("Error building desktop release descriptor:", error);
    res.status(500).json({ error: "unavailable" });
  }
});

app.use(
  express.static(path.join(__dirname, "../../static"), {
    maxAge: "1y", // Set max-age to 1 year for all static assets
    setHeaders: (res) => {
      applyStaticAssetCacheControl(
        res.setHeader.bind(res),
        res.req.originalUrl,
      );
    },
  }),
);

app.set("trust proxy", 3);
app.use(
  rateLimit({
    windowMs: 1000, // 1 second
    max: 20, // 20 requests per IP per second
  }),
);

app.use("/api", (_req, res, next) => {
  setNoStoreHeaders(res);
  next();
});

// Start the master process
export async function startMaster() {
  if (!cluster.isPrimary) {
    throw new Error(
      "startMaster() should only be called in the primary process",
    );
  }

  log.info(`Primary ${process.pid} is running`);
  log.info(`Setting up ${ServerEnv.numWorkers()} workers...`);

  await initLocalAuth();
  registerLocalAuthRoutes(app);
  registerAccountTierRoutes(app);
  registerRankedRoutes(app);
  registerSpaFallback();

  lobbyService = new MasterLobbyService(playlist, log);

  const INSTANCE_ID =
    ServerEnv.env() === GameEnv.Dev
      ? "DEV_ID"
      : crypto.randomBytes(4).toString("hex");
  process.env.INSTANCE_ID = INSTANCE_ID;

  log.info(`Instance ID: ${INSTANCE_ID}`);

  // Set while the master is shutting down, so worker exits are not treated as
  // crashes and restarted.
  let isShuttingDown = false;

  // Node's cluster worker id -> logical WORKER_ID. Must be recorded at fork:
  // by the time the cluster "exit" event runs, `worker.process` is null, so the
  // logical id cannot be read back out of `worker.process.env`. (Reading it
  // there made every crash a permanent outage: the dead worker stayed in the
  // lobby service and was killed again on every broadcast, while /wN kept
  // answering 502.)
  const workerIds = new ClusterWorkerIds();
  // Set by the exit handler so a restart storm cannot hot-loop the master.
  const WORKER_RESTART_DELAY_MS = 1000;

  const spawnWorker = (workerId: number) => {
    const worker = cluster.fork({
      WORKER_ID: workerId,
      INSTANCE_ID,
    });
    workerIds.set(worker.id, workerId);
    lobbyService.registerWorker(workerId, worker);
    log.info(`Started worker ${workerId} (PID: ${worker.process?.pid})`);
    return worker;
  };

  const restartWorker = (workerId: number) => {
    const timer = setTimeout(() => {
      if (isShuttingDown) return;
      try {
        spawnWorker(workerId);
      } catch (error) {
        log.error(`failed to restart worker ${workerId}, retrying:`, error);
        restartWorker(workerId);
      }
    }, WORKER_RESTART_DELAY_MS);
    timer.unref?.();
  };

  // Fork workers
  for (let i = 0; i < ServerEnv.numWorkers(); i++) {
    spawnWorker(i);
  }

  // Handle worker crashes
  cluster.on("exit", (worker, code, signal) => {
    if (isShuttingDown) {
      return;
    }
    const workerId = workerIds.take(worker.id);
    if (workerId === undefined) {
      // Cannot happen while the fork bookkeeping above stays in sync; never
      // silently leave a shard dead if it somehow does.
      const live = new Set(workerIds.logicalIds());
      let replacement = 0;
      while (live.has(replacement)) replacement++;
      log.error(
        `worker ${worker.id} exited (code ${code}, signal ${signal}) without a recorded WORKER_ID; restarting logical worker ${replacement}`,
      );
      lobbyService.removeWorker(replacement);
      restartWorker(replacement);
      return;
    }

    lobbyService.removeWorker(workerId);

    log.warn(
      `Worker ${workerId} (cluster id ${worker.id}, PID: ${worker.process?.pid}) died with code: ${code} and signal: ${signal}`,
    );
    log.info(`Restarting worker ${workerId}...`);

    restartWorker(workerId);
  });

  const PORT = 3000;
  server.listen(PORT, () => {
    log.info(`Master HTTP server listening on port ${PORT}`);
  });

  // Graceful shutdown: ask each worker to persist its live games and wait
  // (bounded) for them to exit, then quit. A terminal Ctrl+C also reaches the
  // workers directly; this covers a signal delivered only to the master.
  const shutdown = (signal: NodeJS.Signals) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    log.info(`received ${signal}, stopping workers`);
    const workers = Object.values(cluster.workers ?? {}).filter(
      (w): w is ClusterWorker => w !== undefined,
    );
    if (workers.length === 0) {
      process.exit(0);
    }
    const timeout = setTimeout(() => process.exit(0), 5000);
    if (typeof timeout.unref === "function") timeout.unref();
    let remaining = workers.length;
    cluster.on("exit", () => {
      remaining--;
      if (remaining <= 0) {
        clearTimeout(timeout);
        process.exit(0);
      }
    });
    for (const worker of workers) {
      worker.process.kill("SIGTERM");
    }
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

app.get("/api/health", (_req, res) => {
  const ready = lobbyService?.isHealthy() ?? false;
  if (ready) {
    res.json({ status: "ok" });
  } else {
    res.status(503).json({ status: "unavailable" });
  }
});

// Asset URLs are content-hashed and served immutable, so a miss means the
// caller is referencing a chunk this build no longer contains (typically a
// stale cached app shell from a previous deploy). These must 404 rather than
// fall through to the app shell: an HTML 200 in place of a JS module makes the
// browser reject a dynamic import with "Failed to fetch dynamically imported
// module" and hides the real cause, and it can be cached as if it were the
// asset. See the client-side recovery in PreloadErrorRecovery.ts.
const ASSET_PATH_PREFIXES = ["/assets/", "/_assets/"];

function isAssetRequest(pathname: string): boolean {
  return ASSET_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

// SPA fallback route
function registerSpaFallback(): void {
  app.get("/{*splat}", async function (req, res) {
    if (isAssetRequest(req.path)) {
      res.status(404).type("text/plain").send("Asset not found");
      return;
    }
    try {
      const htmlPath = path.join(__dirname, "../../static/index.html");
      await renderAppShell(res, htmlPath);
    } catch (error) {
      log.error("Error rendering SPA fallback:", error);
      res.status(500).send("Internal Server Error");
    }
  });
}
