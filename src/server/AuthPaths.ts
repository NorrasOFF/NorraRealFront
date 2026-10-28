import path from "path";

// Shared location for self-hosted account data (accounts.json, the JWT key and
// the ranked ratings store). AUTH_DIR is set in Docker/fly so the volume mount
// survives restarts; local dev falls back to ./auth-data.
export function authDataDir(): string {
  return process.env.AUTH_DIR ?? path.join(process.cwd(), "auth-data");
}
