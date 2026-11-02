// @vitest-environment node
import express from "express";
import { promises as fs } from "fs";
import type { Server } from "http";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { registerAccountTierRoutes } from "../../src/server/AccountTierRoutes";
import {
  getLocalAuth,
  LocalAuthStore,
  registerLocalAuthRoutes,
  resetLocalAuthForTests,
} from "../../src/server/LocalAuth";

const BASE = "http://localhost:9000/api";
const AUDIENCE = "localhost";
const ADMIN_KEY = "test-admin-key";

let dir: string;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "account-tiers-"));
  vi.stubEnv("OWNER_USERNAME", "");
  vi.stubEnv("OWNER_USERNAMES", "");
});

afterEach(async () => {
  resetLocalAuthForTests();
  vi.unstubAllEnvs();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("account tiers", () => {
  test("defaults to player and persists grants", async () => {
    const store = new LocalAuthStore(dir, BASE, AUDIENCE);
    const alice = await store.register("Alice", "correct horse");

    expect(await store.accountTier(alice.account.id)).toBe("player");
    expect(await store.canHostRanked(alice.account.id)).toBe(false);
    expect(await store.canManageTiers(alice.account.id)).toBe(false);

    const granted = await store.setAccountTier("Alice", "host");
    expect(granted?.tier).toBe("host");
    expect(await store.canHostRanked(alice.account.id)).toBe(true);
    expect(await store.canManageTiers(alice.account.id)).toBe(false);

    const reopened = new LocalAuthStore(dir, BASE, AUDIENCE);
    expect(await reopened.accountTier(alice.account.id)).toBe("host");
  });

  test("owner username is bootstrapped as admin", async () => {
    vi.stubEnv("OWNER_USERNAME", "Remus");
    const store = new LocalAuthStore(dir, BASE, AUDIENCE);
    const remus = await store.register("Remus", "correct horse");
    const alice = await store.register("Alice", "correct horse");

    expect(await store.accountTier(remus.account.id)).toBe("admin");
    expect(await store.canManageTiers(remus.account.id)).toBe(true);

    const me = await store.userMeFromToken(remus.jwt);
    expect(me.ok).toBe(true);
    if (!me.ok) return;
    expect(me.response.player.canCreatePublicLobbies).toBe(true);

    const aliceMe = await store.userMeFromToken(alice.jwt);
    expect(aliceMe.ok).toBe(true);
    if (!aliceMe.ok) return;
    expect(aliceMe.response.player.canCreatePublicLobbies).toBe(false);

    // An explicit stored player value cannot demote an owner.
    await store.setAccountTier(remus.account.id, "player");
    expect(await store.accountTier(remus.account.id)).toBe("admin");
  });

  test("a running reader sees a grant made by the writer", async () => {
    const writer = new LocalAuthStore(dir, BASE, AUDIENCE);
    const alice = await writer.register("Alice", "correct horse");

    const reader = new LocalAuthStore(dir, BASE, AUDIENCE);
    expect(await reader.accountTier(alice.account.id)).toBe("player");

    // Windows mtime resolution is coarse; make sure the write lands on a
    // later timestamp than the reader's initial load.
    await sleep(20);
    await writer.setAccountTier(alice.account.id, "host");

    expect(await reader.accountTier(alice.account.id)).toBe("host");
  });
});

describe("account tier routes", () => {
  let server: Server;
  let base: string;

  async function post(
    pathName: string,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    return fetch(`${base}${pathName}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  }

  async function register(
    username: string,
  ): Promise<{ jwt: string; publicId: string }> {
    const response = await post("/api/auth/register", {
      username,
      password: "correct horse",
    });
    expect(response.status).toBe(200);
    const { jwt } = (await response.json()) as { jwt: string };
    const me = await fetch(`${base}/api/users/@me`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    const body = (await me.json()) as { player: { publicId: string } };
    return { jwt, publicId: body.player.publicId };
  }

  beforeEach(async () => {
    vi.stubEnv("LOCAL_AUTH", "1");
    vi.stubEnv("AUTH_DIR", dir);
    vi.stubEnv("DOMAIN", "localhost");
    vi.stubEnv("LOCAL_AUTH_BASE", BASE);
    vi.stubEnv("ADMIN_BOT_API_KEY", ADMIN_KEY);
    vi.stubEnv("OWNER_USERNAME", "Remus");
    resetLocalAuthForTests();

    const app = express();
    app.use(express.json());
    registerLocalAuthRoutes(app);
    registerAccountTierRoutes(app);
    await new Promise<void>((resolve, reject) => {
      server = app.listen(0, "127.0.0.1", (error?: Error) =>
        error ? reject(error) : resolve(),
      );
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("missing server address");
    }
    base = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("requires an admin bot key or an admin account", async () => {
    const bob = await register("Bob");

    const anonymous = await post("/api/admin/account-tier", {
      publicId: bob.publicId,
      tier: "host",
    });
    expect(anonymous.status).toBe(401);

    const player = await post(
      "/api/admin/account-tier",
      { publicId: bob.publicId, tier: "host" },
      { Authorization: `Bearer ${bob.jwt}` },
    );
    expect(player.status).toBe(403);
    expect(await player.json()).toEqual({ error: "admin_required" });
  });

  test("the admin bot key grants a tier", async () => {
    const bob = await register("Bob");

    const grant = await post(
      "/api/admin/account-tier",
      { username: "Bob", tier: "host" },
      { "x-admin-bot-key": ADMIN_KEY },
    );
    expect(grant.status).toBe(200);
    expect(await grant.json()).toMatchObject({
      publicId: bob.publicId,
      username: "Bob",
      tier: "host",
      canHostRanked: true,
      canManageTiers: false,
    });

    const me = await fetch(`${base}/api/users/@me`, {
      headers: { Authorization: `Bearer ${bob.jwt}` },
    });
    const body = (await me.json()) as {
      player: { canCreatePublicLobbies: boolean };
    };
    expect(body.player.canCreatePublicLobbies).toBe(true);
  });

  test("an admin account can grant and revoke tiers without the key", async () => {
    const owner = await register("Remus");
    const alice = await register("Alice");

    const promote = await post(
      "/api/admin/account-tier",
      { username: "Alice", tier: "admin" },
      { Authorization: `Bearer ${owner.jwt}` },
    );
    expect(promote.status).toBe(200);

    const info = await fetch(
      `${base}/api/admin/account-tier?identifier=${alice.publicId}`,
      { headers: { Authorization: `Bearer ${alice.jwt}` } },
    );
    expect(info.status).toBe(200);
    expect(await info.json()).toMatchObject({
      tier: "admin",
      canManageTiers: true,
    });

    const demote = await post(
      "/api/admin/account-tier",
      { publicId: alice.publicId, tier: "player" },
      { Authorization: `Bearer ${owner.jwt}` },
    );
    expect(demote.status).toBe(200);
    expect(await demote.json()).toMatchObject({ tier: "player" });

    const after = await post(
      "/api/admin/account-tier",
      { publicId: owner.publicId, tier: "host" },
      { Authorization: `Bearer ${alice.jwt}` },
    );
    expect(after.status).toBe(403);
  });

  test("reports an unknown account", async () => {
    const response = await post(
      "/api/admin/account-tier",
      { publicId: "does-not-exist", tier: "host" },
      { "x-admin-bot-key": ADMIN_KEY },
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "account_not_found" });
  });

  test("the grant is visible to the local auth store", async () => {
    const bob = await register("Bob");
    await post(
      "/api/admin/account-tier",
      { publicId: bob.publicId, tier: "host" },
      { "x-admin-bot-key": ADMIN_KEY },
    );
    expect(await getLocalAuth().accountTier(bob.publicId)).toBe("host");
  });
});
