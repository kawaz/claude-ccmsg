// DR-0018 §3.9: the launch form's model (session-creator.ts) — every field at
// once, the model / effort the selects show by default, what the form sends
// and what it refuses to send, the resume prefill, and the URL seed the form
// opens from.
import { describe, expect, test } from "bun:test";
import {
  LAUNCH_CHOOSE_MESSAGE,
  LaunchEffortSchema,
  LaunchFieldsSchema,
  LaunchModelSchema,
  type LaunchInput,
} from "@ccmsg/protocol";
import {
  checkSessionCreatorForm,
  commitCwdInput,
  DEFAULT_LAUNCH_EFFORT,
  formContinues,
  formMakesSession,
  initialCwdPickerMode,
  initialSessionCreatorForm,
  launchCandidate,
  LAUNCH_EFFORTS,
  LAUNCH_MODELS,
  prefillSidebarState,
  shownEffort,
  shownModel,
  type SessionCreatorForm,
} from "../src/client/session-creator.ts";
import { LAUNCH_FORM_FIELDS, type LaunchSeed } from "../src/client/sidebar-url.ts";

const SID = "aaaaaaaa-0000-4000-8000-000000000001";

/** A form with the given fields and every other one blank. */
function form(fields: Partial<SessionCreatorForm> = {}): SessionCreatorForm {
  return { ...initialSessionCreatorForm({}), ...fields };
}

/** The form a prefill's link opens: the caller builds `sb.*`, the form reads
 * only that — the same two steps as the app. */
function formFromLink(seed: LaunchSeed): SessionCreatorForm {
  return initialSessionCreatorForm(seed);
}

describe("the vocabulary comes from the protocol", () => {
  test("model / effort options are the picklists verbatim", () => {
    expect(LAUNCH_MODELS).toEqual(LaunchModelSchema.options);
    expect(LAUNCH_EFFORTS).toEqual(LaunchEffortSchema.options);
  });

  // The form's field list is written by hand (it is also the URL grammar), so
  // it is held to the schema here: a field added to a launch fails this until
  // the form has it.
  test("the form's fields are exactly the launch's fields", () => {
    expect(new Set<string>(LAUNCH_FORM_FIELDS)).toEqual(
      new Set(Object.keys(LaunchFieldsSchema.entries)),
    );
  });
});

describe("initialSessionCreatorForm: the URL seed", () => {
  test("no seed opens with every field blank and nothing chosen", () => {
    expect(initialSessionCreatorForm({})).toEqual({
      cwd: "",
      model: undefined,
      effort: undefined,
      continue: false,
      resume: "",
      fork_session: false,
      name: "",
      prompt: "",
    });
  });

  test("an option is on only when its seed is true", () => {
    expect(initialSessionCreatorForm({ continue: "true", fork_session: "yes" })).toMatchObject({
      continue: true,
      fork_session: false,
    });
  });

  test("a model or effort outside the picklists opens on the default", () => {
    expect(initialSessionCreatorForm({ model: "gpt", effort: "turbo" })).toMatchObject({
      model: undefined,
      effort: undefined,
    });
  });

  test("text values open verbatim, even ones the schema will refuse", () => {
    expect(
      initialSessionCreatorForm({ cwd: "relative", resume: "not-a-uuid", model: "opus" }),
    ).toMatchObject({ cwd: "relative", resume: "not-a-uuid", model: "opus" });
  });
});

describe("DEFAULT_LAUNCH_EFFORT: the effort each model starts on", () => {
  // ccmsg's own table (DR-0018 §3.9): fable low, opus medium as kawaz set
  // them; every model of the picklist has one, so a model chosen always
  // brings an effort.
  test("fable low, opus medium, sonnet medium, haiku low — one per model", () => {
    expect(DEFAULT_LAUNCH_EFFORT).toEqual({
      fable: "low",
      opus: "medium",
      sonnet: "medium",
      haiku: "low",
    });
    expect(Object.keys(DEFAULT_LAUNCH_EFFORT)).toEqual([...LaunchModelSchema.options]);
  });
});

describe("shownModel / shownEffort: what the selects open on", () => {
  // A new session must name both: fable, and its effort from ccmsg's table.
  test("a new session shows fable and low", () => {
    expect(shownModel(form())).toBe("fable");
    expect(shownEffort(form())).toBe("low");
  });

  // Choosing a model leaves the effort to follow it (the component clears
  // the effort's choice): the new model's default from the table.
  test("the effort is the shown model's default", () => {
    expect(shownEffort(form({ model: "opus" }))).toBe("medium");
    expect(shownEffort(form({ model: "sonnet" }))).toBe("medium");
    expect(shownEffort(form({ model: "haiku" }))).toBe("low");
    expect(shownEffort(form({ model: "fable" }))).toBe("low");
  });

  // Carrying on from a session leaves both to the launch command (指定しない).
  test("a continue or resume shows 指定しない for both", () => {
    for (const carrying of [form({ continue: true }), form({ resume: SID })]) {
      expect(formContinues(carrying)).toBe(true);
      expect(shownModel(carrying)).toBe("");
      expect(shownEffort(carrying)).toBe("");
    }
    expect(formContinues(form({ resume: "  " }))).toBe(false);
  });

  // A model named while carrying on brings its effort, as on a new session.
  test("a continue or resume that names a model shows that model's default effort", () => {
    expect(shownEffort(form({ resume: SID, model: "opus" }))).toBe("medium");
    expect(shownEffort(form({ continue: true, model: "" }))).toBe("");
  });

  test("a choice is shown as chosen, 指定しない included", () => {
    expect(shownModel(form({ model: "sonnet", resume: SID }))).toBe("sonnet");
    expect(shownEffort(form({ model: "", effort: "low" }))).toBe("low");
    expect(shownEffort(form({ model: "opus", effort: "high" }))).toBe("high");
  });
});

