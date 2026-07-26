// writeMockBin has to be a drop-in replacement for "write a script file and chmod
// +x it": the tests that use it assert on their mocks' output, exit codes and
// arguments, and those assertions are only trustworthy if the indirection through
// the shim is invisible. Each case below pins one channel between caller and mock.
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { mockScriptPath, writeMockBin } from "../src/mock-bin.ts";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-mockbin-"));
  tempDirs.push(dir);
  return dir;
}

async function run(
  bin: string,
  args: string[] = [],
  opts: { env?: Record<string, string>; stdin?: string } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = Bun.spawn([bin, ...args], {
    env: { ...process.env, ...opts.env },
    stdin: opts.stdin === undefined ? "ignore" : new TextEncoder().encode(opts.stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout as ReadableStream<Uint8Array>).text();
  const stderr = await new Response(proc.stderr as ReadableStream<Uint8Array>).text();
  return { stdout, stderr, code: await proc.exited };
}

describe("writeMockBin", () => {
  test("a /bin/sh mock branches on its arguments and reports its exit code", async () => {
    const bin = writeMockBin(
      path.join(tempDir(), "fake-tool"),
      `#!/bin/sh
case "$1" in
  greet) echo "hello $2" ;;
  fail) exit 7 ;;
  *) echo fallthrough ;;
esac
`,
    );

    expect(await run(bin, ["greet", "world"])).toMatchObject({ stdout: "hello world\n", code: 0 });
    expect((await run(bin, ["fail"])).code).toBe(7);
    expect((await run(bin, ["other"])).stdout).toBe("fallthrough\n");
  });

  // Mocks stand in for real CLIs, whose arguments routinely contain spaces (paths)
  // and characters a shell would otherwise expand. The shim passes argv through a
  // second interpreter, so word splitting and globbing are the failure mode to pin.
  test("arguments arrive verbatim, including spaces, quotes, globs and empty strings", async () => {
    const bin = writeMockBin(
      path.join(tempDir(), "fake-tool"),
      `#!/bin/sh\necho "count=$#"\nfor a in "$@"; do echo "arg=[$a]"; done\n`,
    );

    const args = ["a b", "c'd", '"e"', "*", "", "-x", "$HOME"];
    expect((await run(bin, args)).stdout).toBe(
      `count=${args.length}\n${args.map((a) => `arg=[${a}]`).join("\n")}\n`,
    );
  });

  test("stdout and stderr stay separate", async () => {
    const bin = writeMockBin(
      path.join(tempDir(), "fake-tool"),
      `#!/bin/sh\necho out\necho err 1>&2\nexit 3\n`,
    );

    expect(await run(bin)).toEqual({ stdout: "out\n", stderr: "err\n", code: 3 });
  });

  test("the environment reaches the mock", async () => {
    const bin = writeMockBin(path.join(tempDir(), "fake-tool"), `#!/bin/sh\necho "v=$MOCK_VAR"\n`);

    expect((await run(bin, [], { env: { MOCK_VAR: "set" } })).stdout).toBe("v=set\n");
  });

  // Two of the mocks in this repo are bun scripts speaking JSONL over stdin
  // (the translation helper fakes), which exercises both a non-shell shebang and
  // TypeScript source served from a file that is not named *.ts.
  test("a bun mock runs TypeScript and reads stdin", async () => {
    const bin = writeMockBin(
      path.join(tempDir(), "fake-helper"),
      `#!/usr/bin/env bun
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const request: { id: string; texts: string[] } = JSON.parse(line);
  process.stdout.write(JSON.stringify({ id: request.id, count: request.texts.length }) + "\\n");
}
`,
    );

    const stdin = JSON.stringify({ id: "r1", texts: ["a", "b"] }) + "\n";
    expect((await run(bin, [], { stdin })).stdout.trim()).toBe('{"id":"r1","count":2}');
  });

  // getRepoWsFromVcs kills a mock that does not answer in time, and asserts it was
  // killed rather than waited out. That only holds if the signal reaches the script
  // itself — the shim must exec, not linger as a parent that absorbs the signal.
  test("a signal reaches the mock's own process", async () => {
    const bin = writeMockBin(
      path.join(tempDir(), "fake-tool"),
      `#!/bin/sh\necho ready\nexec sleep 30\n`,
    );

    const proc = Bun.spawn([bin], { stdout: "pipe", stderr: "ignore" });
    await (proc.stdout as ReadableStream<Uint8Array>).getReader().read(); // it is running
    proc.kill("SIGTERM");
    expect(await proc.exited).not.toBe(0);
  });

  test("writing over an existing mock replaces its behaviour", async () => {
    const binPath = path.join(tempDir(), "fake-tool");
    writeMockBin(binPath, `#!/bin/sh\necho first\n`);
    writeMockBin(binPath, `#!/bin/sh\necho second\n`);

    expect((await run(binPath)).stdout).toBe("second\n");
  });

  // The point of the whole exercise: the file placed on disk must be a hard link to
  // the shared shim, because that is what keeps macOS from re-evaluating a new inode
  // (see the measurements in mock-bin.ts). A copy would still pass every test above
  // while quietly restoring the multi-minute stalls, so it is asserted directly.
  test("the mock is a hard link to the shared shim, and is executable", () => {
    const first = writeMockBin(path.join(tempDir(), "one"), `#!/bin/sh\nexit 0\n`);
    const second = writeMockBin(path.join(tempDir(), "two"), `#!/bin/sh\nexit 0\n`);

    const a = fs.statSync(first);
    expect(a.ino).toBe(fs.statSync(second).ino);
    expect(a.mode & 0o111).not.toBe(0);
    expect(fs.readFileSync(mockScriptPath(first), "utf8")).toBe("#!/bin/sh\nexit 0\n");
  });
});
