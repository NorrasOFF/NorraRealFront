import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import { MAX_SAVE_IMPORT_BYTES } from "../src/server/SaveImport";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NGINX_CONF = path.resolve(__dirname, "../nginx.conf");

// Parse a `client_max_body_size` value such as "70m" / "512k" / "1048576" into
// bytes. nginx uses binary units (k = 1024), case-insensitive.
function toBytes(value: string): number {
  const match = /^(\d+)([kmg]?)$/i.exec(value.trim());
  if (match === null) {
    throw new Error(`unparseable client_max_body_size: ${value}`);
  }
  const n = Number(match[1]);
  switch (match[2].toLowerCase()) {
    case "k":
      return n * 1024;
    case "m":
      return n * 1024 * 1024;
    case "g":
      return n * 1024 * 1024 * 1024;
    default:
      return n;
  }
}

// A save file is POSTed whole to /wN/api/saves/import. If nginx's body limit is
// below the worker's own cap, a large (multi-player) save is rejected with a
// 413 before it ever reaches the app, which surfaces as the generic "Failed to
// import that file as a resumable lobby" toast. Regression guard for that.
describe("nginx body size", () => {
  it("allows an import at least as large as the worker's cap", () => {
    const conf = fs.readFileSync(NGINX_CONF, "utf8");
    const values = [
      ...conf.matchAll(/client_max_body_size\s+([0-9]+[kmg]?)\s*;/gi),
    ];
    expect(values.length).toBeGreaterThan(0);
    const largest = Math.max(...values.map((m) => toBytes(m[1])));
    expect(largest).toBeGreaterThanOrEqual(MAX_SAVE_IMPORT_BYTES);
  });
});
