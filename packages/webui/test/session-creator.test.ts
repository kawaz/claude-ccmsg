// DR-0018 §3.9: the launch form's model (session-creator.ts) — which fields
// each launch type shows, what the form sends and what it refuses to send, the
// two prefills, and the URL seed the form opens from.
import { describe, expect, test } from "bun:test";
import {
  LaunchEffortSchema,
  LaunchInputSchema,
  LaunchModelSchema,
  type LaunchInput,
} from "@ccmsg/protocol";
import {
  checkSessionCreatorForm,
  commitCwdInput,
  forkPrefill,
  initialCwdPickerMode,
  initialSessionCreatorForm,
  launchCandidate,
  launchEffortFromTranscript,
  launchFieldRule,
  launchModelFromTranscript,
  LAUNCH_EFFORTS,
  LAUNCH_MODELS,
  LAUNCH_TEXT_FIELDS,
  LAUNCH_TYPES,
  prefillSidebarState,
  type SessionCreatorForm,
} from "../src/client/session-creator.ts";
import { LAUNCH_FORM_FIELDS, type LaunchSeed } from "../src/client/sidebar-url.ts";
import { initialState, reducer } from "../src/client/store.ts";
import { fullSessionStatusSnapshot } from "./session-status-fixture.ts";

const SID = "aaaaaaaa-0000-4000-8000-000000000001";
const AT = "bbbbbbbb-0000-4000-8000-000000000002";

/** A form on `type` with the given values and every other field blank. */
function form(
  type: SessionCreatorForm["type"],
  values: Partial<SessionCreatorForm["values"]> = {},
): SessionCreatorForm {
  return { type, values: { ...initialSessionCreatorForm({}).values, ...values } };
}

/** The form a prefill's link opens: the caller builds `sb.*`, the form reads
 * only that — the same two steps as the app. */
function formFromLink(seed: LaunchSeed): SessionCreatorForm {
  return initialSessionCreatorForm(seed);
}

describe("the vocabulary comes from the protocol", () => {
  test("the four types, in the schema's order", () => {
    expect(LAUNCH_TYPES).toEqual(["new", "continue", "resume", "fork"]);
  });

  test("model / effort options are the picklists verbatim", () => {
    expect(LAUNCH_MODELS).toEqual(LaunchModelSchema.options);
    expect(LAUNCH_EFFORTS).toEqual(LaunchEffortSchema.options);
  });

  // The form's field list is written by hand (it is also the URL grammar and the
  // render order), so it is held to the schema here: a field added to a launch
  // type fails this until the form has it.
  test("the form's fields are exactly the union of the four types' fields", () => {
    const schemaFields = new Set(
      LaunchInputSchema.options.flatMap((option) => Object.keys(option.entries)),
    );
    expect(new Set<string>(LAUNCH_FORM_FIELDS)).toEqual(schemaFields);
  });
});

describe("launchFieldRule: which fields a type shows", () => {
  const table = (type: SessionCreatorForm["type"]) =>
    Object.fromEntries(LAUNCH_TEXT_FIELDS.map((field) => [field, launchFieldRule(type, field)]));

  test("new requires cwd, model and effort, and takes no source session", () => {
    expect(table("new")).toEqual({
      resume_session_id: undefined,
      resume_at: undefined,
      cwd: "required",
      model: "required",
      effort: "required",
      name: "optional",
      prompt: "optional",
    });
  });

  test("continue leaves model and effort to the launch command", () => {
    expect(table("continue")).toEqual({
      resume_session_id: undefined,
      resume_at: undefined,
      cwd: "required",
      model: "optional",
      effort: "optional",
      name: "optional",
      prompt: "optional",
    });
  });

  test("resume requires the session, and has no fork point", () => {
    expect(table("resume")).toMatchObject({
      resume_session_id: "required",
      resume_at: undefined,
      model: "optional",
    });
  });

  test("fork requires the session, and the fork point may be left out", () => {
    expect(table("fork")).toMatchObject({
      resume_session_id: "required",
      resume_at: "optional",
      model: "optional",
    });
  });
});

describe("initialSessionCreatorForm: the URL seed", () => {
  test("no seed opens new with every field blank", () => {
    expect(initialSessionCreatorForm({})).toEqual({
      type: "new",
      values: {
        resume_session_id: "",
        resume_at: "",
        cwd: "",
        model: "",
        effort: "",
        name: "",
        prompt: "",
      },
    });
  });

  test("an unknown type opens new", () => {
    expect(initialSessionCreatorForm({ type: "template" }).type).toBe("new");
  });

  // The select has no option to show such a value, so it opens on 指定しない
  // rather than showing one value and sending another.
  test("a model or effort outside the picklists opens blank", () => {
    const opened = initialSessionCreatorForm({ type: "resume", model: "sol", effort: "turbo" });
    expect(opened.values.model).toBe("");
    expect(opened.values.effort).toBe("");
  });

  // Text fields are the user's to see and fix; the schema judges them on submit.
  test("text values open verbatim, even ones the schema will refuse", () => {
    const opened = initialSessionCreatorForm({
      type: "fork",
      resume_session_id: "not-a-uuid",
      cwd: "relative/dir",
      prompt: "a\nb",
    });
    expect(opened.values).toMatchObject({
      resume_session_id: "not-a-uuid",
      cwd: "relative/dir",
      prompt: "a\nb",
    });
  });
});

