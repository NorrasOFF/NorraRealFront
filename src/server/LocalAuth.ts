import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "crypto";
import type { Express, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { promises as fs } from "fs";
import type { JWK } from "jose";
import {
  exportJWK,
  generateKeyPair,
  importJWK,
  jwtVerify,
  SignJWT,
} from "jose";
import path from "path";
import { z } from "zod";
import {
  TokenPayloadSchema,
  type TokenPayload,
  type UserMeResponse,
} from "../core/ApiSchemas";
import { uuidToBase64url } from "../core/Base64";
import { authDataDir } from "./AuthPaths";
import { getRankedRatings } from "./ranking/RankedRatings";

export const LOCAL_REFRESH_COOKIE = "hexfront_refresh";
export const LOCAL_JWT_TTL_SECONDS = 15 * 60;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_SESSIONS_PER_ACCOUNT = 10;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;
const USERNAME_PATTERN = /^[a-zA-Z0-9_-]+( [a-zA-Z0-9_-]+)*$/;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 } as const;

const SessionRecordSchema = z.object({
  tokenHash: z.string(),
  createdAt: z.number(),
  expiresAt: z.number(),
});

const AccountRecordSchema = z.object({
  id: z.string(),
  username: z.string(),
  passwordHash: z.string(),
  createdAt: z.number(),
  sessions: z.array(SessionRecordSchema),
});

const AccountsFileSchema = z.object({
  version: z.literal(1),
  accounts: z.array(AccountRecordSchema),
});

const KeyFileSchema = z.object({
  privateJwk: z.object({}).passthrough(),
  publicJwk: z.object({}).passthrough(),
});

type AccountRecord = z.infer<typeof AccountRecordSchema>;
type SigningKey = Awaited<ReturnType<typeof importJWK>>;

export type LocalAuthTokens = {
  jwt: string;
  expiresIn: number;
  refreshToken: string;
  account: { id: string; username: string };
};

export type LocalAuthFailure = {
  code:
    | "invalid_username"
    | "invalid_password"
    | "username_taken"
    | "invalid_credentials"
    | "rate_limited"
    | "failed";
};

export type LocalAuthResult =
  | { ok: true; tokens: LocalAuthTokens }
  | ({ ok: false } & LocalAuthFailure);

export class LocalAuthError extends Error {
  constructor(
    readonly code: LocalAuthFailure["code"],
    readonly status: number,
  ) {
    super(code);
  }
}

function isEnabledValue(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

export function isLocalAuthEnabled(): boolean {
  return isEnabledValue(process.env.LOCAL_AUTH);
}

export function localAuthBase(): string {
  const explicit = process.env.LOCAL_AUTH_BASE?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const domain = process.env.DOMAIN;
  if (!domain || domain === "localhost") {
    return "http://localhost:9000/api";
  }
  return `https://${domain}/api`;
}

type ScryptOptions = { N: number; r: number; p: number };

function scrypt(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, options, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, SCRYPT.keylen, SCRYPT);
  return [
    "scrypt",
    SCRYPT.N,
    SCRYPT.r,
    SCRYPT.p,
    salt.toString("base64"),
    hash.toString("base64"),
  ].join("$");
}

async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (
    !Number.isInteger(n) ||
    !Number.isInteger(r) ||
    !Number.isInteger(p) ||
    n <= 0 ||
    r <= 0 ||
    p <= 0
  ) {
    return false;
  }
  const salt = Buffer.from(parts[4], "base64");
  const expected = Buffer.from(parts[5], "base64");
  const actual = await scrypt(password, salt, expected.length, { N: n, r, p });
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

function validateUsername(username: string): string {
  const value = username.trim();
  if (value.length < 3 || value.length > 20 || !USERNAME_PATTERN.test(value)) {
    throw new LocalAuthError("invalid_username", 400);
  }
  return value;
}

function validatePassword(password: string): void {
  if (
    password.length < MIN_PASSWORD_LENGTH ||
    password.length > MAX_PASSWORD_LENGTH
  ) {
    throw new LocalAuthError("invalid_password", 400);
  }
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: localAuthBase().startsWith("https://"),
    path: "/api/auth",
  };
}

