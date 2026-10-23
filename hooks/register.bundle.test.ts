// The file Claude Code loads as the hooks module (bundle.ts): it stands
// alone, hooks.json names it, it has the module's entry, and how it is built
// depends on nothing but the source and the bundler. Whether it is the bundle
// of the source as it is now is `just check-hooks-bundle`, run with the bun
// that built it.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as v from "valibot";
import { jsonText, parseWith } from "@ccmsg/protocol/parse";
import { MODULE_BUNDLE, readBundle } from "./bundle.ts";

const HooksJsonTextSchema = jsonText(v.object({ modules: v.array(v.string()) }));

describe("the hooks module bundle", () => {
  // The module loader runs no imports.
  test("imports nothing", () => {
    const bundle = fs.readFileSync(MODULE_BUNDLE, "utf8");
    expect(bundle.match(/^\s*import\b/m)).toBeNull();
    expect(bundle.match(/\bimport\(|\brequire\(/)).toBeNull();
  });

  test("is the module hooks.json names", () => {
    const hooksJson = path.join(path.dirname(MODULE_BUNDLE), "hooks.json");
    const read = parseWith(HooksJsonTextSchema, fs.readFileSync(hooksJson, "utf8"));
    expect(read).toEqual({
      ok: true,
      value: { modules: [`./${path.basename(MODULE_BUNDLE)}`] },
    });
  });

  test("exports register", async () => {
    const loaded: unknown = await import(MODULE_BUNDLE);
    expect(parseWith(v.object({ register: v.function() }), loaded).ok).toBe(true);
  });

  test("names the bun that built it on its first line", () => {
    const read = readBundle(fs.readFileSync(MODULE_BUNDLE, "utf8"));
    expect(read?.bunVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(readBundle("export {};\n")).toBeUndefined();
  });
});

/** The bundle's body as a bun process started in `cwd` builds it. Built in
 * a process of its own: under bun 1.3.13 a `Bun.build` fails ("Unexpected
 * reading file") once its process has loaded valibot itself, which a test
 * process has. */
async function bodyBuiltIn(cwd: string): Promise<string> {
  const script = `import { bundleBody } from ${JSON.stringify(path.join(import.meta.dir, "bundle.ts"))};\nprocess.stdout.write(await bundleBody());\n`;
  const run = Bun.spawn(["bun", "-e", script], { cwd, stdout: "pipe", stderr: "pipe" });
  const [text, stderr, code] = await Promise.all([
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
    run.exited,
  ]);
  if (code !== 0) throw new Error(`building the bundle in ${cwd} exited ${code}: ${stderr}`);
  return text;
}

describe("building the bundle", () => {
  const repoRoot = path.dirname(import.meta.dir);

  test("names no file: the lines Bun writes before each module are left out", async () => {
    expect((await bodyBuiltIn(repoRoot)).match(/^\/\/ /m)).toBeNull();
  });

  // Built from another directory, the same source gives the same text.
  test("is the same text whatever the directory it is run from", async () => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-bundle-"));
    try {
      expect(await bodyBuiltIn(elsewhere)).toBe(await bodyBuiltIn(repoRoot));
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});
