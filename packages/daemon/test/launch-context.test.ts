// Which session `claude --continue` carries on, as measured on Claude Code
// 2.1.326 (docs/findings/2026-11-17-claude-continue-session-pick-empirical.md):
// one test per item of the rule, on small made-up transcripts. The layouts
// the findings checked against the real claude (some of them 17 MB) stay out
// of the repo; these pin each item the rule says, and the 16 MiB edge with
// files of that size. Then which transcript `claude --resume <id>` refuses,
// and what a launch that carries on from a session adds to its model and
// effort (DR-0018 §3.2).
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  type ContinueMode,
  continueTranscript,
  launchContext,
  projectSlug,
  resumable,
} from "../src/launch-context.ts";
import { perTestTmpDir } from "../../testkit/src/tmp.ts";

const tmp = perTestTmpDir();
const MiB = 1024 * 1024;

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const C = "cccccccc-0000-4000-8000-000000000003";
const D = "dddddddd-0000-4000-8000-000000000004";

interface Place {
  /** The config dir. */
  cfg: string;
  /** The cwd of the launch (realpath; its name holds a `.`). */
  cwd: string;
  /** `<cfg>/projects/<the cwd's slug>`. */
  own: string;
  base: string;
}

function place(name = "proj.a"): Place {
  const base = fs.realpathSync(tmp("ccmsg-launch-context-"));
  const cwd = path.join(base, name);
  fs.mkdirSync(cwd);
  const cfg = path.join(base, "cfg");
  const own = path.join(cfg, "projects", projectSlug(cwd));
  fs.mkdirSync(own, { recursive: true });
  return { cfg, cwd, own, base };
}

const line = (row: Record<string, unknown>): string => `${JSON.stringify(row)}\n`;

/** A conversation as claude writes one: a user row (the first conversation
 * row) and an assistant row, with `extra` on the user row. */
function conversation(cwd: string, extra: Record<string, unknown> = {}): string {
  return (
    line({ type: "queue-operation", operation: "enqueue" }) +
    line({
      type: "user",
      parentUuid: null,
      isSidechain: false,
      entrypoint: "cli",
      cwd,
      message: { role: "user", content: "hi" },
      uuid: "u1",
      timestamp: "2026-11-17T00:00:00.000Z",
      ...extra,
    }) +
    line({
      type: "assistant",
      parentUuid: "u1",
      isSidechain: false,
      cwd,
      message: {
        role: "assistant",
        model: "claude-opus-4-1",
        content: [{ type: "text", text: "ok" }],
      },
      effort: "high",
      uuid: "a1",
      timestamp: "2026-11-17T00:00:01.000Z",
    })
  );
}

/** Writes `<dir>/<id>.jsonl` with `text` and its mtime at `minute` minutes
 * past a fixed time. */
function put(dir: string, id: string, text: string, minute: number): string {
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, text);
  const at = new Date(Date.UTC(2026, 10, 17, 0, minute));
  fs.utimesSync(file, at, at);
  return file;
}

async function picked(p: Place, mode: ContinueMode = "interactive"): Promise<string | undefined> {
  const file = await continueTranscript({ configDir: p.cfg, cwd: p.cwd, mode });
  return file === undefined ? undefined : path.basename(file, ".jsonl");
}

describe("projectSlug", () => {
  test("each UTF-16 code unit outside [A-Za-z0-9] is a -", () => {
    expect(projectSlug("/home/me/we.ird_name dir")).toBe("-home-me-we-ird-name-dir");
    expect(projectSlug("/ユニ")).toBe("---");
    expect(projectSlug("/e😀x")).toBe("-e--x");
  });

  // The suffix is the base-36 of the absolute value of Java's
  // String.hashCode over the cwd (computed apart from this code).
  test("over 200: the first 200 and the base-36 of the cwd's hash", () => {
    expect(projectSlug(`/${"a".repeat(250)}`)).toBe(`-${"a".repeat(199)}-feo44x`);
    expect(projectSlug(`/${"a".repeat(199)}`)).toBe(`-${"a".repeat(199)}`);
  });
});

