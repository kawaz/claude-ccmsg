// Fork capability probe: can this host's `claude` take `--resume-session-at`?
// The option is undocumented (absent from `claude --help`), so the answer can
// only come from running the binary and reading how it refuses.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { interpretForkProbe, probeForkSupport } from "../src/fork-probe.ts";

describe("interpretForkProbe", () => {
  // The exact commander wording an unsupported build produces (observed on a
  // stub-free run against claude 2.1.227 with a bogus option).
  test("commander's unknown-option refusal means unsupported", () => {
    expect(interpretForkProbe("error: unknown option '--resume-session-at'\n", null)).toMatchObject(
      { available: false },
    );
  });

  // A supported build gets past option parsing and dies at session lookup —
  // the probe's session id is all zeros precisely so it always dies there.
  test("a session-lookup failure means supported", () => {
    expect(
      interpretForkProbe("No conversation found with session ID: 00000000-…\n", null),
    ).toMatchObject({ available: true });
  });

  // Some *other* option going unknown says nothing about this one, so the
  // match is anchored to the option name rather than the phrase alone.
  test("an unknown-option refusal naming a different option is not our answer", () => {
    expect(interpretForkProbe("error: unknown option '--print'\n", null)).toMatchObject({
      available: true,
    });
  });

  // A probe we had to kill answered nothing; treating that as "supported"
  // would offer a fork button on a host whose claude never responds.
  test("a killed probe is unsupported", () => {
    expect(interpretForkProbe("", "SIGKILL")).toMatchObject({ available: false });
  });
});

describe("probeForkSupport", () => {
  let dir: string;
  let env: Record<string, string | undefined>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-fork-probe-"));
    env = { ...process.env, PATH: dir };
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Install a `claude` stub that records its argv and answers on stderr. */
  function stubClaude(script: string): string {
    const argvLog = path.join(dir, "argv");
    const bin = path.join(dir, "claude");
    fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > ${argvLog}\n${script}\n`);
    fs.chmodSync(bin, 0o755);
    return argvLog;
  }

  // The whole point of the probe: a build that knows the option is usable for
  // fork launches, and the probe reaches it with the option under test plus a
  // guaranteed-unresolvable session id (so nothing is ever really resumed).
  test("a claude that gets past option parsing reports available", async () => {
    const argvLog = stubClaude('echo "No conversation found with session ID: x" >&2\nexit 1');
    expect(await probeForkSupport(env)).toMatchObject({ available: true });
    const argv = fs.readFileSync(argvLog, "utf8").trim().split("\n");
    expect(argv).toContain("--resume-session-at=00000000-0000-0000-0000-000000000000");
    expect(argv).toContain("--print");
  });

  test("a claude that rejects the option reports unavailable", async () => {
    stubClaude("echo \"error: unknown option '--resume-session-at'\" >&2\nexit 1");
    expect(await probeForkSupport(env)).toMatchObject({ available: false });
  });

  // No claude at all is the same answer as an unsupported one — such a host
  // cannot launch a fork either — and must not throw into daemon startup.
  test("an unrunnable claude reports unavailable instead of throwing", async () => {
    expect(await probeForkSupport(env)).toMatchObject({ available: false });
  });
});
