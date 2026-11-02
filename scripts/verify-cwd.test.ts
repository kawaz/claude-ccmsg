// scripts/verify-cwd.ts を子プロセスで実行してブラックボックス検証する。プールの
// root は CCMSG_VERIFY_CWD_POOL でテストごとの一時 dir に向け、実際の
// ~/.local/state/ccmsg/tmp-test-trusted-dirs には触れない。
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as v from "valibot";
import { perTestTmpDir } from "../packages/testkit/src/tmp.ts";

const SCRIPT = fileURLToPath(new URL("./verify-cwd.ts", import.meta.url));

const tmpDir = perTestTmpDir();

interface Run {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function env(pool: string): Record<string, string | undefined> {
  return { ...process.env, CCMSG_VERIFY_CWD_POOL: pool };
}

function run(pool: string, ...args: string[]): Run {
  const result = Bun.spawnSync(["bun", SCRIPT, ...args], {
    env: env(pool),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

async function runAsync(pool: string, ...args: string[]): Promise<Run> {
  const proc = Bun.spawn(["bun", SCRIPT, ...args], {
    env: env(pool),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

function gitOut(cwd: string, ...args: string[]): string {
  return Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe" })
    .stdout.toString()
    .trim();
}

/** A pool root that does not exist yet, under a temp dir reached through its realpath. */
function freshPool(): string {
  return path.join(fs.realpathSync(tmpDir("verify-cwd-")), "pool");
}

describe("acquire", () => {
  test("hands out 01 as an empty git repo of its own, under a root that is a repo ignoring everything", () => {
    const pool = freshPool();
    const r = run(pool, "acquire");
    expect(r).toMatchObject({ exitCode: 0, stderr: "" });
    const cwd = r.stdout.trim();
    expect(cwd).toBe(path.join(pool, "01"));
    expect(gitOut(cwd, "rev-parse", "--show-toplevel")).toBe(cwd);
    expect(fs.readdirSync(cwd)).toEqual([".git"]);
    expect(gitOut(pool, "rev-parse", "--show-toplevel")).toBe(pool);
    expect(fs.readFileSync(path.join(pool, ".gitignore"), "utf8")).toBe("*\n");
    expect(gitOut(pool, "status", "--porcelain", "--untracked-files=all")).toBe("");
  });

  test("skips a cwd in use and takes the next free one", () => {
    const pool = freshPool();
    expect(run(pool, "acquire").stdout.trim()).toBe(path.join(pool, "01"));
    expect(run(pool, "acquire").stdout.trim()).toBe(path.join(pool, "02"));
  });

  test("empties a released cwd before handing it out again", () => {
    const pool = freshPool();
    const cwd = run(pool, "acquire").stdout.trim();
    fs.writeFileSync(path.join(cwd, "left-by-the-last-run"), "");
    expect(run(pool, "release", "01").exitCode).toBe(0);
    expect(run(pool, "acquire").stdout.trim()).toBe(cwd);
    expect(fs.readdirSync(cwd)).toEqual([".git"]);
  });

  test("two at once on a pool not yet made get different cwds and one root repo", async () => {
    const pool = freshPool();
    const [a, b] = await Promise.all([runAsync(pool, "acquire"), runAsync(pool, "acquire")]);
    expect(a).toMatchObject({ exitCode: 0, stderr: "" });
    expect(b).toMatchObject({ exitCode: 0, stderr: "" });
    expect([a.stdout.trim(), b.stdout.trim()].toSorted()).toEqual([
      path.join(pool, "01"),
      path.join(pool, "02"),
    ]);
    expect(gitOut(pool, "rev-parse", "--show-toplevel")).toBe(pool);
    expect(fs.readdirSync(pool).filter((name) => name.startsWith(".guard-"))).toEqual([]);
  });

  test("fails with exit 1 when every cwd is in use", () => {
    const pool = freshPool();
    run(pool, "acquire");
    for (let n = 2; n <= 50; n++)
      fs.mkdirSync(path.join(pool, `${String(n).padStart(2, "0")}.lock`));
    const r = run(pool, "acquire");
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("all 50 cwds are in use");
  });
});

describe("release", () => {
  test("frees the cwd for the next acquire", () => {
    const pool = freshPool();
    run(pool, "acquire");
    run(pool, "acquire");
    expect(run(pool, "release", "01")).toMatchObject({ exitCode: 0, stdout: "", stderr: "" });
    expect(run(pool, "acquire").stdout.trim()).toBe(path.join(pool, "01"));
  });

  test("fails with exit 1 for a cwd not in use", () => {
    const pool = freshPool();
    run(pool, "acquire");
    const r = run(pool, "release", "02");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("02 is not in use");
  });

  test("fails with exit 2 for what is not a cwd number", () => {
    const pool = freshPool();
    for (const arg of [[], ["1"], ["00"], ["51"]]) {
      expect(run(pool, "release", ...arg).exitCode).toBe(2);
    }
  });
});

test("list prints every cwd with in-use or free", () => {
  const pool = freshPool();
  run(pool, "acquire");
  run(pool, "acquire");
  run(pool, "release", "01");
  const lines = run(pool, "list").stdout.trim().split("\n");
  expect(lines).toHaveLength(50);
  expect(lines.slice(0, 3)).toEqual(["01\tfree", "02\tin-use", "03\tfree"]);
  expect(lines.at(-1)).toBe("50\tfree");
});

const ClaudeJson = v.object({
  theme: v.string(),
  projects: v.record(
    v.string(),
    v.object({
      allowedTools: v.optional(v.array(v.string())),
      hasTrustDialogAccepted: v.optional(v.boolean()),
    }),
  ),
});

test("register writes a copy with every cwd trusted, keeping what the file had", () => {
  const pool = freshPool();
  const source = path.join(tmpDir("verify-cwd-config-"), ".claude.json");
  const kept = {
    theme: "dark",
    projects: { [path.join(pool, "01")]: { allowedTools: ["Bash"] }, "/elsewhere": {} },
  };
  fs.writeFileSync(source, JSON.stringify(kept));
  const r = run(pool, "register", source);
  expect(r).toMatchObject({ exitCode: 0, stderr: "" });
  const out = r.stdout.trim();
  try {
    const written = v.parse(ClaudeJson, JSON.parse(fs.readFileSync(out, "utf8")));
    expect(written.theme).toBe("dark");
    expect(written.projects["/elsewhere"]).toEqual({});
    expect(written.projects[path.join(pool, "01")]).toEqual({
      allowedTools: ["Bash"],
      hasTrustDialogAccepted: true,
    });
    expect(written.projects[path.join(pool, "50")]).toEqual({ hasTrustDialogAccepted: true });
    expect(Object.keys(written.projects)).toHaveLength(51);
    expect(v.parse(ClaudeJson, JSON.parse(fs.readFileSync(source, "utf8")))).toEqual(kept);
  } finally {
    fs.rmSync(path.dirname(out), { recursive: true, force: true });
  }
});
