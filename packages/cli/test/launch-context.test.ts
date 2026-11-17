// `ccmsg launch-context`: what a launch command asks it (the options) and what
// it prints. Which session it names is the daemon's launch-context.test.ts;
// here the CLI's reading of the options and its one JSON line, run as a
// launch command runs it: in the launch's cwd, under the launch's config dir.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { projectSlug } from "@ccmsg/daemon/launch-context";
import { readLaunchContextAsk } from "../src/launch-context.ts";
import { perTestTmpDir } from "../../testkit/src/tmp.ts";
import { runCli } from "./run-cli.ts";

const tmp = perTestTmpDir();
const SID = "aaaaaaaa-0000-4000-8000-000000000001";

describe("readLaunchContextAsk", () => {
  test("a continue, -p or not, and a resume, with the model and effort named", () => {
    expect(readLaunchContextAsk([], { continue: true })).toEqual({
      ok: true,
      ask: { continue: "interactive" },
    });
    expect(readLaunchContextAsk([], { continue: true, print: true, effort: "high" })).toEqual({
      ok: true,
      ask: { continue: "print", effort: "high" },
    });
    // a model as claude takes it is read as the model a launch names
    expect(readLaunchContextAsk([], { resume: SID, model: "opus[1m]" })).toEqual({
      ok: true,
      ask: { resume: SID, model: "opus" },
    });
  });

  test("options that do not make one ask are refused, with the usage", () => {
    const reason = (
      positionals: string[],
      opts: Record<string, string | boolean>,
    ): string | undefined => {
      const read = readLaunchContextAsk(positionals, opts);
      return read.ok ? undefined : read.reason;
    };
    expect(reason([], {})).toContain("--continue or --resume <session-id> is needed");
    expect(reason([], { continue: true, resume: SID })).toContain("do not go together");
    expect(reason([], { resume: SID, print: true })).toContain("--print goes with --continue");
    expect(reason([], { resume: "not-a-uuid" })).toContain("a lowercase uuid");
    expect(reason([], { resume: true })).toContain("a lowercase uuid");
    expect(reason([], { continue: true, model: "gpt" })).toContain("--model names no model");
    expect(reason([], { continue: true, effort: "huge" })).toContain("--effort names no effort");
    expect(reason([], { continue: true, model: true })).toContain("--model names no model");
    expect(reason(["x"], { continue: true })).toContain('unexpected argument "x"');
    expect(reason([], { continue: true, cwd: "/x" })).toContain("unknown option --cwd");
    expect(reason([], { continue: true })).toBeUndefined();
    expect(reason([], { continue: true, resume: SID })).toContain("usage: ccmsg launch-context");
  });
});

describe("ccmsg launch-context", () => {
  test("prints the session a continue in its cwd carries on, under CLAUDE_CONFIG_DIR", async () => {
    const base = fs.realpathSync(tmp("ccmsg-cli-launch-context-"));
    const cwd = path.join(base, "proj");
    fs.mkdirSync(cwd);
    const cfg = path.join(base, "cfg");
    const dir = path.join(cfg, "projects", projectSlug(cwd));
    fs.mkdirSync(dir, { recursive: true });
    const env = { CLAUDE_CONFIG_DIR: cfg };
    expect(await runCli(["launch-context", "--continue"], env, cwd)).toEqual({
      out: '{"ok":true}\n',
      err: "",
      code: 0,
    });
    const rows = [
      { type: "user", parentUuid: null, isSidechain: false, entrypoint: "cli", cwd },
      {
        type: "assistant",
        parentUuid: "u",
        isSidechain: false,
        message: { model: "claude-haiku-4" },
        effort: "low",
      },
    ];
    fs.writeFileSync(path.join(dir, `${SID}.jsonl`), rows.map((r) => JSON.stringify(r)).join("\n"));
    expect(await runCli(["launch-context", "--continue"], env, cwd)).toEqual({
      out: `{"ok":true,"session_id":"${SID}","model":"haiku","effort":"low"}\n`,
      err: "",
      code: 0,
    });
    expect(await runCli(["launch-context", "--resume", SID, "--model", "haiku"], env, cwd)).toEqual(
      {
        out: `{"ok":true,"session_id":"${SID}","effort":"low"}\n`,
        err: "",
        code: 0,
      },
    );
  });

  test("options that do not read: exit 1 with the reason, nothing on stdout", async () => {
    const run = await runCli(["launch-context", "--resume", "x"], {});
    expect(run.code).toBe(1);
    expect(run.out).toBe("");
    expect(run.err).toContain("ccmsg: --resume takes a session id");
  });

  // Like sidecar, a command for launch commands rather than people: the full
  // reference names it, the minimal rail does not.
  test("--help prints its own help, and the full reference names it", async () => {
    const own = await runCli(["launch-context", "--help"], {});
    expect(own.code).toBe(0);
    expect(own.out).toContain("Usage:\n  ccmsg launch-context (--continue [--print] | --resume");
    const top = await runCli(["--help-full"], {});
    expect(top.out).toContain("launch-context");
    expect((await runCli([], {})).out).not.toContain("launch-context");
  });
});
