// A project's autoMode (DR-0063): which project a cwd is, the file the person
// edits and how a change is made to it, the settings file a start or a btw
// is handed, and the built-in defaults read off the PATH's claude.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as v from "valibot";
import {
  AutoModeSectionsSchema,
  type AutoModeSections,
  jsonText,
  parseWith,
  ProjectAutoModeFileTextSchema,
} from "@ccmsg/protocol";
import { perTestTmpDir } from "../../testkit/src/tmp.ts";
import { AutoModeDefaultsCache, type AutoModeDefaultsDeps } from "../src/auto-mode-defaults.ts";
import type { CommandRun } from "../src/claude-update.ts";
import {
  changeSection,
  LAUNCH_SETTINGS_KEEP_MS,
  launchSettingsOf,
  NOTHING_SET,
  prepareLaunchSettings,
  ProjectAutoModeStore,
  projectAutoModeFileText,
  projectOf,
  readUserAutoMode,
} from "../src/project-auto-mode.ts";

const tmp = perTestTmpDir();

/** A project's sections from what a file writes of them. */
const sections = (written: object): AutoModeSections => v.parse(AutoModeSectionsSchema, written);

const SettingsSchema = jsonText(
  v.strictObject({ autoMode: v.record(v.string(), v.array(v.string())) }),
);

