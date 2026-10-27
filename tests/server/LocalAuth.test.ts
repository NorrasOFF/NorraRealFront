// @vitest-environment node
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { UserMeResponseSchema } from "../../src/core/ApiSchemas";
import {
  getLocalAuth,
  LOCAL_JWT_TTL_SECONDS,
  LocalAuthStore,
  resetLocalAuthForTests,
} from "../../src/server/LocalAuth";
import { getUserMe, verifyClientToken } from "../../src/server/jwt";

const BASE = "http://localhost:9000/api";
const AUDIENCE = "localhost";

let dir: string;
let store: LocalAuthStore;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "local-auth-test-"));
  store = new LocalAuthStore(dir, BASE, AUDIENCE);
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("LocalAuthStore", () => {
  test("registers an account and issues a verifiable JWT", async () => {
    const tokens = await store.register("Alice", "correct horse");
    expect(tokens.expiresIn).toBe(LOCAL_JWT_TTL_SECONDS);
    expect(tokens.account.username).toBe("Alice");

    const result = await store.verifyToken(tokens.jwt);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.claims.sub).toBe(tokens.account.id);
    expect(result.claims.iss).toBe(BASE);
    expect(result.claims.aud).toBe(AUDIENCE);
    expect(result.claims.provider).toBe("local");
  });

  test("rejects duplicate usernames case-insensitively", async () => {
    await store.register("Alice", "correct horse");
    await expect(store.register("alice", "another pass")).rejects.toMatchObject(
      { code: "username_taken", status: 409 },
    );
  });

  test("rejects invalid usernames and short passwords", async () => {
    await expect(store.register("a", "correct horse")).rejects.toMatchObject({
      code: "invalid_username",
      status: 400,
    });
    await expect(store.register("Alice", "short")).rejects.toMatchObject({
      code: "invalid_password",
      status: 400,
    });
  });

  test("logs in with the correct password only", async () => {
    await store.register("Alice", "correct horse");
    await expect(store.login("Alice", "wrong password")).rejects.toMatchObject({
      code: "invalid_credentials",
      status: 401,
    });
    const tokens = await store.login("alice", "correct horse");
    expect(tokens.account.username).toBe("Alice");
  });

  test("rotates refresh tokens and rejects the old one", async () => {
    const first = await store.register("Alice", "correct horse");
    const second = await store.refresh(first.refreshToken);
    expect(second.refreshToken).not.toBe(first.refreshToken);
    await expect(store.refresh(first.refreshToken)).rejects.toMatchObject({
      code: "invalid_credentials",
    });
  });

  test("logout invalidates the refresh token", async () => {
    const tokens = await store.register("Alice", "correct horse");
    await store.logout(tokens.refreshToken);
    await expect(store.refresh(tokens.refreshToken)).rejects.toMatchObject({
      code: "invalid_credentials",
    });
  });

  test("builds a UserMeResponse from a token", async () => {
    const tokens = await store.register("Alice", "correct horse");
    const result = await store.userMeFromToken(tokens.jwt);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(UserMeResponseSchema.safeParse(result.response).success).toBe(true);
    expect(result.response.player.publicId).toBe(tokens.account.id);
    expect(result.response.player.username).toBe("Alice");
    expect(result.response.user.email).toBe("Alice");
  });

  test("does not store passwords in plaintext", async () => {
    await store.register("Alice", "correct horse");
    const raw = await fs.readFile(path.join(dir, "accounts.json"), "utf8");
    expect(raw).not.toContain("correct horse");
  });

  test("reloads accounts and key material from disk", async () => {
    const tokens = await store.register("Alice", "correct horse");
    const reloaded = new LocalAuthStore(dir, BASE, AUDIENCE);
    const result = await reloaded.verifyToken(tokens.jwt);
    expect(result.ok).toBe(true);
    const me = await reloaded.userMeFromToken(tokens.jwt);
    expect(me.ok).toBe(true);
  });
});

describe("local auth server integration", () => {
  test("verifies a local JWT and answers user me", async () => {
    const localDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "local-auth-integration-"),
    );
    try {
      vi.stubEnv("LOCAL_AUTH", "1");
      vi.stubEnv("AUTH_DIR", localDir);
      vi.stubEnv("DOMAIN", "localhost");
      vi.stubEnv("LOCAL_AUTH_BASE", BASE);
      resetLocalAuthForTests();
      const tokens = await getLocalAuth().register("Bob", "correct horse");

      const verified = await verifyClientToken(tokens.jwt);
      expect(verified.type).toBe("success");
      if (verified.type !== "success") return;
      expect(verified.persistentId).toBe(tokens.account.id);
      expect(verified.claims?.username).toBe("Bob");

      const me = await getUserMe(tokens.jwt);
      expect(me.type).toBe("success");
      if (me.type !== "success") return;
      expect(me.response.player.username).toBe("Bob");
      expect(me.response.player.publicId).toBe(tokens.account.id);
    } finally {
      resetLocalAuthForTests();
      vi.unstubAllEnvs();
      await fs.rm(localDir, { recursive: true, force: true });
    }
  });
});
