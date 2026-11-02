import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

describe("Modal router markup", () => {
  it("declares every router-registered modal in index.html", () => {
    const main = fs.readFileSync(
      path.join(process.cwd(), "src/client/Main.ts"),
      "utf8",
    );
    const html = fs.readFileSync(
      path.join(process.cwd(), "index.html"),
      "utf8",
    );

    const pattern =
      /modalRouter\.register\(\s*"[^"]+",\s*\{\s*tag:\s*"([^"]+)"/g;
    const tags = [...main.matchAll(pattern)].map((match) => match[1]);

    expect(tags.length).toBeGreaterThan(0);
    for (const tag of tags) {
      expect(
        html,
        `${tag} is registered but not declared in index.html`,
      ).toContain(`<${tag}`);
    }
  });
});
