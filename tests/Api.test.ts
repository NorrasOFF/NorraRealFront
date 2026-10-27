import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getApiBase, getAudience } from "../src/client/Api";
import { ClientEnv } from "../src/client/ClientEnv";

function setConfig(
  jwtAudience: string,
  extra: { localAuth?: boolean; apiBase?: string } = {},
) {
  (window as any).BOOTSTRAP_CONFIG = {
    gameEnv: "prod",
    numWorkers: 1,
    turnstileSiteKey: "x",
    jwtAudience,
    instanceId: "desktop",
    gitCommit: "test",
    ...extra,
  };
  ClientEnv.reset();
}

// setConfig sets window.BOOTSTRAP_CONFIG; clear it (and the cached env) after
// every test so a stray value can't leak into a later test.
afterEach(() => {
  delete (window as any).BOOTSTRAP_CONFIG;
  ClientEnv.reset();
});

describe("getApiBase localhost fallback", () => {
  beforeEach(() => {
    localStorage.clear();
    // getAudience() now reads the audience from BOOTSTRAP_CONFIG, so the
    // localhost branch is reached via jwtAudience "localhost".
    setConfig("localhost");
  });

  // API_DOMAIN is forced empty under vitest via the vite.config `define`, so this
  // regression test exercises the fallback branch deterministically regardless of
  // any API_DOMAIN in the host shell / CI.
  it("falls back to http://localhost:8787 on localhost when apiHost is not set and API_DOMAIN is empty", () => {
    expect(getApiBase()).toBe("http://localhost:8787");
  });
});

describe("getAudience / getApiBase from BOOTSTRAP_CONFIG", () => {
  beforeEach(() => ClientEnv.reset());

  it("returns the configured audience (desktop staging)", () => {
    setConfig("openfront.dev");
    expect(getAudience()).toBe("openfront.dev");
    expect(getApiBase()).toBe("https://api.openfront.dev");
  });

  it("returns the configured audience (prod)", () => {
    setConfig("openfront.io");
    expect(getAudience()).toBe("openfront.io");
    expect(getApiBase()).toBe("https://api.openfront.io");
  });
});

describe("getApiBase local auth", () => {
  beforeEach(() => ClientEnv.reset());

  it("uses the injected local auth base", () => {
    setConfig("openfront.io", {
      localAuth: true,
      apiBase: "https://openfrontio.fly.dev/api",
    });
    expect(getApiBase()).toBe("https://openfrontio.fly.dev/api");
    expect(ClientEnv.jwtIssuer()).toBe("https://openfrontio.fly.dev/api");
  });

  it("falls back to the document origin plus /api", () => {
    setConfig("openfront.io", { localAuth: true });
    expect(getApiBase()).toBe(`${window.location.origin}/api`);
  });

  it("keeps the upstream API base when local auth is off", () => {
    setConfig("openfront.io");
    expect(getApiBase()).toBe("https://api.openfront.io");
  });
});