describe("continueTranscript: the order", () => {
  test("the newest mtime, not the name or the rows' time", async () => {
    const p = place();
    put(p.own, A, conversation(p.cwd, { timestamp: "2030-01-01T00:00:00Z" }), 1);
    put(p.own, B, conversation(p.cwd), 3);
    put(p.own, C, conversation(p.cwd), 2);
    expect(await picked(p)).toBe(B);
  });

  // macOS lowers the birthtime to an mtime set before it: each file's
  // birthtime is placed so, then both get the same later mtime. Linux keeps no
  // settable birthtime, so the tie is checked on macOS only.
  test.skipIf(process.platform !== "darwin")(
    "the same mtime: the newest birthtime, not the name",
    async () => {
      // both ways round, so neither the name nor the listing's order decides
      for (const [newer, older] of [
        [A, D],
        [D, A],
      ] as const) {
        const p = place();
        const later = put(p.own, newer, conversation(p.cwd), 2);
        const earlier = put(p.own, older, conversation(p.cwd), 1);
        const same = new Date(Date.UTC(2030, 0, 1));
        fs.utimesSync(later, same, same);
        fs.utimesSync(earlier, same, same);
        expect(await picked(p)).toBe(newer);
      }
    },
  );

  test("only <uuid>.jsonl directly in the dir: other names and subagents are none", async () => {
    const p = place();
    put(p.own, A, conversation(p.cwd), 1);
    fs.writeFileSync(path.join(p.own, "notauuid.jsonl"), conversation(p.cwd));
    fs.mkdirSync(path.join(p.own, B, "subagents"), { recursive: true });
    put(path.join(p.own, B, "subagents"), C, conversation(p.cwd), 5);
    expect(await picked(p)).toBe(A);
  });

  test("the realpath of the cwd, not the path it was given as", async () => {
    const p = place();
    const link = path.join(p.base, "link");
    fs.symlinkSync(p.cwd, link);
    put(p.own, A, conversation(p.cwd), 1);
    expect(await continueTranscript({ configDir: p.cfg, cwd: link, mode: "interactive" })).toBe(
      path.join(p.own, `${A}.jsonl`),
    );
  });

  test("none to carry on: undefined", async () => {
    const p = place();
    expect(await picked(p, "interactive")).toBeUndefined();
    expect(await picked(p, "print")).toBeUndefined();
  });
});

