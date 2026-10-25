// The launch a person or an agent asks for, and what the launch command reads
// on standard input (DR-0018 §3.2, §3.3): claude's options as fields, the
// combinations claude refuses or ignores refused on the field to change, and
// the new session's id only where the daemon chooses one.
import { describe, expect, test } from "bun:test";
import {
  LAUNCH_CHOOSE_MESSAGE,
  LaunchCommandInputSchema,
  LaunchFieldsSchema,
  LaunchInputSchema,
  LaunchToolFieldsSchema,
  launchErrorText,
  launchMakesSession,
} from "../src/launch.ts";
import { parseWith } from "../src/parse.ts";

const SID = "11111111-2222-4333-8444-555555555555";
const NEW_SID = "99999999-8888-4777-8666-555555555555";
const AT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

/** The reasons `value` does not read as a launch, by field path ("" for the
 * launch itself); empty when it reads. */
function launchIssues(value: object): Record<string, string> {
  const read = parseWith(LaunchInputSchema, value);
  if (read.ok) return {};
  return Object.fromEntries(read.failure.issues.map((issue) => [issue.path, issue.message]));
}

function commandInputRefusal(value: object): string {
  const read = parseWith(LaunchCommandInputSchema, value);
  return read.ok ? "" : read.failure.summary;
}

describe("LaunchInputSchema", () => {
  // The smallest launch of each way to start: what each cannot do without.
  test("a new session, a continue, a resume and a fork each read with their required fields alone", () => {
    for (const launch of [
      { cwd: "/w", model: "opus", effort: "high" },
      { cwd: "/w", continue: true },
      { cwd: "/w", resume: SID },
      { cwd: "/w", resume: SID, fork_session: true },
      { cwd: "/w", continue: true, fork_session: true },
      { cwd: "/w", resume: SID, fork_session: true, resume_session_at: AT },
    ] as const) {
      expect(parseWith(LaunchInputSchema, launch)).toEqual({ ok: true, value: launch });
    }
  });

  test("every field reads as given", () => {
    const launch = {
      cwd: "/w",
      model: "haiku" as const,
      effort: "max" as const,
      resume: SID,
      resume_session_at: AT,
      fork_session: true,
      name: "n",
      prompt: "line 1\nline 2\n",
    };
    expect(parseWith(LaunchInputSchema, launch)).toEqual({ ok: true, value: launch });
  });

  // A new session has no session to take a model or effort from, so it names
  // both. The reason is the one the webui shows under the select.
  test("a new session without a model or an effort does not read, on each field", () => {
    expect(launchIssues({ cwd: "/w" })).toEqual({
      model: LAUNCH_CHOOSE_MESSAGE,
      effort: LAUNCH_CHOOSE_MESSAGE,
    });
    // `false` options start nothing from a session either.
    expect(
      launchIssues({ cwd: "/w", continue: false, fork_session: false, model: "opus" }),
    ).toEqual({ effort: LAUNCH_CHOOSE_MESSAGE });
  });

  // claude takes one session to carry on from (findings fork-with-session-id).
  test("continue and resume together do not read, on resume", () => {
    expect(launchIssues({ cwd: "/w", continue: true, resume: SID })).toEqual({
      resume: "continue と resume は同時に指定できない",
    });
  });

  // A fork and a fork point copy a session: without one to copy, claude
  // starts a new session and ignores them.
  test("fork_session and resume_session_at without continue or resume do not read", () => {
    const issues = launchIssues({
      cwd: "/w",
      model: "opus",
      effort: "low",
      fork_session: true,
      resume_session_at: AT,
    });
    expect(Object.keys(issues).sort()).toEqual(["fork_session", "resume_session_at"]);
    expect(issues.fork_session).toContain("continue か resume");
  });

  // The checks run once the fields they read are readable, so a form shows
  // every reason at once rather than one per submit.
  test("a combination is checked while another field does not read", () => {
    expect(Object.keys(launchIssues({ cwd: "w", continue: true, resume: SID })).sort()).toEqual([
      "cwd",
      "resume",
    ]);
    expect(Object.keys(launchIssues({ cwd: "w" })).sort()).toEqual(["cwd", "effort", "model"]);
  });

  // A field the launch does not have is refused, not dropped: the caller would
  // otherwise believe it took effect.
  test("a field the launch does not have does not read", () => {
    expect(launchIssues({ cwd: "/w", continue: true, type: "new" })).toHaveProperty("type");
    // session_id is the daemon's to choose, never the caller's.
    expect(launchIssues({ cwd: "/w", continue: true, session_id: SID })).toHaveProperty(
      "session_id",
    );
  });

  // "Not given" is said one way, by leaving the field out.
  test("an empty name or prompt does not read", () => {
    expect(launchIssues({ cwd: "/w", continue: true, name: "" })).toHaveProperty("name");
    expect(launchIssues({ cwd: "/w", continue: true, prompt: "" })).toHaveProperty("prompt");
  });

  test("a relative cwd does not read", () => {
    expect(launchIssues({ cwd: "w", continue: true })).toEqual({ cwd: "絶対パスで指定する" });
  });

  // The same shape hello takes a session id in.
  test("resume and resume_session_at take a lowercase uuid", () => {
    expect(launchIssues({ cwd: "/w", resume: "abc" })).toEqual({
      resume: "小文字の uuid で指定する",
    });
    expect(launchIssues({ cwd: "/w", resume: AT.toUpperCase() })).toHaveProperty("resume");
    expect(launchIssues({ cwd: "/w", resume: SID, resume_session_at: "abc" })).toHaveProperty(
      "resume_session_at",
    );
  });

  test("a model or effort outside the lists, or a non-boolean option, does not read", () => {
    expect(launchIssues({ cwd: "/w", model: "gpt", effort: "high" })).toHaveProperty("model");
    expect(launchIssues({ cwd: "/w", continue: true, effort: "extreme" })).toHaveProperty("effort");
    expect(launchIssues({ cwd: "/w", continue: "true" })).toHaveProperty("continue");
  });
});