export class LocalAuthStore {
  private accounts: AccountRecord[] = [];
  private loaded = false;
  private loading: Promise<void> | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private privateKey: SigningKey | null = null;
  private publicJwkValue: JWK | null = null;

  constructor(
    private readonly dir: string = authDataDir(),
    private readonly base: string = localAuthBase(),
    private readonly audience: string = process.env.DOMAIN ?? "localhost",
  ) {}

  async init(): Promise<void> {
    if (this.loaded) return;
    this.loading ??= this.load()
      .then(() => {
        this.loaded = true;
      })
      .finally(() => {
        this.loading = null;
      });
    await this.loading;
  }

  private async load(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    await this.loadAccounts();
    await this.loadOrCreateKey();
  }

  private get accountsFile(): string {
    return path.join(this.dir, "accounts.json");
  }

  private get keyFile(): string {
    return path.join(this.dir, "jwt-key.json");
  }

  private async loadAccounts(): Promise<void> {
    try {
      const raw = await fs.readFile(this.accountsFile, "utf8");
      const parsed = AccountsFileSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        throw new Error("invalid accounts file");
      }
      this.accounts = parsed.data.accounts;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.accounts = [];
    }
    this.pruneSessions();
  }

  private async loadOrCreateKey(): Promise<void> {
    try {
      const raw = await fs.readFile(this.keyFile, "utf8");
      const parsed = KeyFileSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) throw new Error("invalid jwt key file");
      this.publicJwkValue = parsed.data.publicJwk as JWK;
      this.privateKey = await importJWK(parsed.data.privateJwk, "EdDSA");
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const { publicKey, privateKey } = await generateKeyPair("EdDSA", {
      crv: "Ed25519",
      extractable: true,
    });
    const publicJwk: JWK = {
      ...(await exportJWK(publicKey)),
      alg: "EdDSA",
      kid: "local-1",
    };
    const privateJwk: JWK = {
      ...(await exportJWK(privateKey)),
      alg: "EdDSA",
      kid: "local-1",
    };
    const tmp = `${this.keyFile}.${process.pid}.tmp`;
    await fs.writeFile(
      tmp,
      JSON.stringify({ privateJwk, publicJwk }, null, 2),
      { mode: 0o600 },
    );
    await fs.rename(tmp, this.keyFile);
    this.publicJwkValue = publicJwk;
    this.privateKey = await importJWK(privateJwk, "EdDSA");
  }

  private pruneSessions(): void {
    const now = Date.now();
    for (const account of this.accounts) {
      account.sessions = account.sessions.filter((s) => s.expiresAt > now);
    }
  }

  private async persist(): Promise<void> {
    const snapshot: z.infer<typeof AccountsFileSchema> = {
      version: 1,
      accounts: this.accounts,
    };
    const data = JSON.stringify(snapshot, null, 2);
    const tmp = `${this.accountsFile}.${process.pid}.${Date.now()}.tmp`;
    const run = this.writeChain.then(async () => {
      await fs.writeFile(tmp, data, { mode: 0o600 });
      await fs.rename(tmp, this.accountsFile);
    });
    this.writeChain = run.catch(() => undefined);
    await run;
  }

  private findById(id: string): AccountRecord | undefined {
    return this.accounts.find((a) => a.id === id);
  }

  private findByUsername(username: string): AccountRecord | undefined {
    const normalized = normalizeUsername(username);
    return this.accounts.find(
      (a) => normalizeUsername(a.username) === normalized,
    );
  }

  private async signJwt(account: AccountRecord): Promise<string> {
    if (!this.privateKey) throw new LocalAuthError("failed", 500);
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      provider: "local",
      username: account.username,
    })
      .setProtectedHeader({ alg: "EdDSA", typ: "JWT" })
      .setSubject(uuidToBase64url(account.id))
      .setIssuer(this.base)
      .setAudience(this.audience)
      .setIssuedAt(now)
      .setExpirationTime(now + LOCAL_JWT_TTL_SECONDS)
      .setJti(randomUUID())
      .sign(this.privateKey);
  }

  private async createSession(
    account: AccountRecord,
  ): Promise<LocalAuthTokens> {
    const refreshToken = randomBytes(32).toString("base64url");
    const now = Date.now();
    account.sessions.push({
      tokenHash: tokenHash(refreshToken),
      createdAt: now,
      expiresAt: now + REFRESH_TTL_MS,
    });
    account.sessions.sort((a, b) => b.createdAt - a.createdAt);
    account.sessions = account.sessions.slice(0, MAX_SESSIONS_PER_ACCOUNT);
    await this.persist();
    return {
      jwt: await this.signJwt(account),
      expiresIn: LOCAL_JWT_TTL_SECONDS,
      refreshToken,
      account: { id: account.id, username: account.username },
    };
  }

  async register(username: string, password: string): Promise<LocalAuthTokens> {
    await this.init();
    const displayName = validateUsername(username);
    validatePassword(password);
    if (this.findByUsername(displayName)) {
      throw new LocalAuthError("username_taken", 409);
    }
    const passwordHash = await hashPassword(password);
    if (this.findByUsername(displayName)) {
      throw new LocalAuthError("username_taken", 409);
    }
    const account: AccountRecord = {
      id: randomUUID(),
      username: displayName,
      passwordHash,
      createdAt: Date.now(),
      sessions: [],
    };
    this.accounts.push(account);
    return this.createSession(account);
  }

  async login(username: string, password: string): Promise<LocalAuthTokens> {
    await this.init();
    const account = this.findByUsername(username.trim());
    if (!account) {
      throw new LocalAuthError("invalid_credentials", 401);
    }
    if (!(await verifyPassword(password, account.passwordHash))) {
      throw new LocalAuthError("invalid_credentials", 401);
    }
    return this.createSession(account);
  }

  async refresh(refreshToken: string): Promise<LocalAuthTokens> {
    await this.init();
    const hash = tokenHash(refreshToken);
    const now = Date.now();
    for (const account of this.accounts) {
      const index = account.sessions.findIndex(
        (s) => s.tokenHash === hash && s.expiresAt > now,
      );
      if (index === -1) continue;
      account.sessions.splice(index, 1);
      return this.createSession(account);
    }
    throw new LocalAuthError("invalid_credentials", 401);
  }

  async logout(refreshToken: string): Promise<void> {
    await this.init();
    const hash = tokenHash(refreshToken);
    let changed = false;
    for (const account of this.accounts) {
      const before = account.sessions.length;
      account.sessions = account.sessions.filter((s) => s.tokenHash !== hash);
      if (account.sessions.length !== before) changed = true;
    }
    if (changed) await this.persist();
  }

  async verifyToken(
    token: string,
  ): Promise<
    { ok: true; claims: TokenPayload } | { ok: false; error: string }
  > {
    await this.init();
    if (!this.publicJwkValue) {
      return { ok: false, error: "local auth key unavailable" };
    }
    try {
      const key = await importJWK(this.publicJwkValue, "EdDSA");
      const { payload } = await jwtVerify(token, key, {
        algorithms: ["EdDSA"],
        issuer: this.base,
        audience: this.audience,
      });
      const parsed = TokenPayloadSchema.safeParse(payload);
      if (!parsed.success) {
        return { ok: false, error: "invalid token payload" };
      }
      return { ok: true, claims: parsed.data };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "invalid token",
      };
    }
  }

  async userMeFromToken(
    token: string,
  ): Promise<
    { ok: true; response: UserMeResponse } | { ok: false; error: string }
  > {
    const result = await this.verifyToken(token);
    if (!result.ok) return result;
    const account = this.findById(result.claims.sub);
    const username = result.claims.username ?? account?.username;
    if (!username) {
      return { ok: false, error: "account not found" };
    }
    // The ranked ladder is local to this deployment. A missing/failed store
    // read must not break sign-in, so an unavailable rating degrades to "no
    // Elo" (the client already renders `no_elo` when the field is absent).
    let rankedElo: number | undefined;
    try {
      rankedElo = (await getRankedRatings().player(result.claims.sub))?.elo;
    } catch (error) {
      console.warn("local auth: ranked rating read failed", error);
    }
    return {
      ok: true,
      response: {
        user: { email: username },
        player: {
          publicId: result.claims.sub,
          adfree: true,
          unlimitedRanked: true,
          canCreatePublicLobbies: false,
          trustTier: "trusted",
          username,
          usernameBase: username,
          usernameStatus: "indefinite",
          usernameClaimExpiresAt: null,
          nextUsernameChangeAt: null,
          flares: [],
          achievements: { singleplayerMap: [] },
          friends: [],
          subscription: null,
          currency: { soft: 0, hard: 0 },
          leaderboard:
            rankedElo === undefined
              ? undefined
              : { ranked: { elo: rankedElo } },
        },
      },
    };
  }

  async publicJwk(): Promise<JWK> {
    await this.init();
    if (!this.publicJwkValue) {
      throw new Error("local auth key unavailable");
    }
    return this.publicJwkValue;
  }
}

