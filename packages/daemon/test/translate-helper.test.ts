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
  if (request.text === "__exit__") process.exit(7);
  const response = request.text === "__error__"
    ? { id: request.id, ok: false, error: "TranslationError.notInstalled" }
    : { id: request.id, ok: true, text: process.pid + ":" + request.text.toUpperCase() };
  process.stdout.write(JSON.stringify(response) + "\\n");
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
realHelperTest("the built Swift helper translates mixed text over JSONL", async () => {
  const proc = Bun.spawn([helperBinary], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const stdin = proc.stdin as Bun.FileSink;
  await stdin.write(
    JSON.stringify({
      id: "mixed",
      text: "The build completed successfully.ここから日本語です。",
    }) + "\n",
  );
  await stdin.end();
  const output = await new Response(proc.stdout as ReadableStream<Uint8Array>).text();
  const stderr = await new Response(proc.stderr as ReadableStream<Uint8Array>).text();
  expect(await proc.exited).toBe(0);
  expect(stderr).toBe("");
  const response = JSON.parse(output.trim());
  expect(response.id).toBe("mixed");
  expect(response.ok).toBe(true);
  expect(response.text).toContain("ここから日本語です。");
  expect(response.text).not.toContain("The build completed successfully.");
});