describe("LaunchToolFieldsSchema", () => {
  // The tool's fields are the launch's without the fork point, which names a
  // transcript record an agent cannot see.
  test("has the launch's fields but resume_session_at", () => {
    expect(Object.keys(LaunchToolFieldsSchema.entries)).toEqual(
      Object.keys(LaunchFieldsSchema.entries).filter((field) => field !== "resume_session_at"),
    );
  });
});

describe("launchMakesSession", () => {
  test("a new session and a fork make a session, a resume or continue that does not fork does not", () => {
    expect(launchMakesSession({})).toBe(true);
    expect(launchMakesSession({ resume: SID, fork_session: true })).toBe(true);
    expect(launchMakesSession({ continue: true, fork_session: true })).toBe(true);
    expect(launchMakesSession({ resume: SID })).toBe(false);
    expect(launchMakesSession({ continue: true, fork_session: false })).toBe(false);
  });
});

describe("LaunchCommandInputSchema", () => {
  // The id the daemon chose rides with a launch that makes a session; a resume
  // that does not fork carries none, since claude refuses --session-id there.
  test("a new session and a fork read with the new session's id and who asked", () => {
    for (const input of [
      { cwd: "/w", model: "opus", effort: "high", session_id: NEW_SID, requested_by: "user" },
      { cwd: "/w", resume: SID, fork_session: true, session_id: NEW_SID, requested_by: SID },
      { cwd: "/w", resume: SID, requested_by: "user" },
    ] as const) {
      expect(parseWith(LaunchCommandInputSchema, input)).toEqual({ ok: true, value: input });
    }
  });

  test("a session id where the launch makes none, or none where it makes one, does not read", () => {
    expect(
      commandInputRefusal({ cwd: "/w", model: "opus", effort: "high", requested_by: "user" }),
    ).toContain("session_id");
    expect(
      commandInputRefusal({ cwd: "/w", resume: SID, session_id: NEW_SID, requested_by: "user" }),
    ).toContain("session_id");
  });

  test("requested_by is the person or a session id, and the launch's checks hold", () => {
    expect(commandInputRefusal({ cwd: "/w", resume: SID, requested_by: "someone" })).toContain(
      "requested_by",
    );
    expect(
      commandInputRefusal({ cwd: "/w", continue: true, resume: SID, requested_by: "user" }),
    ).not.toBe("");
  });
});

describe("launchErrorText", () => {
  // The daemon refuses before it runs the command; only an op that threw may
  // have stopped after.
  test("a refusal is not started, internal is unconfirmed", () => {
    expect(launchErrorText({ code: "invalid_args", msg: "m" })).toEqual({
      started: "no",
      text: "ccmsg の daemon が起動を断ったので、起動していない (invalid_args): m",
    });
    expect(launchErrorText({ code: "internal", msg: "boom" })).toEqual({
      started: "unknown",
      text: "起動したか確かめられなかった: boom",
    });
  });
});