describe("launchCandidate: what the form puts in front of the schema", () => {
  test("a blank optional field is left out, a blank required one goes in as empty", () => {
    expect(launchCandidate(form("new", { cwd: "/repo" }))).toEqual({
      type: "new",
      cwd: "/repo",
      model: "",
      effort: "",
    });
  });

  // Switching type keeps the text (resume → fork → resume keeps the id), but a
  // field the type does not take never travels.
  test("a field the type does not take is not sent, whatever it holds", () => {
    const values = { cwd: "/repo", resume_session_id: SID, resume_at: AT };
    expect(launchCandidate(form("continue", values))).toEqual({ type: "continue", cwd: "/repo" });
    expect(launchCandidate(form("resume", values))).toEqual({
      type: "resume",
      cwd: "/repo",
      resume_session_id: SID,
    });
  });

  test("values are trimmed, except the prompt", () => {
    expect(
      launchCandidate(
        form("resume", { cwd: " /repo ", resume_session_id: ` ${SID}\n`, prompt: "  go  " }),
      ),
    ).toEqual({ type: "resume", cwd: "/repo", resume_session_id: SID, prompt: "  go  " });
  });

  test("a whitespace-only name or prompt counts as not given", () => {
    expect(launchCandidate(form("continue", { cwd: "/repo", name: "  ", prompt: "\n" }))).toEqual({
      type: "continue",
      cwd: "/repo",
    });
  });
});

describe("checkSessionCreatorForm: only what the schema reads is sent", () => {
  test("a complete new launch reads as the launch to send", () => {
    expect(
      checkSessionCreatorForm(
        form("new", { cwd: "/repo", model: "opus", effort: "high", name: "w", prompt: "hi" }),
      ),
    ).toEqual({
      ok: true,
      launch: {
        type: "new",
        cwd: "/repo",
        model: "opus",
        effort: "high",
        name: "w",
        prompt: "hi",
      },
    });
  });

  test("new without a model or effort is refused, with the reason on each field", () => {
    const check = checkSessionCreatorForm(form("new", { cwd: "/repo" }));
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(Object.keys(check.issues).sort()).toEqual(["effort", "model"]);
    expect(check.general).toEqual([]);
  });

  test("a relative cwd and a malformed session id are refused with the schema's reasons", () => {
    const check = checkSessionCreatorForm(
      form("fork", { cwd: "repo", resume_session_id: "abc", resume_at: "xyz" }),
    );
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.issues).toEqual({
      cwd: "must be an absolute path",
      resume_session_id: "must be a uuid",
      resume_at: "must be a uuid",
    });
  });

  test("a blank cwd is refused on the cwd field", () => {
    const check = checkSessionCreatorForm(form("continue"));
    expect(check.ok ? null : check.issues).toEqual({ cwd: "must be an absolute path" });
  });

  test("continue / resume / fork read without model, effort or a fork point", () => {
    expect(checkSessionCreatorForm(form("continue", { cwd: "/r" }))).toEqual({
      ok: true,
      launch: { type: "continue", cwd: "/r" },
    });
    expect(checkSessionCreatorForm(form("fork", { cwd: "/r", resume_session_id: SID }))).toEqual({
      ok: true,
      launch: { type: "fork", cwd: "/r", resume_session_id: SID },
    });
  });
});