describe("continueTranscript: what is passed over", () => {
  test("an empty file is taken; one with no conversation row is passed over", async () => {
    const p = place();
    put(p.own, A, conversation(p.cwd), 1);
    put(p.own, B, "\n", 4);
    put(
      p.own,
      C,
      line({ type: "last-prompt", lastPrompt: "x" }) + line({ type: "custom-title" }),
      3,
    );
    expect(await picked(p)).toBe(A);
    put(p.own, D, "", 5);
    expect(await picked(p)).toBe(D);
  });

  test('a "parentUuid": anywhere in the first 16 MiB counts, even in a broken row', async () => {
    const p = place();
    put(p.own, A, conversation(p.cwd), 1);
    // straddling the 1 MiB read chunk, past the 64 KiB head
    const pad = "x".repeat(MiB - 5);
    put(p.own, B, `${pad}"parentUuid":null yy\n`, 5);
    expect(await picked(p)).toBe(B);
  });

  test("16 MiB with no conversation row is passed over; a larger file is taken", async () => {
    const p = place();
    put(p.own, A, conversation(p.cwd), 1);
    const meta = line({ type: "last-prompt" });
    const filler = (size: number): string => meta + "x".repeat(size - meta.length);
    put(p.own, B, filler(16 * MiB), 5);
    expect(await picked(p)).toBe(A);
    put(p.own, C, filler(16 * MiB + 1), 6);
    expect(await picked(p)).toBe(C);
  });

  test('"isSidechain":true in the first 64 KiB is passed over, further in is not', async () => {
    const p = place();
    put(p.own, A, conversation(p.cwd), 1);
    put(p.own, B, conversation(p.cwd, { isSidechain: true }), 5);
    expect(await picked(p)).toBe(A);
    const far = conversation(p.cwd) + "x".repeat(70 * 1024) + "\n" + line({ isSidechain: true });
    put(p.own, C, far, 6);
    expect(await picked(p)).toBe(C);
  });

  test("a non-empty teamName is passed over, an empty one is not", async () => {
    const p = place();
    put(p.own, A, conversation(p.cwd), 1);
    put(p.own, B, conversation(p.cwd, { teamName: "t" }), 5);
    expect(await picked(p)).toBe(A);
    put(p.own, C, conversation(p.cwd, { teamName: "" }), 6);
    expect(await picked(p)).toBe(C);
  });

  test("sessionKind daemon / daemon-worker on the first conversation row is passed over", async () => {
    const p = place();
    put(p.own, A, conversation(p.cwd), 1);
    put(p.own, B, conversation(p.cwd, { sessionKind: "daemon" }), 5);
    put(p.own, C, conversation(p.cwd, { sessionKind: "daemon-worker" }), 6);
    expect(await picked(p)).toBe(A);
    // on a later row only: the first conversation row decides
    put(p.own, D, conversation(p.cwd) + line({ parentUuid: "a1", sessionKind: "daemon" }), 7);
    expect(await picked(p)).toBe(D);
  });

  test("continued-in a conversation in the same dir is passed over", async () => {
    const p = place();
    put(p.own, A, conversation(p.cwd), 1);
    const moved = (to: string): string =>
      conversation(p.cwd) + line({ type: "continued-in", continuedInSessionId: to });
    put(p.own, B, moved(A), 5);
    expect(await picked(p)).toBe(A);
    // moved to a file that is not there, or that holds no conversation
    put(p.own, C, moved(D), 6);
    expect(await picked(p)).toBe(C);
    put(p.own, D, line({ type: "last-prompt" }), 0);
    expect(await picked(p)).toBe(C);
  });

  test("interactive passes over -p / SDK sessions and /loop sessions; -p takes them", async () => {
    const p = place();
    put(p.own, A, conversation(p.cwd), 1);
    put(p.own, B, conversation(p.cwd, { entrypoint: "sdk-cli" }), 5);
    expect(await picked(p, "interactive")).toBe(A);
    expect(await picked(p, "print")).toBe(B);
    for (const [id, entrypoint, minute] of [
      [C, "sdk-ts", 6],
      [D, "sdk-py", 7],
    ] as const) {
      put(p.own, id, conversation(p.cwd, { entrypoint }), minute);
      expect(await picked(p, "interactive")).toBe(A);
    }
    const loop = place();
    put(loop.own, A, conversation(loop.cwd), 1);
    const content = "<command-name>/loop</command-name>";
    put(loop.own, B, conversation(loop.cwd, { message: { role: "user", content } }), 5);
    expect(await picked(loop, "interactive")).toBe(A);
    expect(await picked(loop, "print")).toBe(B);
  });

  test("other entrypoints are taken by an interactive continue", async () => {
    const p = place();
    put(p.own, A, conversation(p.cwd), 1);
    put(p.own, B, conversation(p.cwd, { entrypoint: "claude-vscode" }), 5);
    expect(await picked(p)).toBe(B);
  });

  test("a session of another existing dir with the same slug is passed over", async () => {
    const p = place("proj.a");
    const twin = path.join(p.base, "proj-a");
    put(p.own, A, conversation(p.cwd), 1);
    put(p.own, B, conversation(twin), 5);
    // the twin does not exist yet: the row's cwd does not count
    expect(await picked(p)).toBe(B);
    fs.mkdirSync(twin);
    expect(await picked(p)).toBe(A);
    // a cwd of another slug does not count either
    put(p.own, C, conversation("/elsewhere"), 6);
    expect(await picked(p)).toBe(C);
  });
});