function git(cwd: string, ...args: string[]): void {
  const res = Bun.spawnSync(["git", ...args], {
    cwd,
    env: {
      PATH: process.env.PATH ?? "",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "maintenance.auto",
      GIT_CONFIG_VALUE_0: "false",
      GIT_CONFIG_KEY_1: "gc.auto",
      GIT_CONFIG_VALUE_1: "0",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (res.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr.toString()}`);
}

describe("projectOf (DR-0063 §3)", () => {
  // Every checkout of one repo is one project, wherever it lies.
  test("a git repo, its subdirectory and its linked worktree are one repo key", async () => {
    const dir = fs.realpathSync(tmp("pam-git-"));
    const repo = path.join(dir, "repo");
    fs.mkdirSync(path.join(repo, "sub", "deep"), { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    git(repo, "remote", "add", "origin", "git@github.com:kawaz/demo.git");
    fs.writeFileSync(path.join(repo, "f.txt"), "x");
    git(repo, "add", "f.txt");
    git(repo, "commit", "-qm", "init");
    const worktree = path.join(dir, "elsewhere", "wt");
    git(repo, "worktree", "add", "-q", worktree);
    const want = { key: "repo:github.com/kawaz/demo", label: "github.com/kawaz/demo" };
    expect(await projectOf(repo)).toEqual(want);
    expect(await projectOf(path.join(repo, "sub", "deep"))).toEqual(want);
    expect(await projectOf(worktree)).toEqual(want);
  });

  test("a jj repo and its other workspace are one repo key", async () => {
    const dir = fs.realpathSync(tmp("pam-jj-"));
    const repo = path.join(dir, "proj");
    fs.mkdirSync(path.join(repo, ".jj", "repo", "store"), { recursive: true });
    git(dir, "init", "-q", "--bare", path.join(repo, ".git"));
    git(path.join(repo, ".git"), "remote", "add", "origin", "https://github.com/kawaz/proj.git");
    fs.writeFileSync(path.join(repo, ".jj", "repo", "store", "git_target"), "../../../.git");
    const ws = path.join(repo, "ws2");
    fs.mkdirSync(path.join(ws, ".jj"), { recursive: true });
    fs.writeFileSync(path.join(ws, ".jj", "repo"), "../../.jj/repo");
    const want = { key: "repo:github.com/kawaz/proj", label: "github.com/kawaz/proj" };
    expect(await projectOf(repo)).toEqual(want);
    expect(await projectOf(ws)).toEqual(want);
  });

  // A symlinked path is the same cwd as its target.
  test("a cwd no repository is derived from is keyed by its realpath", async () => {
    const dir = fs.realpathSync(tmp("pam-cwd-"));
    const real = path.join(dir, "scratch");
    fs.mkdirSync(real);
    const link = path.join(dir, "link");
    fs.symlinkSync(real, link);
    expect(await projectOf(link)).toEqual({ key: `cwd:${real}`, label: real });
  });

  // A key the file's schema does not read would make the whole file
  // unreadable once written: a cwd that is empty or relative names no
  // project.
  test("an empty or relative cwd names no project", async () => {
    expect(await projectOf("")).toBeUndefined();
    expect(await projectOf("gone-relative-dir")).toBeUndefined();
  });
});

describe("launchSettingsOf (DR-0063 §4)", () => {
  test("only the sections with entries, $defaults first where the check is on, entries as saved", () => {
    const made = launchSettingsOf(
      sections({
        environment: { defaults: false },
        allow: { entries: ["b", "a"] },
        soft_deny: { defaults: false, entries: ["x"] },
      }),
    );
    expect(made?.entries).toBe(3);
    expect(parseWith(SettingsSchema, made?.text ?? "")).toEqual({
      ok: true,
      value: { autoMode: { allow: ["$defaults", "b", "a"], soft_deny: ["x"] } },
    });
  });

  // `[]` and `["$defaults"]` alone are not written: the first changes
  // nothing, the second would bring back defaults a user took out.
  test("no section with entries makes no settings, whatever the checks", () => {
    expect(launchSettingsOf(NOTHING_SET)).toBeUndefined();
    expect(
      launchSettingsOf(
        sections({ allow: { defaults: false }, soft_deny: { defaults: false }, hard_deny: {} }),
      ),
    ).toBeUndefined();
  });
});

describe("changeSection (DR-0063 §7)", () => {
  const base = sections({ allow: { entries: ["one", "two"] } });

  test("text alone is appended; an empty one changes nothing", () => {
    expect(changeSection(base, "allow", { text: "three" })).toEqual({
      ok: true,
      changed: true,
      sections: sections({ allow: { entries: ["one", "two", "three"] } }),
    });
    expect(changeSection(base, "allow", { text: "" })).toEqual({
      ok: true,
      changed: false,
      sections: base,
    });
  });

  test("an entry still as it was is replaced, and removed by an empty text", () => {
    expect(changeSection(base, "allow", { index: 0, before: "one", text: "uno" })).toMatchObject({
      ok: true,
      sections: sections({ allow: { entries: ["uno", "two"] } }),
    });
    expect(changeSection(base, "allow", { index: 1, before: "two", text: "" })).toMatchObject({
      ok: true,
      sections: sections({ allow: { entries: ["one"] } }),
    });
  });

  test("an entry changed elsewhere is file_conflict, an index past the end invalid_args", () => {
    expect(changeSection(base, "allow", { index: 0, before: "two", text: "x" })).toMatchObject({
      ok: false,
      code: "file_conflict",
    });
    expect(changeSection(base, "allow", { index: 2, before: "", text: "x" })).toMatchObject({
      ok: false,
      code: "invalid_args",
    });
  });

  test("the check is set, and setting it as it is changes nothing", () => {
    expect(changeSection(base, "soft_deny", { defaults: false })).toMatchObject({
      ok: true,
      changed: true,
      sections: sections({ allow: { entries: ["one", "two"] }, soft_deny: { defaults: false } }),
    });
    expect(changeSection(base, "soft_deny", { defaults: true })).toMatchObject({ changed: false });
  });
});

describe("the file (DR-0063 §2)", () => {
  test("the defaults are left out, and a project back to nothing set goes", () => {
    const text = projectAutoModeFileText({
      projects: {
        "repo:github.com/o/a": sections({
          allow: { entries: ["x"] },
          hard_deny: { defaults: false },
        }),
        "repo:github.com/o/b": NOTHING_SET,
      },
    });
    expect(JSON.parse(text)).toEqual({
      projects: {
        "repo:github.com/o/a": { allow: { entries: ["x"] }, hard_deny: { defaults: false } },
      },
    });
    expect(parseWith(ProjectAutoModeFileTextSchema, text).ok).toBe(true);
  });

  test("a store's changes, one after another, all hold", async () => {
    const dir = tmp("pam-store-");
    const store = new ProjectAutoModeStore(path.join(dir, "c", "project-auto-mode.json"));
    const key = "repo:github.com/o/r";
    await Promise.all(["a", "b", "c"].map((text) => store.change(key, "allow", { text })));
    const read = await store.read();
    expect(read.ok ? read.file.projects[key]?.allow.entries : undefined).toEqual(["a", "b", "c"]);
  });

  // Every entry the person keeps is put before the classifier at each
  // decision; the store refuses to grow a project past the bound.
  test("a change that grows the project's settings past 32 KiB is refused, nothing written", async () => {
    const dir = tmp("pam-big-");
    const file = path.join(dir, "project-auto-mode.json");
    const store = new ProjectAutoModeStore(file);
    const key = "repo:github.com/o/r";
    for (let i = 0; i < 16; i += 1) {
      expect(
        (await store.change(key, "allow", { text: `${String(i)}${"x".repeat(1990)}` })).ok,
      ).toBe(true);
    }
    const before = fs.readFileSync(file, "utf8");
    expect(await store.change(key, "allow", { text: "y".repeat(1990) })).toMatchObject({
      ok: false,
      code: "invalid_args",
    });
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });
});

describe("a project over the bound, edited by hand (DR-0063 §2)", () => {
  /** A file whose project makes settings of over 32 KiB (40 entries of
   * 1990 characters), written by hand. */
  function overBound(): { store: ProjectAutoModeStore; key: string; entries: string[] } {
    const dir = tmp("pam-over-");
    const file = path.join(dir, "project-auto-mode.json");
    const key = "repo:github.com/o/r";
    const entries = Array.from({ length: 40 }, (_, i) => `${String(i)}${"x".repeat(1990)}`);
    fs.writeFileSync(file, JSON.stringify({ projects: { [key]: { allow: { entries } } } }));
    return { store: new ProjectAutoModeStore(file), key, entries };
  }

  // The bound is for what the screen adds: a change that does not make the
  // settings larger is how the person brings it back under.
  test("a removal, a check and a shorter entry are saved", async () => {
    const { store, key, entries } = overBound();
    expect(
      (await store.change(key, "allow", { index: 0, before: entries[0] ?? "", text: "" })).ok,
    ).toBe(true);
    expect((await store.change(key, "allow", { defaults: false })).ok).toBe(true);
    expect(
      (await store.change(key, "allow", { index: 1, before: entries[2] ?? "", text: "short" })).ok,
    ).toBe(true);
  });

  test("a change that makes it larger is refused", async () => {
    const { store, key, entries } = overBound();
    expect(await store.change(key, "allow", { text: "one more" })).toMatchObject({
      ok: false,
      code: "invalid_args",
    });
    expect(
      await store.change(key, "allow", {
        index: 0,
        before: entries[0] ?? "",
        text: `${entries[0] ?? ""}!`,
      }),
    ).toMatchObject({ ok: false, code: "invalid_args" });
  });
});

describe("a project-auto-mode.json that is a symlink (DR-0063 §2)", () => {
  // The person may keep the file in their dotfiles and link it in: a save
  // writes through to the file the link names, and keeps its mode.
  test("a save writes the link's target, keeps the link and the target's mode", async () => {
    const dir = fs.realpathSync(tmp("pam-link-"));
    const target = path.join(dir, "dotfiles", "project-auto-mode.json");
    fs.mkdirSync(path.dirname(target));
    fs.writeFileSync(target, JSON.stringify({ projects: {} }), { mode: 0o600 });
    fs.chmodSync(target, 0o600);
    const link = path.join(dir, "config", "project-auto-mode.json");
    fs.mkdirSync(path.dirname(link));
    fs.symlinkSync(target, link);
    const store = new ProjectAutoModeStore(link);
    expect((await store.change("repo:github.com/o/r", "allow", { text: "x" })).ok).toBe(true);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(target, "utf8"))).toEqual({
      projects: { "repo:github.com/o/r": { allow: { entries: ["x"] } } },
    });
    expect(fs.readdirSync(path.dirname(link))).toEqual(["project-auto-mode.json"]);
  });
});

describe("prepareLaunchSettings (DR-0063 §4)", () => {
  function setup(): { file: string; dir: string; cwd: string } {
    const base = fs.realpathSync(tmp("pam-prep-"));
    const cwd = path.join(base, "work");
    fs.mkdirSync(cwd);
    return {
      file: path.join(base, "c", "project-auto-mode.json"),
      dir: path.join(base, "s", "launch-settings"),
      cwd,
    };
  }
  const write = (file: string, cwd: string, written: object): void => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ projects: { [`cwd:${cwd}`]: written } }));
  };

  test("no file, or nothing to write, hands no settings and makes no file", async () => {
    const at = setup();
    const now = (): Date => new Date();
    expect(await prepareLaunchSettings({ ...at, now }, at.cwd)).toEqual({
      ok: true,
      settings: undefined,
    });
    write(at.file, at.cwd, { allow: { defaults: false } });
    expect(await prepareLaunchSettings({ ...at, now }, at.cwd)).toEqual({
      ok: true,
      settings: undefined,
    });
    expect(fs.existsSync(at.dir)).toBe(false);
  });

  test("the same content is the same file, touched and not written again; changed content is another file", async () => {
    const at = setup();
    write(at.file, at.cwd, { soft_deny: { entries: ["never push"] } });
    const first = await prepareLaunchSettings({ ...at, now: () => new Date(1_000_000) }, at.cwd);
    if (!first.ok || first.settings === undefined) throw new Error("no settings made");
    const made = first.settings.path;
    expect(path.dirname(made)).toBe(at.dir);
    expect(first.settings.entries).toBe(1);
    expect(fs.statSync(at.dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(made).mode & 0o777).toBe(0o600);
    const ino = fs.statSync(made).ino;
    const content = fs.readFileSync(made, "utf8");
    expect(parseWith(SettingsSchema, content)).toEqual({
      ok: true,
      value: { autoMode: { soft_deny: ["$defaults", "never push"] } },
    });

    const later = new Date(2_000_000_000);
    const again = await prepareLaunchSettings({ ...at, now: () => later }, at.cwd);
    expect(again).toEqual({ ok: true, settings: { path: made, entries: 1 } });
    expect(fs.statSync(made).ino).toBe(ino);
    expect(fs.statSync(made).mtimeMs).toBe(later.getTime());

    write(at.file, at.cwd, { soft_deny: { defaults: false, entries: ["never push"] } });
    const changed = await prepareLaunchSettings({ ...at, now: () => later }, at.cwd);
    expect(changed.ok && changed.settings?.path).not.toBe(made);
    expect(fs.readFileSync(made, "utf8")).toBe(content);
  });

  // A file of the name whose content is not the name's (emptied by a crash,
  // touched by hand) would be handed as it is, and claude reads an empty or
  // broken settings file as none: the person's entries would drop silently.
  test("a file of the name whose content is not the settings is written again", async () => {
    const at = setup();
    write(at.file, at.cwd, { soft_deny: { entries: ["never push"] } });
    const first = await prepareLaunchSettings({ ...at, now: () => new Date() }, at.cwd);
    const made = first.ok ? (first.settings?.path ?? "") : "";
    const content = fs.readFileSync(made, "utf8");
    for (const broken of ["", '{"autoMode":{"allow":["anything goes"]}}']) {
      fs.writeFileSync(made, broken);
      const again = await prepareLaunchSettings({ ...at, now: () => new Date() }, at.cwd);
      expect(again).toEqual({ ok: true, settings: { path: made, entries: 1 } });
      expect(fs.readFileSync(made, "utf8")).toBe(content);
      expect(fs.statSync(made).mode & 0o777).toBe(0o600);
    }
  });

  // The prune runs at the same start: the file handed now is not among
  // what it removes, however long it went unused.
  test("the file handed now is not pruned, even when it went unused for 30 days", async () => {
    const at = setup();
    write(at.file, at.cwd, { soft_deny: { entries: ["never push"] } });
    const first = await prepareLaunchSettings({ ...at, now: () => new Date(0) }, at.cwd);
    const made = first.ok ? (first.settings?.path ?? "") : "";
    const later = new Date(LAUNCH_SETTINGS_KEEP_MS * 3);
    const again = await prepareLaunchSettings({ ...at, now: () => later }, at.cwd);
    expect(again).toEqual({ ok: true, settings: { path: made, entries: 1 } });
    expect(fs.existsSync(made)).toBe(true);
  });

  test("a directory made before with a wider mode is made 0700", async () => {
    const at = setup();
    fs.mkdirSync(at.dir, { recursive: true, mode: 0o755 });
    fs.chmodSync(at.dir, 0o755);
    write(at.file, at.cwd, { allow: { entries: ["x"] } });
    expect((await prepareLaunchSettings({ ...at, now: () => new Date() }, at.cwd)).ok).toBe(true);
    expect(fs.statSync(at.dir).mode & 0o777).toBe(0o700);
  });

  test("a cwd that names no project is a failure", async () => {
    const at = setup();
    const read = await prepareLaunchSettings({ ...at, now: () => new Date() }, "relative");
    expect(read.ok).toBe(false);
  });

  test("a file that does not read is a failure", async () => {
    const at = setup();
    fs.mkdirSync(path.dirname(at.file), { recursive: true });
    fs.writeFileSync(at.file, '{"projects": {"cwd:/x": {"allow": {"entries": ["$defaults"]}}}}');
    const read = await prepareLaunchSettings({ ...at, now: () => new Date() }, at.cwd);
    expect(read.ok).toBe(false);
  });

  test("a settings file unused for 30 days goes at the next start; a newer one stays", async () => {
    const at = setup();
    fs.mkdirSync(at.dir, { recursive: true });
    const now = new Date(10 * LAUNCH_SETTINGS_KEEP_MS);
    const old = path.join(at.dir, "old.json");
    const fresh = path.join(at.dir, "fresh.json");
    for (const [file, ms] of [
      [old, now.getTime() - LAUNCH_SETTINGS_KEEP_MS - 1000],
      [fresh, now.getTime() - LAUNCH_SETTINGS_KEEP_MS + 60_000],
    ] as const) {
      fs.writeFileSync(file, "{}");
      fs.utimesSync(file, new Date(ms), new Date(ms));
    }
    await prepareLaunchSettings({ ...at, now: () => now }, at.cwd);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });
});

describe("readUserAutoMode (DR-0063 §7)", () => {
  test("the lists as written, $defaults kept; none written when there is no file", async () => {
    const dir = path.join(fs.realpathSync(tmp("pam-user-")), ".claude-x");
    fs.mkdirSync(dir);
    expect(await readUserAutoMode(dir)).toEqual({ config_dir_name: ".claude-x", autoMode: {} });
    fs.writeFileSync(
      path.join(dir, "settings.json"),
      JSON.stringify({ autoMode: { soft_deny: ["$defaults", "x"], classifyAllShell: true } }),
    );
    expect(await readUserAutoMode(dir)).toEqual({
      config_dir_name: ".claude-x",
      autoMode: { soft_deny: ["$defaults", "x"] },
    });
  });

  test("an unknown config dir and a file that does not read say why", async () => {
    expect(await readUserAutoMode(undefined)).toEqual({ unavailable: "config dir が分からない" });
    const dir = fs.realpathSync(tmp("pam-user-bad-"));
    fs.writeFileSync(path.join(dir, "settings.json"), "{");
    const read = await readUserAutoMode(dir);
    expect("unavailable" in read && read.unavailable.startsWith("settings.json が読めない: ")).toBe(
      true,
    );
  });
});

describe("AutoModeDefaultsCache (DR-0063 §7)", () => {
  const DEFAULTS = { environment: ["e"], allow: ["a"], soft_deny: ["s"], hard_deny: ["h"] };

  /** A claude binary under `dir`, and deps that count its runs. */
  function claudeDeps(
    dir: string,
    answer: (argv: readonly string[]) => CommandRun,
  ): { deps: AutoModeDefaultsDeps; claude: string; runs: string[][] } {
    // Never run (deps.run answers for it): a file of its own, whose mtime the
    // test moves, not a mock bin sharing the shim's inode.
    const claude = path.join(dir, "claude");
    fs.writeFileSync(claude, "");
    const runs: string[][] = [];
    return {
      claude,
      runs,
      deps: {
        which: () => claude,
        run: (argv) => {
          runs.push([...argv]);
          return Promise.resolve(answer(argv));
        },
        now: () => 0,
      },
    };
  }
  const answers = (argv: readonly string[]): CommandRun =>
    argv[1] === "--version"
      ? { kind: "exited", code: 0, stdout: "2.1.330 (Claude Code)\n", stderr: "" }
      : { kind: "exited", code: 0, stdout: JSON.stringify(DEFAULTS), stderr: "" };

  test("claude is run once until its realpath or mtime changes", async () => {
    const dir = fs.realpathSync(tmp("pam-defaults-"));
    const { deps, claude, runs } = claudeDeps(dir, answers);
    const cache = new AutoModeDefaultsCache(deps);
    const version = await cache.version();
    if (version === undefined) throw new Error("no version");
    const first = await cache.read(version);
    expect(first).toEqual({
      ok: true,
      version,
      label: "2.1.330 (Claude Code)",
      defaults: DEFAULTS,
    });
    expect(await cache.read(version)).toEqual(first);
    expect(runs).toEqual([
      [claude, "auto-mode", "defaults"],
      [claude, "--version"],
    ]);

    const updated = new Date(fs.statSync(claude).mtimeMs + 60_000);
    fs.utimesSync(claude, updated, updated);
    const next = await cache.version();
    expect(next).not.toBe(version);
    expect(await cache.read(version)).toMatchObject({ ok: false, code: "invalid_args" });
    if (next === undefined) throw new Error("no version");
    expect((await cache.read(next)).ok).toBe(true);
    expect(runs).toHaveLength(4);
  });

  test("a failure is not kept: the next read runs claude again", async () => {
    const dir = fs.realpathSync(tmp("pam-defaults-fail-"));
    let fail = true;
    const { deps, runs } = claudeDeps(dir, (argv) =>
      fail ? { kind: "exited", code: 1, stdout: "", stderr: "boom\n" } : answers(argv),
    );
    const cache = new AutoModeDefaultsCache(deps);
    const version = (await cache.version()) ?? "";
    expect(await cache.read(version)).toEqual({
      ok: false,
      code: "auto_mode_defaults_unavailable",
      msg: "claude auto-mode defaults exited 1: boom",
    });
    fail = false;
    expect((await cache.read(version)).ok).toBe(true);
    expect(runs).toHaveLength(3);
  });

  test("no claude on the PATH is claude_not_found, and has no version", async () => {
    const cache = new AutoModeDefaultsCache({
      which: () => null,
      run: () => Promise.reject(new Error("must not run")),
      now: () => 0,
    });
    expect(await cache.version()).toBeUndefined();
    expect(await cache.read("x")).toMatchObject({ ok: false, code: "claude_not_found" });
  });
});
