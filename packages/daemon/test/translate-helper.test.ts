import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createTranslateService,
  defaultTranslateHelperPaths,
  type TranslateService,
} from "../src/translate-helper.ts";

const services: TranslateService[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const service of services.splice(0)) service.stop();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function mockHelper(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-translate-mock-"));
  tempDirs.push(dir);
  const helper = path.join(dir, "helper.ts");
  fs.writeFileSync(
    helper,
    `#!/usr/bin/env bun
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const request = JSON.parse(line);
  if (request.texts.includes("__exit__")) process.exit(7);
  const results = request.texts.map((text) =>
    text === "__error__"
      ? { ok: false, error: "TranslationError.notInstalled" }
      : { ok: true, text: process.pid + ":" + text.toUpperCase() },
  );
  process.stdout.write(JSON.stringify({ id: request.id, results }) + "\\n");
}
`,
    { mode: 0o755 },
  );
  return helper;
}

describe("TranslationHelperService", () => {
  test("a non-macOS host reports an explicit unavailable error without spawning", async () => {
    const service = createTranslateService({ platform: "linux" });
    services.push(service);

    expect(await service.translate([])).toEqual({
      ok: false,
      code: "translate_unavailable",
      msg: "host translation is available only on macOS",
    });
  });

  test("a missing binary cannot be enabled when swiftc is unavailable", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-translate-missing-"));
    tempDirs.push(dir);
    const service = createTranslateService({
      platform: "darwin",
      sourcePath: path.join(dir, "main.swift"),
      binaryPath: path.join(dir, "translate-helper"),
      findSwiftc: () => null,
    });
    services.push(service);

    expect(await service.translate([])).toEqual({
      ok: false,
      code: "translate_unavailable",
      msg: "translation helper is not built and swiftc is unavailable",
    });
  });

  // The .build/ binary is gitignored and survives a repo update; one compiled
  // from an older main.swift may speak an older wire protocol (the
  // {id,text}→{id,texts} migration is exactly that). A source file newer than
  // the binary must therefore trigger a rebuild instead of trusting the stale
  // binary forever.
  test("a source file newer than the built binary triggers a rebuild before serving", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-translate-stale-"));
    tempDirs.push(dir);
    const sourcePath = path.join(dir, "main.swift");
    const binaryPath = path.join(dir, "translate-helper");
    // Stale state: binary exists but the source was modified afterwards.
    fs.writeFileSync(binaryPath, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(binaryPath, past, past);
    fs.writeFileSync(sourcePath, "// updated source");
    // Fake swiftc: writes a valid new-protocol helper to the -o target.
    const fakeSwiftc = path.join(dir, "swiftc");
    const template = mockHelper();
    fs.writeFileSync(
      fakeSwiftc,
      `#!/bin/sh\nwhile [ "$1" != "-o" ]; do shift; done\ncp ${JSON.stringify(template)} "$2"\nchmod 755 "$2"\n`,
      { mode: 0o755 },
    );
    const service = createTranslateService({
      platform: "darwin",
      sourcePath,
      binaryPath,
      findSwiftc: () => fakeSwiftc,
    });
    services.push(service);

    const result = await service.translate(["fresh"]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.results[0]).toMatchObject({ ok: true });
    // The rebuild stamps a binary at least as new as the source, so the next
    // call serves without rebuilding again (no second mtime bump needed).
    expect(fs.statSync(binaryPath).mtimeMs).toBeGreaterThanOrEqual(fs.statSync(sourcePath).mtimeMs);
  });

  test("one persistent helper process serves consecutive batches and preserves per-item errors", async () => {
    const service = createTranslateService({ platform: "darwin", binaryPath: mockHelper() });
    services.push(service);

    const first = await service.translate(["one", "__error__"]);
    const second = await service.translate(["two"]);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(first.results[1]).toEqual({ ok: false, error: "TranslationError.notInstalled" });
    expect(first.results[0]?.ok).toBe(true);
    expect(second.results[0]?.ok).toBe(true);
    if (first.results[0]?.ok && second.results[0]?.ok) {
      const firstPid = first.results[0].text.split(":", 1)[0];
      const secondPid = second.results[0].text.split(":", 1)[0];
      expect(firstPid).toBe(secondPid);
      expect(first.results[0].text.endsWith(":ONE")).toBe(true);
      expect(second.results[0].text.endsWith(":TWO")).toBe(true);
    }
  });

  // The helper's decode-error paths answer {id, results: []} — for a real
  // N-text request that is wire drift, not a translation outcome. Resolving it
  // as ok would hand callers a truncated results array (batcher item i reads
  // results[i]); the length mismatch must fail the whole call instead.
  test("a response with fewer results than requested texts fails instead of truncating", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-translate-short-"));
    tempDirs.push(dir);
    const helper = path.join(dir, "helper.ts");
    fs.writeFileSync(
      helper,
      `#!/usr/bin/env bun
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const request = JSON.parse(line);
  process.stdout.write(JSON.stringify({ id: request.id, results: [] }) + "\\n");
}
`,
      { mode: 0o755 },
    );
    const service = createTranslateService({ platform: "darwin", binaryPath: helper });
    services.push(service);

    const result = await service.translate(["a", "b"]);
    expect(result).toEqual({
      ok: false,
      code: "translate_helper_failed",
      msg: "Error: translation helper returned an invalid response",
    });
  });

  test("after the helper dies, the failed call stays failed and the next call respawns", async () => {
    const service = createTranslateService({ platform: "darwin", binaryPath: mockHelper() });
    services.push(service);

    const before = await service.translate(["before"]);
    expect(before.ok).toBe(true);
    if (!before.ok || !before.results[0]?.ok) return;
    const oldPid = before.results[0].text.split(":", 1)[0];

    const died = await service.translate(["__exit__"]);
    expect(died.ok).toBe(false);
    if (!died.ok) expect(died.code).toBe("translate_helper_failed");

    const after = await service.translate(["after"]);
    expect(after.ok).toBe(true);
    if (after.ok && after.results[0]?.ok) {
      expect(after.results[0].text.split(":", 1)[0]).not.toBe(oldPid);
      expect(after.results[0].text.endsWith(":AFTER")).toBe(true);
    }
  });
});

// The real helper test is deliberately gated by the generated binary. Linux CI
// and a fresh checkout do not build it; a macOS developer who ran the build
// recipe exercises Translation.framework itself in the normal bun test suite.
const helperBinary = defaultTranslateHelperPaths().binary;
const realHelperTest = fs.existsSync(helperBinary) ? test : test.skip;
realHelperTest("the built Swift helper translates a mixed-text batch over JSONL", async () => {
  const proc = Bun.spawn([helperBinary], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const stdin = proc.stdin as Bun.FileSink;
  await stdin.write(
    JSON.stringify({
      id: "mixed",
      texts: ["The build completed successfully.ここから日本語です。", "これは日本語です。"],
    }) + "\n",
  );
  await stdin.end();
  const output = await new Response(proc.stdout as ReadableStream<Uint8Array>).text();
  const stderr = await new Response(proc.stderr as ReadableStream<Uint8Array>).text();
  expect(await proc.exited).toBe(0);
  expect(stderr).toBe("");
  const response = JSON.parse(output.trim());
  expect(response.id).toBe("mixed");
  expect(response.results).toHaveLength(2);
  expect(response.results[0].ok).toBe(true);
  expect(response.results[0].text).toContain("ここから日本語です。");
  expect(response.results[0].text).not.toContain("The build completed successfully.");
  expect(response.results[1].ok).toBe(true);
  expect(response.results[1].text).toBe("これは日本語です。");
});
