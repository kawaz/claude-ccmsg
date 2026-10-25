// The launch a person or an agent asks for, and what the launch command reads
// on standard input (DR-0018 §3.2, §3.3): four types, each strict, and the new
// session's id only where the daemon chooses one.
import { describe, expect, test } from "bun:test";
import { LaunchCommandInputSchema, LaunchInputSchema } from "../src/launch.ts";
import { parseWith } from "../src/parse.ts";

const SID = "11111111-2222-4333-8444-555555555555";
const NEW_SID = "99999999-8888-4777-8666-555555555555";

/** Why `value` does not read as a launch, or "" when it does. */
function launchRefusal(value: object): string {
  const read = parseWith(LaunchInputSchema, value);
  return read.ok ? "" : read.failure.summary;
}

function commandInputRefusal(value: object): string {
  const read = parseWith(LaunchCommandInputSchema, value);
  return read.ok ? "" : read.failure.summary;
}

describe("LaunchInputSchema", () => {
  // The smallest launch of each type: what each type cannot do without.
  test("each type reads with its required fields alone", () => {
    for (const launch of [
      { type: "new", cwd: "/w", model: "opus", effort: "high" },
      { type: "continue", cwd: "/w" },
      { type: "resume", cwd: "/w", resume_session_id: SID },
      { type: "fork", cwd: "/w", resume_session_id: SID },
    ] as const) {
      expect(parseWith(LaunchInputSchema, launch)).toEqual({ ok: true, value: launch });
    }
  });

  // Every optional field a type has, read as given.
  test("each type reads its optional fields as given", () => {
    const fork = {
      type: "fork" as const,
      cwd: "/w",
      model: "haiku" as const,
      effort: "max" as const,
      name: "n",
      prompt: "line 1\nline 2",
      resume_session_id: SID,
      resume_at: NEW_SID,
    };
    expect(parseWith(LaunchInputSchema, fork)).toEqual({ ok: true, value: fork });
    const resume = {
      type: "resume" as const,
      cwd: "/w",
      model: "fable" as const,
      resume_session_id: SID,
      name: "r",
    };
    expect(parseWith(LaunchInputSchema, resume)).toEqual({ ok: true, value: resume });
  });

  // `new` has no session to take a model or effort from, so it names both.
  test("new without a model or an effort does not read", () => {
    expect(launchRefusal({ type: "new", cwd: "/w", effort: "high" })).toContain("model");
    expect(launchRefusal({ type: "new", cwd: "/w", model: "opus" })).toContain("effort");
  });

  // A field the type has no use for is refused, not dropped: the caller would
  // otherwise believe it took effect.
  test("a field of another type does not read", () => {
    expect(
      launchRefusal({
        type: "new",
        cwd: "/w",
        model: "opus",
        effort: "low",
        resume_session_id: SID,
      }),
    ).toContain("resume_session_id");
    expect(launchRefusal({ type: "continue", cwd: "/w", resume_session_id: SID })).toContain(
      "resume_session_id",
    );
    expect(
      launchRefusal({ type: "resume", cwd: "/w", resume_session_id: SID, resume_at: SID }),
    ).toContain("resume_at");
    // session_id is the daemon's to add, never the caller's.
    expect(launchRefusal({ type: "continue", cwd: "/w", session_id: SID })).toContain("session_id");
  });

  // "Not given" is said one way, by leaving the field out.
  test("an empty name or prompt does not read", () => {
    expect(launchRefusal({ type: "continue", cwd: "/w", name: "" })).toContain("name");
    expect(launchRefusal({ type: "continue", cwd: "/w", prompt: "" })).toContain("prompt");
  });

  test("a relative cwd does not read", () => {
    expect(launchRefusal({ type: "continue", cwd: "w" })).toContain("must be an absolute path");
  });

  test("resume and fork need a uuid to continue from", () => {
    expect(launchRefusal({ type: "resume", cwd: "/w" })).toContain("resume_session_id");
    expect(launchRefusal({ type: "fork", cwd: "/w", resume_session_id: "abc" })).toContain(
      "must be a uuid",
    );
    expect(
      launchRefusal({ type: "fork", cwd: "/w", resume_session_id: SID, resume_at: "abc" }),
    ).toContain("must be a uuid");
  });

  test("a model, effort or type outside the lists does not read", () => {
    expect(launchRefusal({ type: "new", cwd: "/w", model: "gpt", effort: "high" })).toContain(
      "model",
    );
    expect(launchRefusal({ type: "continue", cwd: "/w", effort: "extreme" })).toContain("effort");
    expect(launchRefusal({ type: "restart", cwd: "/w" })).toContain("type");
  });
});

describe("LaunchCommandInputSchema", () => {
  // new and fork carry the id the daemon chose; continue and resume carry
  // none, since claude refuses --session-id on a resume that does not fork.
  test("new and fork read with the new session's id", () => {
    for (const input of [
      { type: "new", cwd: "/w", model: "opus", effort: "high", session_id: NEW_SID },
      { type: "fork", cwd: "/w", resume_session_id: SID, session_id: NEW_SID },
    ] as const) {
      expect(parseWith(LaunchCommandInputSchema, input)).toEqual({ ok: true, value: input });
    }
  });

  test("new and fork without the new session's id do not read", () => {
    expect(
      commandInputRefusal({ type: "new", cwd: "/w", model: "opus", effort: "high" }),
    ).toContain("session_id");
    expect(commandInputRefusal({ type: "fork", cwd: "/w", resume_session_id: SID })).toContain(
      "session_id",
    );
  });

  test("continue and resume with a session id do not read", () => {
    expect(commandInputRefusal({ type: "continue", cwd: "/w", session_id: NEW_SID })).toContain(
      "session_id",
    );
    expect(
      commandInputRefusal({
        type: "resume",
        cwd: "/w",
        resume_session_id: SID,
        session_id: NEW_SID,
      }),
    ).toContain("session_id");
  });
});
