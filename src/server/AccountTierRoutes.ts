import crypto from "crypto";
import type { Express, Request, Response } from "express";
import { z } from "zod";
import { verifyClientToken } from "./jwt";
import {
  AccountTierSchema,
  getLocalAuth,
  isLocalAuthEnabled,
  LocalAuthError,
} from "./LocalAuth";
import { logger } from "./Logger";
import { ServerEnv } from "./ServerEnv";

const log = logger.child({ comp: "tiers" });

const TierRequestSchema = z
  .object({
    publicId: z.string().min(1).optional(),
    username: z.string().min(1).optional(),
    tier: AccountTierSchema,
  })
  .refine(
    (value) => value.publicId !== undefined || value.username !== undefined,
    {
      message: "publicId or username required",
    },
  );

const PasswordResetSchema = z
  .object({
    publicId: z.string().min(1).optional(),
    username: z.string().min(1).optional(),
    password: z.string(),
  })
  .refine(
    (value) => value.publicId !== undefined || value.username !== undefined,
    {
      message: "publicId or username required",
    },
  );

type Authorization =
  | { type: "admin-bot" }
  | { type: "admin"; publicId: string }
  | { type: "forbidden" }
  | { type: "unauthorized" };

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// Two ways to authorize a tier change:
// - the shared admin-bot key, for scripts and the website, or
// - a Bearer token whose account is currently tier `admin`, so a granted
//   admin can manage tiers from their own account without the secret.
async function authorize(req: Request): Promise<Authorization> {
  const expected = ServerEnv.adminBotKey();
  const provided = req.headers[ServerEnv.adminBotHeader()];
  if (
    expected !== undefined &&
    typeof provided === "string" &&
    timingSafeEqualStr(provided, expected)
  ) {
    return { type: "admin-bot" };
  }

  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return { type: "unauthorized" };
  const result = await verifyClientToken(header.slice("Bearer ".length));
  if (result.type !== "success" || result.claims === null) {
    return { type: "unauthorized" };
  }
  if (await getLocalAuth().canManageTiers(result.persistentId)) {
    return { type: "admin", publicId: result.persistentId };
  }
  return { type: "forbidden" };
}

function deny(
  res: Response,
  authorization: Authorization,
): authorization is { type: "unauthorized" } | { type: "forbidden" } {
  if (authorization.type === "unauthorized") {
    res.status(401).json({ error: "unauthorized" });
    return true;
  }
  if (authorization.type === "forbidden") {
    res.status(403).json({ error: "admin_required" });
    return true;
  }
  return false;
}

// Only available when local accounts are enabled; the upstream API owns tiers
// otherwise. Mounted on the master, which is the only process that writes
// accounts.json.
export function registerAccountTierRoutes(app: Express): void {
  if (!isLocalAuthEnabled()) return;

  app.get("/api/admin/accounts", async (req, res) => {
    const authorization = await authorize(req);
    if (deny(res, authorization)) return;

    const query = typeof req.query.query === "string" ? req.query.query : "";
    const rawLimit =
      typeof req.query.limit === "string" ? Number(req.query.limit) : 25;
    const limit = Number.isFinite(rawLimit) ? rawLimit : 25;
    const accounts = await getLocalAuth().searchAccounts(query, limit);
    res.json({ accounts });
  });

  app.get("/api/admin/account-tier", async (req, res) => {
    const authorization = await authorize(req);
    if (deny(res, authorization)) return;

    const identifier =
      typeof req.query.identifier === "string" ? req.query.identifier : "";
    if (identifier.length === 0) {
      res.status(400).json({ error: "identifier_required" });
      return;
    }
    const info = await getLocalAuth().accountTierInfo(identifier);
    if (info === null) {
      res.status(404).json({ error: "account_not_found" });
      return;
    }
    res.json(info);
  });

  app.post("/api/admin/account-tier", async (req, res) => {
    const authorization = await authorize(req);
    if (deny(res, authorization)) return;

    const parsed = TierRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: z.prettifyError(parsed.error) });
      return;
    }
    const identifier = parsed.data.publicId ?? parsed.data.username;
    if (identifier === undefined) {
      res.status(400).json({ error: "identifier_required" });
      return;
    }

    const info = await getLocalAuth().setAccountTier(
      identifier,
      parsed.data.tier,
    );
    if (info === null) {
      res.status(404).json({ error: "account_not_found" });
      return;
    }

    const actor =
      authorization.type === "admin-bot"
        ? "admin-bot"
        : `admin:${authorization.publicId}`;
    log.info(
      `account tier ${info.tier} granted to ${info.username} (${info.publicId}) by ${actor}`,
    );
    res.json(info);
  });

  app.post("/api/admin/account-password", async (req, res) => {
    const authorization = await authorize(req);
    if (deny(res, authorization)) return;

    const parsed = PasswordResetSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: z.prettifyError(parsed.error) });
      return;
    }
    const identifier = parsed.data.publicId ?? parsed.data.username;
    if (identifier === undefined) {
      res.status(400).json({ error: "identifier_required" });
      return;
    }

    let info: { username: string; publicId: string } | null;
    try {
      info = await getLocalAuth().resetAccountPassword(
        identifier,
        parsed.data.password,
      );
    } catch (error) {
      if (error instanceof LocalAuthError) {
        res.status(error.status).json({ error: error.code });
        return;
      }
      throw error;
    }
    if (info === null) {
      res.status(404).json({ error: "account_not_found" });
      return;
    }

    const actor =
      authorization.type === "admin-bot"
        ? "admin-bot"
        : `admin:${authorization.publicId}`;
    log.info(
      `password reset for ${info.username} (${info.publicId}) by ${actor}`,
    );
    res.json(info);
  });
}
