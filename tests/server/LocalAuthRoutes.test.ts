// @vitest-environment node
import express from "express";
import { promises as fs } from "fs";
import type { Server } from "http";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  LOCAL_REFRESH_COOKIE,
  registerLocalAuthRoutes,
  resetLocalAuthForTests,
} from "../../src/server/LocalAuth";

let dir: string;
let server: Server;
let base: string;

function cookieFrom(response: Response): string {
  const header = response.headers.get("set-cookie");
  if (!header) return "";
  return header.split(";")[0];
}

async function post(
  pathName: string,
  body: unknown,
  cookie?: string,
): Promise<Response> {
  return fetch(`${base}${pathName}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "local-auth-routes-"));
  vi.stubEnv("LOCAL_AUTH", "1");
  vi.stubEnv("AUTH_DIR", dir);
  vi.stubEnv("DOMAIN", "localhost");
  vi.stubEnv("LOCAL_AUTH_BASE", "http://localhost:9000/api");
  resetLocalAuthForTests();
  const app = express();
  app.use(express.json());
  registerLocalAuthRoutes(app);
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
  resetLocalAuthForTests();
  vi.unstubAllEnvs();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("local auth routes", () => {
  test("registers, authenticates, refreshes, and logs out", async () => {
    const register = await post("/api/auth/register", {
      username: "Alice",
      password: "correct horse",
    });
    expect(register.status).toBe(200);
    const registerBody = (await register.json()) as { jwt: string };
    expect(typeof registerBody.jwt).toBe("string");
    const cookie = cookieFrom(register);
    expect(cookie.startsWith(`${LOCAL_REFRESH_COOKIE}=`)).toBe(true);

    const me = await fetch(`${base}/api/users/@me`, {
      headers: { Authorization: `Bearer ${registerBody.jwt}` },
    });
    expect(me.status).toBe(200);
    const meBody = (await me.json()) as {
      player: { username: string };
      user: { email: string };
    };
    expect(meBody.player.username).toBe("Alice");
    expect(meBody.user.email).toBe("Alice");

    const refresh = await post("/api/auth/refresh", {}, cookie);
    expect(refresh.status).toBe(200);
    const rotated = cookieFrom(refresh);
    expect(rotated).not.toBe(cookie);

    const reuse = await post("/api/auth/refresh", {}, cookie);
    expect(reuse.status).toBe(401);

    const logout = await post("/api/auth/logout", {}, rotated);
    expect(logout.status).toBe(204);
    const afterLogout = await post("/api/auth/refresh", {}, rotated);
    expect(afterLogout.status).toBe(401);
  });

  test("rejects a duplicate username and a wrong password", async () => {
    await post("/api/auth/register", {
      username: "Alice",
      password: "correct horse",
    });
    const duplicate = await post("/api/auth/register", {
      username: "alice",
      password: "another pass",
    });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({ error: "username_taken" });

    const wrong = await post("/api/auth/login", {
      username: "Alice",
      password: "wrong password",
    });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: "invalid_credentials" });
  });

  test("serves the public JWKS", async () => {
    const response = await fetch(`${base}/api/.well-known/jwks.json`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      keys: { alg: string; crv: string; kty: string; d?: string }[];
    };
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0].alg).toBe("EdDSA");
    expect(body.keys[0].crv).toBe("Ed25519");
    expect(body.keys[0].kty).toBe("OKP");
    expect(body.keys[0].d).toBeUndefined();
  });
});
