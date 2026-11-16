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
  options: { cookie?: string; bearer?: string } = {},
): Promise<Response> {
  return fetch(`${base}${pathName}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(options.cookie ? { Cookie: options.cookie } : {}),
      ...(options.bearer ? { Authorization: `Bearer ${options.bearer}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function get(pathName: string, bearer?: string): Promise<Response> {
  return fetch(`${base}${pathName}`, {
    headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
  });
}

type RegisterBody = { jwt: string; recoveryCode: string };

async function register(
  username = "Alice",
  password = "correct horse",
): Promise<RegisterBody> {
  const response = await post("/api/auth/register", { username, password });
  expect(response.status).toBe(200);
  return (await response.json()) as RegisterBody;
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "local-auth-reset-routes-"));
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

describe("forgot-password reset route", () => {
  test("resets with the recovery code, signs in, and rotates the code", async () => {
    const registered = await register();
    expect(registered.recoveryCode).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){4}$/);

    const reset = await post("/api/auth/reset", {
      username: "alice",
      recoveryCode: registered.recoveryCode.toLowerCase(),
      newPassword: "battery staple",
    });
    expect(reset.status).toBe(200);
    const body = (await reset.json()) as {
      jwt: string;
      recoveryCode: string;
    };
    expect(typeof body.jwt).toBe("string");
    expect(body.recoveryCode).not.toBe(registered.recoveryCode);
    const cookie = cookieFrom(reset);
    expect(cookie.startsWith(`${LOCAL_REFRESH_COOKIE}=`)).toBe(true);

    // The reset cookie is a live session.
    const refresh = await post("/api/auth/refresh", {}, { cookie });
    expect(refresh.status).toBe(200);

    // The old password is gone, the new one works.
    const oldLogin = await post("/api/auth/login", {
      username: "Alice",
      password: "correct horse",
    });
    expect(oldLogin.status).toBe(401);
    const newLogin = await post("/api/auth/login", {
      username: "Alice",
      password: "battery staple",
    });
    expect(newLogin.status).toBe(200);

    // The used code cannot be replayed.
    const replay = await post("/api/auth/reset", {
      username: "Alice",
      recoveryCode: registered.recoveryCode,
      newPassword: "another password",
    });
    expect(replay.status).toBe(401);
    expect(await replay.json()).toEqual({ error: "invalid_recovery_code" });
  });

  test("uses one error for a wrong code and an unknown account", async () => {
    await register();
    const wrong = await post("/api/auth/reset", {
      username: "Alice",
      recoveryCode: "AAAA-BBBB-CCCC-DDDD-EEEE",
      newPassword: "battery staple",
    });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: "invalid_recovery_code" });

    const unknown = await post("/api/auth/reset", {
      username: "Nobody",
      recoveryCode: "AAAA-BBBB-CCCC-DDDD-EEEE",
      newPassword: "battery staple",
    });
    expect(unknown.status).toBe(401);
    expect(await unknown.json()).toEqual({ error: "invalid_recovery_code" });
  });

  test("rejects a malformed body and an invalid new password", async () => {
    const registered = await register();
    const missing = await post("/api/auth/reset", {
      username: "Alice",
      newPassword: "battery staple",
    });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: "invalid_request" });

    const short = await post("/api/auth/reset", {
      username: "Alice",
      recoveryCode: registered.recoveryCode,
      newPassword: "short",
    });
    expect(short.status).toBe(400);
    expect(await short.json()).toEqual({ error: "invalid_password" });
  });

  test("locks the account after five failed codes", async () => {
    const registered = await register();
    for (let i = 0; i < 5; i++) {
      const wrong = await post("/api/auth/reset", {
        username: "Alice",
        recoveryCode: "AAAA-BBBB-CCCC-DDDD-EEEE",
        newPassword: "battery staple",
      });
      expect(wrong.status).toBe(401);
    }
    const throttled = await post("/api/auth/reset", {
      username: "Alice",
      recoveryCode: registered.recoveryCode,
      newPassword: "battery staple",
    });
    expect(throttled.status).toBe(429);
    expect(await throttled.json()).toEqual({ error: "rate_limited" });
  });
});

describe("signed-in password routes", () => {
  test("changes the password with the current one and needs a bearer token", async () => {
    const registered = await register();

    const unauthenticated = await post("/api/auth/password", {
      currentPassword: "correct horse",
      newPassword: "battery staple",
    });
    expect(unauthenticated.status).toBe(401);
    expect(await unauthenticated.json()).toEqual({ error: "unauthorized" });

    const wrong = await post(
      "/api/auth/password",
      { currentPassword: "wrong password", newPassword: "battery staple" },
      { bearer: registered.jwt },
    );
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({
      error: "invalid_current_password",
    });

    const changed = await post(
      "/api/auth/password",
      { currentPassword: "correct horse", newPassword: "battery staple" },
      { bearer: registered.jwt },
    );
    expect(changed.status).toBe(200);
    expect(await changed.json()).toEqual({ ok: true });

    const newLogin = await post("/api/auth/login", {
      username: "Alice",
      password: "battery staple",
    });
    expect(newLogin.status).toBe(200);
    const oldLogin = await post("/api/auth/login", {
      username: "Alice",
      password: "correct horse",
    });
    expect(oldLogin.status).toBe(401);
  });

  test("reports recovery-code state and regenerates with the current password", async () => {
    const registered = await register();

    const status = await get("/api/auth/recovery", registered.jwt);
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ enabled: true });

    const unauthorized = await get("/api/auth/recovery");
    expect(unauthorized.status).toBe(401);

    const wrong = await post(
      "/api/auth/recovery",
      { currentPassword: "wrong password" },
      { bearer: registered.jwt },
    );
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({
      error: "invalid_current_password",
    });

    const regenerated = await post(
      "/api/auth/recovery",
      { currentPassword: "correct horse" },
      { bearer: registered.jwt },
    );
    expect(regenerated.status).toBe(200);
    const body = (await regenerated.json()) as { recoveryCode: string };
    expect(body.recoveryCode).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){4}$/);
    expect(body.recoveryCode).not.toBe(registered.recoveryCode);

    // The replaced code no longer resets the account.
    const oldCode = await post("/api/auth/reset", {
      username: "Alice",
      recoveryCode: registered.recoveryCode,
      newPassword: "battery staple",
    });
    expect(oldCode.status).toBe(401);
    const newCode = await post("/api/auth/reset", {
      username: "Alice",
      recoveryCode: body.recoveryCode,
      newPassword: "battery staple",
    });
    expect(newCode.status).toBe(200);
  });
});