describe("continueTranscript: the other project dirs", () => {
  test("with none of its own, every dir whose newest transcript records the cwd", async () => {
    const p = place();
    const projects = path.dirname(p.own);
    const match = path.join(projects, "-unrelated-1");
    const other = path.join(projects, "-unrelated-2");
    fs.mkdirSync(match);
    fs.mkdirSync(other);
    put(match, A, conversation(p.cwd), 1);
    put(match, B, conversation("/elsewhere"), 0);
    put(other, C, conversation("/elsewhere"), 5);
    expect(await picked(p)).toBe(A);
    // the cwd recorded by an older file of a dir does not count
    put(match, B, conversation("/elsewhere"), 2);
    expect(await picked(p)).toBeUndefined();
  });

  test("a dir of its own holding only another dir's sessions counts as none", async () => {
    const p = place("proj.a");
    const twin = path.join(p.base, "proj-a");
    fs.mkdirSync(twin);
    put(p.own, A, conversation(twin), 5);
    const elsewhere = path.join(path.dirname(p.own), "-unrelated-1");
    fs.mkdirSync(elsewhere);
    put(elsewhere, B, conversation(p.cwd), 1);
    expect(await picked(p)).toBe(B);
  });

  test("a file of its own, even one passed over, keeps the search from happening", async () => {
    const p = place();
    put(p.own, A, line({ type: "last-prompt" }), 5);
    const elsewhere = path.join(path.dirname(p.own), "-unrelated-1");
    fs.mkdirSync(elsewhere);
    put(elsewhere, B, conversation(p.cwd), 1);
    expect(await picked(p)).toBeUndefined();
  });

  // The temp dirs are under os.tmpdir(); a path there with another character
  // (a `.` in it) cannot make such a cwd.
  test.skipIf(/[^A-Za-z0-9/\\:-]/.test(fs.realpathSync(os.tmpdir())))(
    "a cwd of letters, digits and / \\ : - only does not look elsewhere",
    async () => {
      const p = place("plain");
      const elsewhere = path.join(path.dirname(p.own), "-unrelated-1");
      fs.mkdirSync(elsewhere);
      put(elsewhere, A, conversation(p.cwd), 1);
      expect(await picked(p)).toBeUndefined();
    },
  );
});