describe("launchModelFromTranscript / launchEffortFromTranscript", () => {
  test("a claude model id reduces to its family", () => {
    expect(launchModelFromTranscript("claude-fable-5[1m]")).toBe("fable");
    expect(launchModelFromTranscript("claude-opus-5-5")).toBe("opus");
    expect(launchModelFromTranscript("claude-haiku-5-5")).toBe("haiku");
  });

  test("a family spelling reads as itself, with or without a context suffix", () => {
    expect(launchModelFromTranscript("sonnet")).toBe("sonnet");
    expect(launchModelFromTranscript("opus[1m]")).toBe("opus");
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

describe("prefill: Session Search の「resume」", () => {
  test("type resume with the session, its cwd, model / effort and its title as the name", () => {
    const link = prefillSidebarState({
      kind: "resume",
      sessionId: SID,
      cwd: "/repos/app",
      model: "claude-fable-5[1m]",
      effort: "medium",
      title: "release prep",
    });
    expect(link.panel).toBe("session-creator");
    expect(link.launch).toEqual({
      type: "resume",
      resume_session_id: SID,
      cwd: "/repos/app",
      model: "fable",
      effort: "medium",
      name: "release prep",
    });
    expect(formFromLink(link.launch)).toEqual(
      form("resume", {
        resume_session_id: SID,
        cwd: "/repos/app",
        model: "fable",
        effort: "medium",
        name: "release prep",
      }),
    );
  });

  test("a blank cwd or title and an unmappable model are left out of the link", () => {
    const link = prefillSidebarState({
      kind: "resume",
      sessionId: SID,
      cwd: " ",
      model: "gpt-5.6-sol",
      title: "",
    });
    expect(link.launch).toEqual({ type: "resume", resume_session_id: SID });
  });
});

describe("prefill: Timeline の「ここから fork」", () => {
  const opusHigh = new Map([
    [
      SID,
      {
        ...fullSessionStatusSnapshot(),
        context: {
          tokens: 1,
          model: "claude-opus-5-5",
          effort: "high",
          timestamp: "2026-10-25T00:00:00.000Z",
        },
      },
    ],
  ]);

  test("a connected session: its cwd, model / effort and its title as the name", () => {
    const state = {
      ...initialState(),
      peers: [{ sid: SID, repo: "app", ws: "main", cwd: "/repos/app/main" }],
      agents: [
        {
          pid: 1,
          cwd: "/repos/app/main",
          kind: "interactive",
          startedAt: 0,
          sessionId: SID,
          name: "release prep",
          config_dir: "/home/u/.claude",
        },
      ],
      sessionStatuses: opusHigh,
    };
    const link = prefillSidebarState(forkPrefill(state, SID, AT));
    const expected: LaunchInput = {
      type: "fork",
      resume_session_id: SID,
      resume_at: AT,
      cwd: "/repos/app/main",
      model: "opus",
      effort: "high",
      name: "release prep",
    };
    expect(link.launch).toEqual(expected);
    expect(checkSessionCreatorForm(formFromLink(link.launch))).toEqual({
      ok: true,
      launch: expected,
    });
  });

  // A session opened from Session Search is not connected: no peers / agents
  // row, but the hit it was opened from read cwd and title off its transcript.
  test("a session opened from Session Search takes cwd and title from its hit", () => {
    const opened = reducer(initialState(), {
      type: "session-search/opened",
      hit: {
        sid: SID,
        config_dir: "/home/u/.claude",
        file: `/home/u/.claude/projects/p/${SID}.jsonl`,
        cwd: "/repos/app/feature",
        repo: null,
        ws: null,
        created_at: "2026-10-25T00:00:00.000Z",
        updated_at: "2026-10-25T00:00:00.000Z",
        size: 1,
        matches: [],
        title: "old work",
      },
      search: { queryText: "x", caseSensitive: false, regex: false },
    });
    const state = { ...opened, sessionStatuses: opusHigh };
    expect(prefillSidebarState(forkPrefill(state, SID, AT)).launch).toEqual({
      type: "fork",
      resume_session_id: SID,
      resume_at: AT,
      cwd: "/repos/app/feature",
      model: "opus",
      effort: "high",
      name: "old work",
    });
  });

  // Nothing the client holds knows the session: the link still opens the fork,
  // with the cwd picker empty for the user to choose.
  test("what the state does not know is left out", () => {
    expect(prefillSidebarState(forkPrefill(initialState(), SID, AT)).launch).toEqual({
      type: "fork",
      resume_session_id: SID,
      resume_at: AT,
    });
  });
});

// issue 2026-07-17-session-creator-cwd-picker-unify: CwdPicker's
// editing / confirmed toggle.
describe("initialCwdPickerMode", () => {
  test("editing when cwd is blank", () => {
    expect(initialCwdPickerMode("")).toBe("editing");
    expect(initialCwdPickerMode("   ")).toBe("editing");
  });

  test("confirmed when a cwd is already set (a prefill or the URL brought it)", () => {
    expect(initialCwdPickerMode("/repo")).toBe("confirmed");
  });
});

describe("commitCwdInput", () => {
  test("null on a blank value — an empty Enter press is a no-op", () => {
    expect(commitCwdInput("")).toBeNull();
    expect(commitCwdInput("   ")).toBeNull();
  });

  test("trims and confirms a directly-typed path", () => {
    expect(commitCwdInput("  /repo/deep/path  ")).toEqual({
      cwd: "/repo/deep/path",
      mode: "confirmed",
    });
  });
});
