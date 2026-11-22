// The launch a person or an agent asks for, and what the launch command reads
// on standard input (DR-0018 §3.2, §3.3): claude's options as fields, the
// combinations claude refuses or ignores refused on the field to change, and
// the new session's id only where the daemon chooses one.
import { describe, expect, test } from "bun:test";
import {
  LAUNCH_CHOOSE_MESSAGE,
  LaunchCommandInputSchema,
  LaunchInputSchema,
  launchEffortFromTranscript,
  launchErrorText,
  launchMakesSession,
  launchModelFromTranscript,
  launchRunsAs,
  namedRunsAs,
  spelledRunsAs,
} from "../src/launch.ts";
import { parseWith } from "../src/parse.ts";

const SID = "11111111-2222-4333-8444-555555555555";
const NEW_SID = "99999999-8888-4777-8666-555555555555";

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

  // A fork copies a session: without one to copy, claude starts a new
  // session and ignores it.
  test("fork_session without continue or resume does not read, on fork_session", () => {
    const issues = launchIssues({
      cwd: "/w",
      model: "opus",
      effort: "low",
      fork_session: true,
    });
    expect(issues).toEqual({ fork_session: "continue か resume と一緒に指定する" });
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
  test("resume takes a lowercase uuid", () => {
    expect(launchIssues({ cwd: "/w", resume: "abc" })).toEqual({
      resume: "小文字の uuid で指定する",
    });
    expect(
      launchIssues({ cwd: "/w", resume: "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE" }),
    ).toHaveProperty("resume");
  });

  // Every model of the list reads, mythos (the one above fable) included.
  test("each model of the list reads", () => {
    for (const model of ["mythos", "fable", "opus", "sonnet", "haiku"]) {
      expect(launchIssues({ cwd: "/w", model, effort: "low" })).toEqual({});
    }
  });

  test("a model or effort outside the lists, or a non-boolean option, does not read", () => {
    expect(launchIssues({ cwd: "/w", model: "gpt", effort: "high" })).toHaveProperty("model");
    expect(launchIssues({ cwd: "/w", model: "claude-mythos-5", effort: "low" })).toHaveProperty(
      "model",
    );
    expect(launchIssues({ cwd: "/w", continue: true, effort: "extreme" })).toHaveProperty("effort");
    expect(launchIssues({ cwd: "/w", continue: "true" })).toHaveProperty("continue");
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
  test("a new session and a fork read with the new session's id", () => {
    for (const input of [
      { cwd: "/w", model: "opus", effort: "high", session_id: NEW_SID },
      { cwd: "/w", resume: SID, fork_session: true, session_id: NEW_SID },
      { cwd: "/w", resume: SID },
    ] as const) {
      expect(parseWith(LaunchCommandInputSchema, input)).toEqual({ ok: true, value: input });
    }
  });

  test("a session id where the launch makes none, or none where it makes one, does not read", () => {
    expect(commandInputRefusal({ cwd: "/w", model: "opus", effort: "high" })).toContain(
      "session_id",
    );
    expect(commandInputRefusal({ cwd: "/w", resume: SID, session_id: NEW_SID })).toContain(
      "session_id",
    );
  });

  // Every field is a claude option: who asked is the environment's
  // (LAUNCH_REQUESTED_BY_ENV), not a field.
  test("a field that is not a claude option does not read, and the launch's checks hold", () => {
    expect(commandInputRefusal({ cwd: "/w", resume: SID, requested_by: "user" })).toContain(
      "requested_by",
    );
    expect(commandInputRefusal({ cwd: "/w", continue: true, resume: SID })).not.toBe("");
  });

  // `settings` is `--settings`, the file the daemon made of the project's
  // autoMode (DR-0063 §5): any way to start may carry it, as an absolute path.
  test("every way to start reads with the settings file's absolute path", () => {
    const settings = "/state/launch-settings/0f.json";
    for (const input of [
      { cwd: "/w", model: "opus", effort: "high", session_id: NEW_SID, settings },
      { cwd: "/w", continue: true, settings },
      { cwd: "/w", resume: SID, settings },
      { cwd: "/w", resume: SID, fork_session: true, session_id: NEW_SID, settings },
    ] as const) {
      expect(parseWith(LaunchCommandInputSchema, input)).toEqual({ ok: true, value: input });
    }
    expect(commandInputRefusal({ cwd: "/w", resume: SID, settings: "launch.json" })).toContain(
      "settings",
    );
  });

  // The asker's launch has no `settings`: only the daemon puts it in the
  // command's input (DR-0063 §5), so a launch naming one is refused.
  test("a launch that names settings does not read", () => {
    expect(launchIssues({ cwd: "/w", resume: SID, settings: "/tmp/s.json" })).toHaveProperty(
      "settings",
    );
  });
});

describe("LaunchCommandInputSchema: a print launch (DR-0064 §2)", () => {
  /** A btw's fork as the daemon hands it to the launch command. */
  const btwFork = {
    cwd: "/w",
    resume: SID,
    fork_session: true,
    session_id: NEW_SID,
    print: true,
    no_session_persistence: true,
    output_format: "stream-json",
    verbose: true,
    include_partial_messages: true,
    permission_prompts: "none",
    model: "claude-opus-5-5[1m]",
    effort: "high",
    settings: "/state/launch-settings/0f.json",
    prompt: "<btw>\n...\n</btw>\n\nq",
  } as const;

  function issuesOf(value: object): Record<string, string> {
    const read = parseWith(LaunchCommandInputSchema, value);
    if (read.ok) return {};
    return Object.fromEntries(read.failure.issues.map((issue) => [issue.path, issue.message]));
  }

  test("a btw's fork reads with every print option, the model as the id the session answered as", () => {
    expect(parseWith(LaunchCommandInputSchema, btwFork)).toEqual({ ok: true, value: btwFork });
    // A fork whose model the daemon could not tell goes without one.
    const { model: _model, effort: _effort, ...bare } = btwFork;
    expect(parseWith(LaunchCommandInputSchema, bare)).toEqual({ ok: true, value: bare });
  });

  // The model of a launch that is not print stays the launch's list: an id
  // such as `[1m]` is for the fork alone, whose cache depends on it.
  test("a model outside the launch's list reads only with print", () => {
    const {
      print: _print,
      no_session_persistence: _n,
      output_format: _o,
      verbose: _v,
      include_partial_messages: _i,
      permission_prompts: _p,
      ...notPrint
    } = btwFork;
    expect(issuesOf(notPrint)).toHaveProperty("model");
    expect(issuesOf({ ...notPrint, model: "opus" })).toEqual({});
  });

  // The effort, like the model, goes as the session spells it (DR-0060 §2):
  // outside the launch's list only with print.
  test("an effort outside the launch's list reads only with print", () => {
    expect(parseWith(LaunchCommandInputSchema, { ...btwFork, effort: "ultra" }).ok).toBe(true);
    expect(issuesOf({ cwd: "/w", resume: SID, effort: "ultra" })).toHaveProperty("effort");
    expect(issuesOf({ ...btwFork, effort: "" })).toHaveProperty("effort");
  });

  // A print launch is a btw's fork of the session it is asked of: without a
  // session to fork it does not read, on print (not on the model a new
  // session would need).
  test("print without resume and fork_session does not read, on print", () => {
    const { resume: _resume, fork_session: _fork, session_id: _id, ...noSource } = btwFork;
    expect(issuesOf({ ...noSource, session_id: NEW_SID })).toMatchObject({
      print: "resume と fork_session と一緒に指定する (print の起動はセッションの fork)",
    });
    const { fork_session: _f, session_id: _s, ...notFork } = btwFork;
    expect(issuesOf(notFork)).toHaveProperty("print");
    expect(issuesOf({ ...btwFork, resume: undefined, continue: true })).toHaveProperty("print");
  });

  // claude takes these with --print alone (`claude --help`): a launch that is
  // not print does not carry them.
  test("each print option without print does not read, on the option", () => {
    const base = { cwd: "/w", resume: SID };
    expect(issuesOf({ ...base, no_session_persistence: true })).toEqual({
      no_session_persistence: "print と一緒に指定する",
    });
    expect(issuesOf({ ...base, output_format: "json" })).toEqual({
      output_format: "print と一緒に指定する",
    });
    expect(issuesOf({ ...base, permission_prompts: "none" })).toEqual({
      permission_prompts: "print と一緒に指定する",
    });
    expect(issuesOf({ ...base, print: false, no_session_persistence: true })).toHaveProperty(
      "no_session_persistence",
    );
  });

  // `--output-format stream-json` without `--verbose` does not start, and
  // partial messages come in stream-json alone.
  test("stream-json without verbose, or partial messages without stream-json, does not read", () => {
    const { verbose: _verbose, ...noVerbose } = btwFork;
    expect(issuesOf(noVerbose)).toEqual({
      output_format: "stream-json は verbose と一緒に指定する",
    });
    expect(issuesOf({ ...btwFork, output_format: "json" })).toEqual({
      include_partial_messages: "output_format の stream-json と一緒に指定する",
    });
  });

  // The print options are the daemon's alone: the asker's launch (the form,
  // the `launch` tool, session_launch) cannot name them.
  test("a launch that names a print option does not read", () => {
    for (const field of [
      { print: true },
      { no_session_persistence: true },
      { output_format: "stream-json" },
      { verbose: true },
      { include_partial_messages: true },
      { permission_prompts: "none" },
    ]) {
      expect(Object.keys(launchIssues({ cwd: "/w", resume: SID, ...field }))).toEqual(
        Object.keys(field),
      );
    }
  });

  test("the print launch keeps the launch's own checks and its session id", () => {
    const { session_id: _id, ...noId } = btwFork;
    expect(issuesOf(noId)).toHaveProperty("session_id");
    expect(issuesOf({ ...btwFork, continue: true })).not.toEqual({});
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

describe("launchModelFromTranscript / launchEffortFromTranscript", () => {
  test("a claude model id reduces to its family", () => {
    expect(launchModelFromTranscript("claude-fable-5[1m]")).toBe("fable");
    expect(launchModelFromTranscript("claude-opus-5-5")).toBe("opus");
    expect(launchModelFromTranscript("claude-haiku-5-5")).toBe("haiku");
    expect(launchModelFromTranscript("claude-mythos-5")).toBe("mythos");
    expect(launchModelFromTranscript("claude-mythos-5-1[1m]")).toBe("mythos");
  });

  test("a family spelling reads as itself, with or without a context suffix", () => {
    expect(launchModelFromTranscript("sonnet")).toBe("sonnet");
    expect(launchModelFromTranscript("opus[1m]")).toBe("opus");
    expect(launchModelFromTranscript("mythos[1m]")).toBe("mythos");
  });

  test("anything else has no model", () => {
    expect(launchModelFromTranscript("gpt-5.6-sol")).toBeUndefined();
    expect(launchModelFromTranscript("<synthetic>")).toBeUndefined();
  });

  test("an effort is a membership check", () => {
    expect(launchEffortFromTranscript("xhigh")).toBe("xhigh");
    expect(launchEffortFromTranscript("turbo")).toBeUndefined();
  });
});

// What a session runs as (DR-0018 §3.2, DR-0028 「restart」 step 3): the one
// definition the daemon fills a resume with and the webui's Status forms open
// on (through the daemon's `session_runs_as`, or the tab's own reading for
// the fork).
describe("launchRunsAs", () => {
  const session = { model: "opus", effort: "xhigh" };
  const own = { model: "fable[1m]", effort: "low" };
  const answered = { model: "claude-sonnet-5-5", effort: "medium" };

  test("the session override's values come first, then the session's own, then what it answered as", () => {
    expect(launchRunsAs({ session, own, answered })).toEqual({ model: "opus", effort: "xhigh" });
    expect(launchRunsAs({ own, answered })).toEqual({ model: "fable", effort: "low" });
    expect(launchRunsAs({ answered })).toEqual({ model: "sonnet", effort: "medium" });
    expect(launchRunsAs({})).toEqual({});
  });

  // A module reports a field nothing names yet as null (RequestValues), and
  // its facts leave out what it does not know.
  test("each field falls through on its own, past a null or an absent value", () => {
    expect(
      launchRunsAs({
        session: { model: "haiku", effort: null },
        own: { model: "fable" },
        answered,
      }),
    ).toEqual({ model: "haiku", effort: "medium" });
    expect(
      launchRunsAs({ session: { model: null, effort: null }, own: { effort: "high" }, answered }),
    ).toEqual({ model: "sonnet", effort: "high" });
  });

  test("a first spelling that names no picklist value leaves the field out, with no fall back", () => {
    expect(launchRunsAs({ own: { model: "<synthetic>", effort: "turbo" }, answered })).toEqual({});
  });
});

// launchRunsAs in two steps: which source decides (spelledRunsAs), then the
// launch's vocabulary (namedRunsAs). The daemon answers the first step to
// the webui's Status forms (`session_runs_as`) so a form can tell a value it
// cannot name (asking for a choice) from none at all (the defaults), and
// reads it with the second step, as the form does, into what a restart is
// filled with.
describe("spelledRunsAs and namedRunsAs", () => {
  test("the deciding source's spelling is kept as it is, one the picklist cannot name included", () => {
    expect(
      spelledRunsAs({
        session: { model: null, effort: null },
        own: { model: "gpt-5", effort: "12000" },
        answered: { model: "claude-mythos-5-2", effort: "low" },
      }),
    ).toEqual({ model: "gpt-5", effort: "12000" });
    expect(spelledRunsAs({ answered: { model: "claude-mythos-5-2" } })).toEqual({
      model: "claude-mythos-5-2",
    });
    expect(spelledRunsAs({})).toEqual({});
  });

  test("named, a spelling of a family is the family and one the picklist cannot name is left out", () => {
    expect(namedRunsAs({ model: "claude-mythos-5-2", effort: "low" })).toEqual({
      model: "mythos",
      effort: "low",
    });
    expect(namedRunsAs({ model: "mythos[1m]", effort: "12000" })).toEqual({ model: "mythos" });
    expect(namedRunsAs({ model: "gpt-5" })).toEqual({});
  });
});