// Whether `claude --resume <id>` carries the file on, as measured on Claude
// Code 2.1.326 (the findings' 「`--resume` に断られる形」): each form there,
// small, refused or carried on as claude did.
describe("resumable", () => {
  const T0 = "2026-11-17T00:00:00.000Z";
  type Row = Record<string, unknown>;
  const user = (extra: Row = {}): Row => ({
    type: "user",
    parentUuid: null,
    isSidechain: false,
    uuid: "u1",
    timestamp: T0,
    message: { role: "user", content: "hi" },
    ...extra,
  });
  const assistant = (extra: Row = {}): Row => ({
    type: "assistant",
    parentUuid: "u1",
    isSidechain: false,
    uuid: "a1",
    timestamp: T0,
    message: {
      role: "assistant",
      model: "claude-opus-4-1",
      content: [{ type: "text", text: "ok" }],
    },
    ...extra,
  });
  const attachment = (extra: Row = {}): Row => ({
    type: "attachment",
    parentUuid: "a1",
    isSidechain: false,
    uuid: "t1",
    timestamp: T0,
    attachment: { type: "date" },
    ...extra,
  });
  const system: Row = {
    type: "system",
    subtype: "informational",
    parentUuid: null,
    uuid: "s1",
    timestamp: T0,
  };
  const lines = (...rows: Row[]): string => rows.map(line).join("");
  const without = (row: Row, key: string): Row =>
    Object.fromEntries(Object.entries(row).filter(([k]) => k !== key));
  async function check(text: string): Promise<boolean> {
    const p = place();
    return resumable(put(p.own, A, text, 1));
  }

  test("a conversation, and one ending in a row cut off mid-write", async () => {
    const whole = lines(user(), assistant(), attachment());
    expect(await check(whole)).toBe(true);
    expect(await check(whole + JSON.stringify(assistant({ uuid: "a2" })).slice(0, 60))).toBe(true);
  });

  test("no message row: empty, broken rows, rows that are not messages", async () => {
    expect(await check("")).toBe(false);
    expect(await check('xx "parentUuid":null yy\n')).toBe(false);
    expect(await check(JSON.stringify(user()).slice(0, 60))).toBe(false);
    expect(await check(lines({ parentUuid: null }))).toBe(false);
    expect(await check(lines({ type: "custom-title", x: { parentUuid: null } }))).toBe(false);
    const progress = { type: "progress", parentUuid: null, uuid: "p1", timestamp: T0 };
    expect(await check(lines(progress))).toBe(false);
  });

  test("one row of each message type is enough", async () => {
    expect(await check(lines(user()))).toBe(true);
    expect(await check(lines(assistant()))).toBe(true);
    expect(await check(lines(attachment()))).toBe(true);
    expect(await check(lines(system))).toBe(true);
    // with no uuid
    expect(await check(lines(without(user(), "uuid")))).toBe(true);
  });

  test("a user or assistant row needs a message with content claude keeps", async () => {
    expect(await check(lines(without(user(), "message")))).toBe(false);
    expect(await check(lines(user({ message: "hi" })))).toBe(false);
    expect(await check(lines(user({ message: { role: "user", content: 1 } })))).toBe(false);
    expect(await check(lines(user({ message: { role: "user", content: [] } })))).toBe(true);
    expect(await check(lines(user({ message: { role: "user", content: [1] } })))).toBe(false);
    const blank = { role: "assistant", content: " " };
    expect(await check(lines(assistant({ message: blank })))).toBe(false);
  });

  test("the turn above the last row needs a timestamp claude reads", async () => {
    expect(await check(lines(without(user(), "timestamp")))).toBe(false);
    expect(await check(lines(user({ timestamp: "garbage" })))).toBe(false);
    expect(await check(lines(user({ timestamp: Date.parse(T0) })))).toBe(false);
    expect(await check(lines(user({ timestamp: "2026-11-17" })))).toBe(true);
    // the assistant row is the turn above the last row: the others' times do not count
    expect(await check(lines(user(), without(assistant(), "timestamp"), attachment()))).toBe(false);
  });

  test("sidechain rows: none of the main conversation, or a sidechain's turn above it", async () => {
    const side = { isSidechain: true };
    expect(await check(lines(user(side), assistant(side)))).toBe(false);
    expect(await check(lines(user(side), attachment({ parentUuid: "u1" })))).toBe(false);
    // a main turn whose child is a sidechain's
    expect(await check(lines(user(), assistant(side)))).toBe(true);
  });

  test("no turn above the last row: the turns that end a branch, or any timed main row", async () => {
    const orphan = attachment({ parentUuid: "gone" });
    expect(await check(lines(orphan))).toBe(true);
    expect(await check(lines(without(orphan, "timestamp")))).toBe(false);
    // a branch ending in an untimed turn
    expect(await check(lines(without(user(), "timestamp"), orphan))).toBe(false);
    const timed = user({ uuid: "u2" });
    expect(await check(lines(timed, without(user(), "timestamp"), orphan))).toBe(true);
  });

  test("a row hanging from a progress row hangs from that row's parent", async () => {
    const progress = { type: "progress", parentUuid: "u1", uuid: "p1", timestamp: T0 };
    const hung = attachment({ parentUuid: "p1" });
    expect(await check(lines(without(user(), "timestamp"), progress, hung))).toBe(false);
    expect(await check(lines(user(), progress, hung))).toBe(true);
  });

  test("rewound to empty is carried on whatever the rows, until a row follows", async () => {
    const cleared = { type: "last-prompt", leafUuid: null, explicit: true };
    const untimed = without(user(), "timestamp");
    expect(await check(lines(untimed, cleared))).toBe(true);
    expect(await check(lines(user({ isSidechain: true }), cleared))).toBe(true);
    expect(await check(lines(untimed, cleared, { ...untimed, uuid: "u2" }))).toBe(false);
  });

  // The tail is read first, then wider until the chain from the last row is
  // decided: rows far from the end are found, within 16 MiB and past it.
  test("rows only far from the end of a large file", async () => {
    const meta = line({ type: "queue-operation", content: "x".repeat(1000) });
    const filler = (size: number): string => meta.repeat(Math.ceil(size / meta.length));
    const hung = lines(attachment({ parentUuid: "u1" }));
    expect(await check(lines(user()) + filler(2 * MiB) + hung)).toBe(true);
    expect(await check(lines(without(user(), "timestamp")) + filler(2 * MiB) + hung)).toBe(false);
    expect(await check(lines(user()) + filler(17 * MiB))).toBe(true);
    expect(await check(filler(17 * MiB))).toBe(false);
  });
});

