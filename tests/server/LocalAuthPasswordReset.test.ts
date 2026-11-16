// @vitest-environment node
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  LocalAuthStore,
  normalizeRecoveryCode,
  resetLocalAuthForTests,
} from "../../src/server/LocalAuth";

const BASE = "http://localhost:9000/api";
const AUDIENCE = "localhost";

let dir: string;
let store: LocalAuthStore;

beforeEach(async () => {
  resetLocalAuthForTests();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "local-auth-reset-"));
  store = new LocalAuthStore(dir, BASE, AUDIENCE);
});

afterEach(async () => {
  resetLocalAuthForTests();
  await fs.rm(dir, { recursive: true, force: true });
});

async function accountsFile(): Promise<{
  accounts: {
    username: string;
    passwordHash: string;
    sessions: { tokenHash: string }[];
    recovery?: { hash: string };
  }[];
}> {
  return JSON.parse(await fs.readFile(path.join(dir, "accounts.json"), "utf8"));
}

describe("recovery codes", () => {
  test("registration returns a grouped code and stores only its hash", async () => {
    const tokens = await store.register("Alice", "correct horse");
    expect(tokens.recoveryCode).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){4}$/);

    const raw = await fs.readFile(path.join(dir, "accounts.json"), "utf8");
    expect(raw).not.toContain(tokens.recoveryCode);
    expect(raw).not.toContain(normalizeRecoveryCode(tokens.recoveryCode));
    const file = await accountsFile();
    expect(file.accounts[0].recovery?.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("normalizes case and separators", () => {
    const code = "abcd-efgh-jklm-npqr-stuv";
    expect(normalizeRecoveryCode(code)).toBe("ABCDEFGHJKLMNPQRSTUV");
    expect(normalizeRecoveryCode("ABCD EFGH/JKLM_NPQR.STUV")).toBe(
      "ABCDEFGHJKLMNPQRSTUV",
    );
  });

  test("resets the password, signs the account in, and rotates the code", async () => {
    const registered = await store.register("Alice", "correct horse");
    const subsequent = await store.login("Alice", "correct horse");

    const reset = await store.resetPasswordWithRecoveryCode(
      "alice",
      registered.recoveryCode.toLowerCase(),
      "battery staple",
    );

    // Old password and old sessions are dead; the new password works.
    await expect(store.login("Alice", "correct horse")).rejects.toMatchObject({
      code: "invalid_credentials",
    });
    await expect(store.refresh(subsequent.refreshToken)).rejects.toMatchObject({
      code: "invalid_credentials",
    });
    await store.login("Alice", "battery staple");

    // The returned session is live and belongs to the same account.
    await expect(store.refresh(reset.refreshToken)).resolves.toMatchObject({
      account: { username: "Alice" },
    });

    // The code that was used no longer works; the new one does.
    await expect(
      store.resetPasswordWithRecoveryCode(
        "Alice",
        registered.recoveryCode,
        "another password",
      ),
    ).rejects.toMatchObject({ code: "invalid_recovery_code" });
    await expect(
      store.resetPasswordWithRecoveryCode(
        "Alice",
        reset.recoveryCode,
        "another password",
      ),
    ).resolves.toMatchObject({ recoveryCode: expect.any(String) });
  });

  test("rejects a wrong code without changing the password", async () => {
    await store.register("Alice", "correct horse");
    await expect(
      store.resetPasswordWithRecoveryCode(
        "Alice",
        "AAAA-BBBB-CCCC-DDDD-EEEE",
        "battery staple",
      ),
    ).rejects.toMatchObject({ code: "invalid_recovery_code", status: 401 });
    await store.login("Alice", "correct horse");
  });

  test("rejects an unknown username with the same error", async () => {
    await expect(
      store.resetPasswordWithRecoveryCode(
        "Nobody",
        "AAAA-BBBB-CCCC-DDDD-EEEE",
        "battery staple",
      ),
    ).rejects.toMatchObject({ code: "invalid_recovery_code", status: 401 });
  });

  test("throttles repeated failures, then lets a correct code through later", async () => {
    const tokens = await store.register("Alice", "correct horse");
    for (let i = 0; i < 5; i++) {
      await expect(
        store.resetPasswordWithRecoveryCode(
          "Alice",
          "AAAA-BBBB-CCCC-DDDD-EEEE",
          "battery staple",
        ),
      ).rejects.toMatchObject({ code: "invalid_recovery_code" });
    }
    await expect(
      store.resetPasswordWithRecoveryCode(
        "Alice",
        tokens.recoveryCode,
        "battery staple",
      ),
    ).rejects.toMatchObject({ code: "rate_limited", status: 429 });

    // A different account is unaffected by Alice's failures.
    const bob = await store.register("Bob", "correct horse");
    await expect(
      store.resetPasswordWithRecoveryCode(
        "Bob",
        bob.recoveryCode,
        "battery staple",
      ),
    ).resolves.toMatchObject({ recoveryCode: expect.any(String) });
  });
});

describe("signed-in password change", () => {
  test("requires the current password", async () => {
    const tokens = await store.register("Alice", "correct horse");
    await expect(
      store.changePassword(
        tokens.account.id,
        "wrong password",
        "battery staple",
      ),
    ).rejects.toMatchObject({
      code: "invalid_current_password",
      status: 401,
    });
    await store.login("Alice", "correct horse");
  });

  test("revokes other devices but keeps the requesting session", async () => {
    const first = await store.register("Alice", "correct horse");
    const second = await store.login("Alice", "correct horse");

    await store.changePassword(
      first.account.id,
      "correct horse",
      "battery staple",
      second.refreshToken,
    );

    await expect(store.refresh(first.refreshToken)).rejects.toMatchObject({
      code: "invalid_credentials",
    });
    await expect(store.refresh(second.refreshToken)).resolves.toMatchObject({
      account: { username: "Alice" },
    });
    await store.login("Alice", "battery staple");
    await expect(store.login("Alice", "correct horse")).rejects.toMatchObject({
      code: "invalid_credentials",
    });
  });

  test("a stolen JWT cannot change the password without the current one", async () => {
    const tokens = await store.register("Alice", "correct horse");
    // The route resolves the account from the verified JWT subject, never from
    // the request body, so the current password is the only remaining proof.
    await expect(
      store.changePassword(tokens.account.id, "wrong", "battery staple"),
    ).rejects.toMatchObject({ code: "invalid_current_password" });
    await store.login("Alice", "correct horse");
  });
});

describe("recovery code regeneration", () => {
  test("replaces the old code and requires the current password", async () => {
    const tokens = await store.register("Alice", "correct horse");
    await expect(
      store.regenerateRecoveryCode(tokens.account.id, "wrong password"),
    ).rejects.toMatchObject({ code: "invalid_current_password" });

    const next = await store.regenerateRecoveryCode(
      tokens.account.id,
      "correct horse",
    );
    expect(next).not.toBe(tokens.recoveryCode);
    expect(await store.hasRecoveryCode(tokens.account.id)).toBe(true);

    await expect(
      store.resetPasswordWithRecoveryCode(
        "Alice",
        tokens.recoveryCode,
        "battery staple",
      ),
    ).rejects.toMatchObject({ code: "invalid_recovery_code" });
    await expect(
      store.resetPasswordWithRecoveryCode("Alice", next, "battery staple"),
    ).resolves.toMatchObject({ recoveryCode: expect.any(String) });
  });

  test("accounts created before the feature have no code and can gain one", async () => {
    const tokens = await store.register("Alice", "correct horse");
    const file = await accountsFile();
    delete file.accounts[0].recovery;
    await fs.writeFile(
      path.join(dir, "accounts.json"),
      JSON.stringify(file, null, 2),
    );

    const reloaded = new LocalAuthStore(dir, BASE, AUDIENCE);
    expect(await reloaded.hasRecoveryCode(tokens.account.id)).toBe(false);
    await expect(
      reloaded.resetPasswordWithRecoveryCode(
        "Alice",
        "AAAA-BBBB-CCCC-DDDD-EEEE",
        "battery staple",
      ),
    ).rejects.toMatchObject({ code: "invalid_recovery_code" });

    const code = await reloaded.regenerateRecoveryCode(
      tokens.account.id,
      "correct horse",
    );
    await expect(
      reloaded.resetPasswordWithRecoveryCode("Alice", code, "battery staple"),
    ).resolves.toMatchObject({ recoveryCode: expect.any(String) });
  });
});

describe("admin reset", () => {
  test("retires the recovery code", async () => {
    const tokens = await store.register("Alice", "correct horse");
    await store.resetAccountPassword("Alice", "admin chosen");
    expect(await store.hasRecoveryCode(tokens.account.id)).toBe(false);
    await expect(
      store.resetPasswordWithRecoveryCode(
        "Alice",
        tokens.recoveryCode,
        "battery staple",
      ),
    ).rejects.toMatchObject({ code: "invalid_recovery_code" });
    await store.login("Alice", "admin chosen");
  });
});