let singleton: LocalAuthStore | null = null;

export function getLocalAuth(): LocalAuthStore {
  singleton ??= new LocalAuthStore();
  return singleton;
}

export function resetLocalAuthForTests(): void {
  singleton = null;
}

export async function initLocalAuth(): Promise<void> {
  if (isLocalAuthEnabled()) await getLocalAuth().init();
}

function sendAuthError(res: Response, error: unknown): void {
  if (error instanceof LocalAuthError) {
    res.status(error.status).json({ error: error.code });
    return;
  }
  console.error("local auth request failed", error);
  res.status(500).json({ error: "failed" });
}

function credentialsFromBody(
  req: Request,
  res: Response,
): { username: string; password: string } | null {
  const body = req.body as { username?: unknown; password?: unknown } | null;
  if (
    typeof body?.username !== "string" ||
    typeof body?.password !== "string"
  ) {
    res.status(400).json({ error: "invalid_request" });
    return null;
  }
  return { username: body.username, password: body.password };
}

function setRefreshCookie(res: Response, tokens: LocalAuthTokens): void {
  res.cookie(LOCAL_REFRESH_COOKIE, tokens.refreshToken, {
    ...cookieOptions(),
    maxAge: REFRESH_TTL_MS,
  });
}

export function registerLocalAuthRoutes(app: Express): void {
  if (!isLocalAuthEnabled()) return;
  const store = getLocalAuth();
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "rate_limited" },
  });

  app.post("/api/auth/register", limiter, async (req, res) => {
    const credentials = credentialsFromBody(req, res);
    if (!credentials) return;
    try {
      const tokens = await store.register(
        credentials.username,
        credentials.password,
      );
      setRefreshCookie(res, tokens);
      res.json({ jwt: tokens.jwt, expiresIn: tokens.expiresIn });
    } catch (error) {
      sendAuthError(res, error);
    }
  });

  app.post("/api/auth/login", limiter, async (req, res) => {
    const credentials = credentialsFromBody(req, res);
    if (!credentials) return;
    try {
      const tokens = await store.login(
        credentials.username,
        credentials.password,
      );
      setRefreshCookie(res, tokens);
      res.json({ jwt: tokens.jwt, expiresIn: tokens.expiresIn });
    } catch (error) {
      sendAuthError(res, error);
    }
  });

  app.post("/api/auth/refresh", async (req, res) => {
    const refreshToken = readCookie(req, LOCAL_REFRESH_COOKIE);
    if (!refreshToken) {
      res.status(401).json({ error: "invalid_credentials" });
      return;
    }
    try {
      const tokens = await store.refresh(refreshToken);
      setRefreshCookie(res, tokens);
      res.json({ jwt: tokens.jwt, expiresIn: tokens.expiresIn });
    } catch (error) {
      res.clearCookie(LOCAL_REFRESH_COOKIE, cookieOptions());
      sendAuthError(res, error);
    }
  });

  app.post("/api/auth/logout", async (req, res) => {
    const refreshToken = readCookie(req, LOCAL_REFRESH_COOKIE);
    if (refreshToken) {
      try {
        await store.logout(refreshToken);
      } catch (error) {
        console.error("local auth logout failed", error);
      }
    }
    res.clearCookie(LOCAL_REFRESH_COOKIE, cookieOptions());
    res.status(204).end();
  });

  app.get("/api/users/@me", async (req, res) => {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const result = await store.userMeFromToken(header.slice("Bearer ".length));
    if (!result.ok) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    res.json(result.response);
  });

  const jwks = async (_req: Request, res: Response) => {
    res.json({ keys: [await store.publicJwk()] });
  };
  app.get("/api/.well-known/jwks.json", jwks);
  app.get("/.well-known/jwks.json", jwks);
}