describe("launchContext", () => {
  const log = { warn: (): void => {} };
  const assistant = (model: string, effort: string | undefined, extra = {}): string =>
    line({
      type: "assistant",
      parentUuid: "x",
      isSidechain: false,
      message: { role: "assistant", model },
      ...(effort !== undefined ? { effort } : {}),
      ...extra,
    });

  test("a resume: the model and effort of the newest main-context assistant row", async () => {
    const p = place();
    put(
      p.own,
      A,
      conversation(p.cwd) +
        assistant("claude-fable-5[1m]", "low") +
        assistant("claude-haiku-4", "max", { isSidechain: true }) +
        assistant("<synthetic>", undefined),
      1,
    );
    const where = { configDir: p.cfg, cwd: p.cwd };
    expect(await launchContext({ resume: A }, where, log)).toEqual({
      session_id: A,
      model: "fable",
      effort: "low",
    });
    // named fields stay the launch's: only what it leaves out is added
    expect(await launchContext({ resume: A, model: "fable" }, where, log)).toEqual({
      session_id: A,
      effort: "low",
    });
    expect(await launchContext({ resume: A, effort: "high" }, where, log)).toEqual({
      session_id: A,
      model: "fable",
    });
    expect(await launchContext({ resume: A, model: "fable", effort: "max" }, where, log)).toEqual({
      session_id: A,
    });
    // another model takes its own effort, not the session's
    expect(await launchContext({ resume: A, model: "opus" }, where, log)).toEqual({
      session_id: A,
    });
  });

  test("a resume whose transcript names nothing, or is not there: the id alone", async () => {
    const p = place();
    put(p.own, A, line({ type: "user", parentUuid: null, message: { content: "hi" } }), 1);
    const where = { configDir: p.cfg, cwd: p.cwd };
    expect(await launchContext({ resume: A }, where, log)).toEqual({ session_id: A });
    expect(await launchContext({ resume: B }, where, log)).toEqual({ session_id: B });
  });

  test("a resume finds the session in any project dir of the config dir", async () => {
    const p = place();
    const elsewhere = path.join(path.dirname(p.own), "-unrelated-1");
    fs.mkdirSync(elsewhere);
    put(elsewhere, A, conversation("/elsewhere"), 1);
    expect(await launchContext({ resume: A }, { configDir: p.cfg, cwd: p.cwd }, log)).toEqual({
      session_id: A,
      model: "opus",
      effort: "high",
    });
  });

  test("a continue: the session it chooses, and what that session runs as", async () => {
    const p = place();
    const where = { configDir: p.cfg, cwd: p.cwd };
    expect(await launchContext({ continue: "interactive" }, where, log)).toEqual({});
    put(p.own, A, conversation(p.cwd), 1);
    put(p.own, B, conversation(p.cwd, { entrypoint: "sdk-cli" }) + assistant("sonnet", "low"), 5);
    expect(await launchContext({ continue: "interactive" }, where, log)).toEqual({
      session_id: A,
      model: "opus",
      effort: "high",
    });
    expect(await launchContext({ continue: "print", effort: "max" }, where, log)).toEqual({
      session_id: B,
      model: "sonnet",
    });
  });

  test("a continue whose session --resume refuses: keep_continue, the id all the same", async () => {
    const p = place();
    const where = { configDir: p.cfg, cwd: p.cwd };
    put(p.own, A, conversation(p.cwd), 1);
    put(p.own, B, "", 5);
    expect(await launchContext({ continue: "interactive" }, where, log)).toEqual({
      session_id: B,
      keep_continue: true,
    });
    // a resume of that id is answered as any resume
    expect(await launchContext({ resume: B }, where, log)).toEqual({ session_id: B });
    // rows with no time claude reads: refused too, and the model read as for any session
    const untimed = conversation(p.cwd).replace(/"timestamp":"[^"]*"/g, '"timestamp":"x"');
    put(p.own, C, untimed, 6);
    expect(await launchContext({ continue: "interactive" }, where, log)).toEqual({
      session_id: C,
      keep_continue: true,
      model: "opus",
      effort: "high",
    });
  });
});
