// mermaid の配布物を daemon が配ること (DR-0010 §13): 入口と、それが相対で
// 読む chunk と LICENSE だけを、版の入った URL で immutable に配る。
import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import {
  MERMAID_ASSET_DIR,
  MERMAID_ENTRY_PATH,
  MERMAID_VERSION,
} from "../src/client/mermaid-asset.ts";
import { createWebuiApp } from "../src/index.ts";
import { findMermaidAsset } from "../src/mermaid-assets.ts";

const WebuiPackageSchema = v.object({ dependencies: v.object({ mermaid: v.string() }) });

describe("mermaid assets", () => {
  test("the version in the URL is the one package.json pins", async () => {
    const pkg = v.parse(
      WebuiPackageSchema,
      await Bun.file(new URL("../package.json", import.meta.url)).json(),
    );
    expect(pkg.dependencies.mermaid).toBe(MERMAID_VERSION);
  });

  test("the entry and every chunk it imports are served immutable", async () => {
    const app = createWebuiApp();
    const res = await app.fetch(new Request(`http://localhost${MERMAID_ENTRY_PATH}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const entry = await res.text();
    const imports = [...entry.matchAll(/["'](\.\/chunks\/[^"']+\.mjs)["']/g)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(10);
    for (const rel of new Set(imports)) {
      const url = new URL(rel ?? "", `http://localhost${MERMAID_ENTRY_PATH}`);
      const chunk = await app.fetch(new Request(url));
      expect({ rel, status: chunk.status }).toEqual({ rel, status: 200 });
    }
  });

  test("the license is served as text", async () => {
    const found = await findMermaidAsset(`${MERMAID_ASSET_DIR}LICENSE`);
    expect(found?.contentType).toBe("text/plain; charset=utf-8");
    expect(new TextDecoder().decode(found?.asset.bodies.identity)).toContain("MIT License");
  });

  test("names outside the distribution are not served", async () => {
    for (const name of [
      "package.json",
      "mermaid.min.js",
      "mermaid.esm.min.mjs.map",
      "chunks/mermaid.esm.min/../../../package.json",
      "chunks/mermaid.core/",
      "",
    ]) {
      expect({ name, found: await findMermaidAsset(MERMAID_ASSET_DIR + name) }).toEqual({
        name,
        found: null,
      });
    }
    const app = createWebuiApp();
    const res = await app.fetch(new Request(`http://localhost${MERMAID_ASSET_DIR}package.json`));
    expect(res.status).toBe(404);
  });
});