describe("formMakesSession: whether --session-id is generated", () => {
  test("a new session and a fork, not a continue or resume alone", () => {
    expect(formMakesSession(form())).toBe(true);
    expect(formMakesSession(form({ resume: SID, fork_session: true }))).toBe(true);
    expect(formMakesSession(form({ resume: SID }))).toBe(false);
    expect(formMakesSession(form({ continue: true }))).toBe(false);
  });
});

describe("launchCandidate: what the form puts in front of the schema", () => {
  test("a blank field and an option left off are left out; cwd goes in even blank", () => {
    expect(launchCandidate(form({ continue: true }))).toEqual({ cwd: "", continue: true });
  });

  test("a new session carries the shown model and effort", () => {
    expect(launchCandidate(form({ cwd: "/r" }))).toEqual({
      cwd: "/r",
      model: "fable",
      effort: "low",
    });
  });

  test("values are trimmed, except the prompt", () => {
    expect(
      launchCandidate(form({ cwd: " /r ", resume: ` ${SID} `, name: " n ", prompt: "  keep\n" })),
    ).toEqual({ cwd: "/r", resume: SID, name: "n", prompt: "  keep\n" });
  });

  test("a whitespace-only name or prompt counts as not given", () => {
    expect(launchCandidate(form({ cwd: "/r", continue: true, name: " ", prompt: "\n" }))).toEqual({
      cwd: "/r",
      continue: true,
    });
  });
});

describe("checkSessionCreatorForm: only what the schema reads is sent", () => {
  test("a complete new launch reads as the launch to send", () => {
    const launch: LaunchInput = {
      cwd: "/repos/app",
      model: "opus",
      effort: "high",
      name: "n",
      prompt: "p",
    };
    expect(
      checkSessionCreatorForm(
        form({ cwd: "/repos/app", model: "opus", effort: "high", name: "n", prompt: "p" }),
      ),
    ).toEqual({ ok: true, launch });
  });

  // The reason is the schema's: the webui holds no text of its own for it.
  test("a new session without an effort is refused on the field, with the schema's reason", () => {
    expect(checkSessionCreatorForm(form({ cwd: "/r", effort: "" }))).toEqual({
      ok: false,
      issues: { effort: LAUNCH_CHOOSE_MESSAGE },
      general: [],
    });
  });

  test("continue and resume together are refused on resume", () => {
    const check = checkSessionCreatorForm(form({ cwd: "/r", continue: true, resume: SID }));
    expect(check).toMatchObject({
      ok: false,
      issues: { resume: "continue と resume は同時に指定できない" },
    });
  });

  test("a fork without continue or resume is refused on --fork-session", () => {
    const check = checkSessionCreatorForm(form({ cwd: "/r", fork_session: true }));
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(Object.keys(check.issues)).toEqual(["fork_session"]);
  });

  test("a blank or relative cwd and a malformed session id are refused with the schema's reasons", () => {
    const check = checkSessionCreatorForm(form({ cwd: "", resume: "abc" }));
    expect(check).toEqual({
      ok: false,
      issues: { cwd: "絶対パスで指定する", resume: "小文字の uuid で指定する" },
      general: [],
    });
  });

  test("a continue, a resume and a fork read without a model or effort", () => {
    for (const [fields, launch] of [
      [
        { cwd: "/r", continue: true },
        { cwd: "/r", continue: true },
      ],
      [
        { cwd: "/r", resume: SID },
        { cwd: "/r", resume: SID },
      ],
      [
        { cwd: "/r", resume: SID, fork_session: true },
        { cwd: "/r", resume: SID, fork_session: true },
      ],
    ] as const) {
      expect(checkSessionCreatorForm(form(fields))).toEqual({
        ok: true,
        launch,
      });
    }
  });
});

describe("prefill: Session Search の「resume」", () => {
  test("--resume with the session, its cwd, model / effort and its title as the name", () => {
    const link = prefillSidebarState({
      sessionId: SID,
      cwd: "/repos/app",
      model: "claude-fable-5[1m]",
      effort: "medium",
      title: "release prep",
    });
    expect(link.panel).toBe("session-creator");
    expect(link.launch).toEqual({
      cwd: "/repos/app",
      model: "fable",
      effort: "medium",
      resume: SID,
      name: "release prep",
    });
    expect(formFromLink(link.launch)).toEqual(
      form({
        resume: SID,
        cwd: "/repos/app",
        model: "fable",
        effort: "medium",
        name: "release prep",
      }),
    );
  });

  test("a blank cwd or title and an unmappable model are left out of the link", () => {
    const link = prefillSidebarState({
      sessionId: SID,
      cwd: " ",
      model: "gpt-5.6-sol",
      title: "",
    });
    expect(link.launch).toEqual({ resume: SID });
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
