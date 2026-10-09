// The file Claude Code loads as the hooks module (bundle.ts): it stands
// alone, hooks.json names it, and it has the module's entry. Whether it is
// the bundle of the source as it is now is `just check-hooks-bundle`.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as v from "valibot";
import { parseJsonWith, parseWith } from "@ccmsg/protocol/parse";
import { MODULE_BUNDLE } from "./bundle.ts";

const HooksJsonSchema = v.object({ modules: v.array(v.string()) });

describe("the hooks module bundle", () => {
  // The module loader runs no imports.
  test("imports nothing", () => {
    const bundle = fs.readFileSync(MODULE_BUNDLE, "utf8");
    expect(bundle.match(/^\s*import\b/m)).toBeNull();
    expect(bundle.match(/\bimport\(|\brequire\(/)).toBeNull();
  });

  test("is the module hooks.json names", () => {
    const hooksJson = path.join(path.dirname(MODULE_BUNDLE), "hooks.json");
    const read = parseJsonWith(HooksJsonSchema, fs.readFileSync(hooksJson, "utf8"));
    expect(read).toEqual({
      ok: true,
      value: { modules: [`./${path.basename(MODULE_BUNDLE)}`] },
    });
  });

  test("exports register", async () => {
    const loaded: unknown = await import(MODULE_BUNDLE);
    expect(parseWith(v.object({ register: v.function() }), loaded).ok).toBe(true);
  });
});
