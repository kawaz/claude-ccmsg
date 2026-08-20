// DR-0018 §2.1: pure form-state helpers for SessionCreator.tsx (params-driven
// construction, run-button validity gate, wire-request projection).
import { describe, expect, test } from "bun:test";
import type { LauncherParam, SessionLauncherConfigTemplate } from "@ccmsg/protocol";
import {
  buildSessionLaunchRequest,
  commitCwdInput,
  plainTemplate,
  forkSourceDefaults,
  forkTemplate,
  resumeTemplate,
  initialTemplate,
  launcherEffortFromTranscript,
  launcherModelFromTranscript,
  paramWidget,
  selectSessionCreatorTemplate,
  sessionCreatorCwd,
  templateDeclares,
  initialCwdPickerMode,
  initialSessionCreatorForm,
  sessionCreatorFormValid,
  SESSION_CREATOR_EFFORTS,
  SESSION_CREATOR_MODELS,
  type SessionCreatorForm,
} from "../src/client/session-creator.ts";

/** One configured recipe, as session_launcher_config projects it. `params` is
 * written as a name→default object for readability and kept in that order — the
 * wire form is the ordered array the form renders from. */
function template(
  name: string,
  command: string,
  params: Record<string, string> = {},
): SessionLauncherConfigTemplate {
  const declared: LauncherParam[] = Object.entries(params).map(([n, d]) => ({
    name: n,
    default: d,
  }));
  return { name, command, params: declared };
}

const PLAIN = template("default", "run-launch", {
  CWD: "",
  MODEL: "fable",
  EFFORT: "medium",
  PROMPT: "hello",
});
const FORK = template("fork", 'run --resume "$RESUME_SID" --resume-session-at="$RESUME_AT"', {
  CWD: "",
  MODEL: "fable",
  EFFORT: "medium",
  PROMPT: "",
  RESUME_SID: "",
  RESUME_AT: "",
});

const RESUME = template(
  "resume",
  'run --resume "$SESSION_ID" --model "$MODEL" --effort "$EFFORT"',
  {
    CWD: "",
    SESSION_ID: "",
    MODEL: "fable",
    EFFORT: "medium",
    PROMPT: "",
  },
);

const FORK_PREFILL = { kind: "fork", resumeSid: "sid-1", resumeAt: "u-9" } as const;
const RESUME_PREFILL = { kind: "resume", cwd: "/repos/app", sessionId: "sid-1" } as const;

describe("initialSessionCreatorForm", () => {
  test("seeds every declared parameter from its configured default", () => {
    expect(initialSessionCreatorForm([PLAIN])).toEqual({
      template: "default",
      command: "run-launch",
      params: { CWD: "", MODEL: "fable", EFFORT: "medium", PROMPT: "hello" },
    });
  });

  // The declaration is the only source of fields: a recipe that declares two
  // parameters gets two, whatever the command text happens to mention.
  test("undeclared variables get no value, even when the command reads them", () => {
    const form = initialSessionCreatorForm([template("t", 'run "$MODEL" "$PROMPT"', { CWD: "" })]);
    expect(form.params).toEqual({ CWD: "" });
  });

  test("a parameter this webui has never heard of is seeded like any other", () => {
    const form = initialSessionCreatorForm([
      template("t", 'run "$BRANCH"', { CWD: "", BRANCH: "main" }),
    ]);
    expect(form.params).toEqual({ CWD: "", BRANCH: "main" });
  });

  test("carries a default verbatim, including empty and multi-line strings", () => {
    expect(initialSessionCreatorForm([template("t", "cmd", { PROMPT: "" })]).params.PROMPT).toBe(
      "",
    );
    expect(
      initialSessionCreatorForm([template("t", "cmd", { PROMPT: "multi\nline\n" })]).params.PROMPT,
    ).toBe("multi\nline\n");
  });

  // The command template is a shell body with `$CWD`/`$MODEL`/… refs — the
  // daemon never substitutes them, and neither does the form. The user should
  // see exactly what the daemon will run.
  test("carries the template's command verbatim, including $VAR refs and newlines", () => {
    const cmd = 'claude --model "$MODEL" --effort "$EFFORT"\n"$PROMPT"';
    expect(initialSessionCreatorForm([template("t", cmd)]).command).toBe(cmd);
  });

  // A fork opens on a recipe that actually declares the fork point, whatever
  // its position in the list, and carries the fork values into the form.
  test("a fork prefill opens on the fork recipe with the fork point filled in", () => {
    const form = initialSessionCreatorForm([PLAIN, FORK], FORK_PREFILL);
    expect(form).toMatchObject({ template: "fork", command: FORK.command });
    expect(form.params).toMatchObject({ RESUME_SID: "sid-1", RESUME_AT: "u-9" });
  });

  // With no fork-capable recipe configured the form still opens (on the
  // default); the fork values have nowhere to go and are dropped rather than
  // riding along invisibly in a request nothing would read.
  test("a fork prefill falls back to the default recipe, dropping undeclared fork values", () => {
    const form = initialSessionCreatorForm([PLAIN], FORK_PREFILL);
    expect(form.template).toBe("default");
    expect(form.params).not.toHaveProperty("RESUME_AT");
  });

  // Fork-source defaults win over the declared defaults, parameter by parameter.
  test("applies the fork source's cwd/model/effort when given", () => {
    const form = initialSessionCreatorForm([PLAIN, FORK], FORK_PREFILL, {
      CWD: "/repos/app",
      MODEL: "opus",
      EFFORT: "high",
    });
    expect(form.params).toMatchObject({ CWD: "/repos/app", MODEL: "opus", EFFORT: "high" });
  });

  // A resume brings its own cwd (the search hit knows where the session ran —
  // a historical session has no live peer row to inherit one from).
  test("a resume prefill opens on the resume recipe with cwd and session id filled in", () => {
    const form = initialSessionCreatorForm([PLAIN, RESUME], RESUME_PREFILL);
    expect(form).toMatchObject({ template: "resume", command: RESUME.command });
    expect(form.params).toMatchObject({ CWD: "/repos/app", SESSION_ID: "sid-1" });
  });

  // Resuming re-enters the session itself, so it has to run as what it already
  // is: without this the launcher's own default would silently switch a
  // resumed session's model.
  test("a resume prefill seeds the session's own model and effort", () => {
    const form = initialSessionCreatorForm([PLAIN, RESUME], {
      ...RESUME_PREFILL,
      model: "claude-opus-5[1m]",
      effort: "high",
    });
    expect(form.params).toMatchObject({ MODEL: "opus", EFFORT: "high" });
  });

  // Same rule as a fork's: a value with no honest mapping leaves the declared
  // default alone rather than guessing at one.
  test("a resume prefill the form cannot map keeps the declared defaults", () => {
    const form = initialSessionCreatorForm([PLAIN, RESUME], {
      ...RESUME_PREFILL,
      model: "<synthetic>",
      effort: "ultra",
    });
    expect(form.params).toMatchObject({ MODEL: "fable", EFFORT: "medium" });
  });

  // An un-migrated config whose resume recipe takes neither: the seed has
  // nowhere to land, and the form still shows exactly what it declares.
  test("a resume recipe declaring no model or effort ignores those seeds", () => {
    const bare = template("resume", 'run --resume "$SESSION_ID"', { CWD: "", SESSION_ID: "" });
    const form = initialSessionCreatorForm([bare], {
      ...RESUME_PREFILL,
      model: "claude-opus-5",
      effort: "high",
    });
    expect(form.params).toEqual({ CWD: "/repos/app", SESSION_ID: "sid-1" });
  });

  // A hit whose cwd the daemon could not establish opens the form anyway; the
  // declared default survives and the run button gates on the empty cwd.
  test("a resume prefill without a cwd leaves the declared default in place", () => {
    const withDefault = template("resume", "run", { CWD: "/repos/fallback", SESSION_ID: "" });
    const form = initialSessionCreatorForm([withDefault], {
      kind: "resume",
      cwd: "",
      sessionId: "sid-1",
    });
    expect(form.params).toEqual({ CWD: "/repos/fallback", SESSION_ID: "sid-1" });
  });

  // With no resume recipe configured the session id has nowhere to go, exactly
  // like a fork point does not (the cwd still lands, since every recipe
  // declares CWD).
  test("a resume prefill falls back to the default recipe, dropping the session id", () => {
    const form = initialSessionCreatorForm([PLAIN], RESUME_PREFILL);
    expect(form.template).toBe("default");
    expect(form.params).not.toHaveProperty("SESSION_ID");
    expect(form.params).toMatchObject({ CWD: "/repos/app" });
  });

  // A partial inheritance leaves the untouched parameters at their declared
  // defaults.
  test("parameters absent from the defaults keep their declared defaults", () => {
    const form = initialSessionCreatorForm([PLAIN], null, { MODEL: "sonnet" });
    expect(form.params).toMatchObject({ CWD: "", MODEL: "sonnet", EFFORT: "medium" });
  });
});

describe("paramWidget", () => {
  // Names the form knows get a purpose-built control; anything else is still
  // offered, as a plain text input.
  test("known names map to their control, everything else to a text input", () => {
    expect(paramWidget("CWD")).toBe("cwd");
    expect(paramWidget("MODEL")).toBe("model");
    expect(paramWidget("EFFORT")).toBe("effort");
    expect(paramWidget("PROMPT")).toBe("prompt");
    expect(paramWidget("RESUME_SID")).toBe("text");
    expect(paramWidget("BRANCH")).toBe("text");
  });
});

describe("forkSourceDefaults", () => {
  const ROOTS = ["/repos", "/srv/work/"];

  test("takes cwd from the source when it sits under a configured root", () => {
    expect(forkSourceDefaults({ cwd: "/repos/app/main" }, ROOTS)).toEqual({
      CWD: "/repos/app/main",
    });
    // The root itself is a legal pick, and a root written with a trailing
    // slash matches the same paths as one without.
    expect(forkSourceDefaults({ cwd: "/repos" }, ROOTS)).toEqual({ CWD: "/repos" });
    expect(forkSourceDefaults({ cwd: "/srv/work/x" }, ROOTS)).toEqual({ CWD: "/srv/work/x" });
  });

  // Seeding a cwd the daemon would refuse would leave the user pressing 実行
  // on a path that cannot launch; an empty picker is the honest state.
  test("drops a cwd outside the configured roots, including sibling-prefix paths", () => {
    expect(forkSourceDefaults({ cwd: "/elsewhere/app" }, ROOTS)).toEqual({});
    expect(forkSourceDefaults({ cwd: "/repos-other/app" }, ROOTS)).toEqual({});
    expect(forkSourceDefaults({ cwd: "relative/path" }, ROOTS)).toEqual({});
    expect(forkSourceDefaults({ cwd: "   " }, ROOTS)).toEqual({});
  });

  test("nothing is inherited when the fork source could not be identified", () => {
    expect(forkSourceDefaults(null, ROOTS)).toEqual({});
    expect(forkSourceDefaults({}, ROOTS)).toEqual({});
  });

  test("maps model and effort into the form's vocabulary", () => {
    expect(forkSourceDefaults({ model: "claude-fable-5[1m]", effort: "medium" }, ROOTS)).toEqual({
      MODEL: "fable",
      EFFORT: "medium",
    });
  });
});

describe("launcherModelFromTranscript", () => {
  // The form offers families; a transcript records the concrete model, with a
  // launch-only [1m] suffix on long-context sessions.
  test("reduces a claude model id to its family, suffix included", () => {
    expect(launcherModelFromTranscript("claude-fable-5")).toBe("fable");
    expect(launcherModelFromTranscript("claude-opus-5[1m]")).toBe("opus");
    expect(launcherModelFromTranscript("claude-sonnet-5")).toBe("sonnet");
    expect(launcherModelFromTranscript("claude-opus-4-7")).toBe("opus");
  });

  test("ids that already are an option pass through", () => {
    expect(launcherModelFromTranscript("gpt-5.6-sol")).toBe("gpt-5.6-sol");
    expect(launcherModelFromTranscript("opus")).toBe("opus");
  });

  // Synthetic harness rows and families with no dropdown entry have no honest
  // answer — the caller keeps the declared default rather than guessing.
  test("unknown values map to nothing", () => {
    expect(launcherModelFromTranscript("<synthetic>")).toBeUndefined();
    expect(launcherModelFromTranscript("claude-haiku-4-5-20251001")).toBeUndefined();
    expect(launcherModelFromTranscript("")).toBeUndefined();
  });
});

describe("launcherEffortFromTranscript", () => {
  // Transcript and form share the CLI's vocabulary, so every offered level
  // survives the trip verbatim — a value that came back changed would be a
  // level `claude --effort` does not accept.
  test("every offered level passes through", () => {
    expect(launcherEffortFromTranscript("medium")).toBe("medium");
    for (const effort of SESSION_CREATOR_EFFORTS) {
      expect(launcherEffortFromTranscript(effort)).toBe(effort);
    }
  });

  test("unknown values map to nothing", () => {
    expect(launcherEffortFromTranscript("ultra")).toBeUndefined();
    expect(launcherEffortFromTranscript("middle")).toBeUndefined();
    expect(launcherEffortFromTranscript("")).toBeUndefined();
  });
});

describe("forkTemplate / initialTemplate", () => {
  // Fork capability is read off the declaration: a recipe that never takes the
  // fork point cannot fork regardless of its name or its command text.
  test("picks the first recipe declaring the fork point", () => {
    expect(forkTemplate([PLAIN, FORK])?.name).toBe("fork");
    expect(forkTemplate([template("fork", "run --plain")])).toBeUndefined();
    // Reading `$RESUME_AT` without declaring it is not fork support — the
    // launcher shell would not define the variable at all.
    expect(forkTemplate([template("t", 'run "$RESUME_AT"')])).toBeUndefined();
    expect(templateDeclares(FORK, "RESUME_AT")).toBe(true);
  });

  test("without a prefill the first plain (non-fork) recipe is chosen", () => {
    expect(initialTemplate([PLAIN, FORK], null)?.name).toBe("default");
    // Config order must not decide it: "+ 新規" asked for a new session, so a
    // fork recipe listed first is skipped rather than opened (kawaz r119 m1).
    expect(initialTemplate([FORK, PLAIN], null)?.name).toBe("default");
    expect(plainTemplate([FORK, PLAIN])?.name).toBe("default");
  });

  // Neither kind is guaranteed to exist in a config; each falls back to the
  // first recipe rather than leaving the form with no template at all.
  test("a config with only fork recipes still opens on something", () => {
    expect(initialTemplate([FORK], null)?.name).toBe("fork");
    expect(plainTemplate([FORK])).toBeUndefined();
  });

  // Same rule as the fork point, on the resume recipe's own parameter.
  test("picks the first recipe declaring a session id", () => {
    expect(resumeTemplate([PLAIN, RESUME])?.name).toBe("resume");
    expect(resumeTemplate([PLAIN, FORK])).toBeUndefined();
    expect(resumeTemplate([template("t", 'run --resume "$SESSION_ID"')])).toBeUndefined();
  });

  test("a resume prefill opens on the resume recipe whatever the config order", () => {
    expect(initialTemplate([PLAIN, RESUME], RESUME_PREFILL)?.name).toBe("resume");
    expect(initialTemplate([RESUME, PLAIN], RESUME_PREFILL)?.name).toBe("resume");
    // …and a fork prefill still opens on the fork recipe, not this one.
    expect(initialTemplate([RESUME, FORK], FORK_PREFILL)?.name).toBe("fork");
  });

  // A resume recipe needs a session the user picked elsewhere, exactly like a
  // fork recipe needs a fork point, so "+ 新規" skips it too.
  test("「+ 新規」skips a resume recipe listed first", () => {
    expect(initialTemplate([RESUME, PLAIN], null)?.name).toBe("default");
    expect(plainTemplate([RESUME])).toBeUndefined();
  });

  test("with no resume recipe configured the form still opens", () => {
    expect(initialTemplate([PLAIN], RESUME_PREFILL)?.name).toBe("default");
  });
});

describe("selectSessionCreatorTemplate", () => {
  // The command belongs to the recipe, so it follows the switch. Parameters
  // restart from the new declaration except where the user had moved a value
  // away from the old recipe's default.
  test("switching a template replaces the command and keeps the user's edits", () => {
    const start = initialSessionCreatorForm([PLAIN, FORK], FORK_PREFILL);
    const edited = {
      ...start,
      params: { ...start.params, CWD: "/repo", MODEL: "opus" },
    };
    const switched = selectSessionCreatorTemplate(edited, [PLAIN, FORK], "default");
    expect(switched).toMatchObject({ template: "default", command: "run-launch" });
    expect(switched.params).toEqual({
      CWD: "/repo",
      MODEL: "opus",
      // Untouched in the fork recipe, so the plain recipe's own default wins.
      EFFORT: "medium",
      PROMPT: "hello",
    });
    // The fork values have no home in the plain recipe and are dropped.
    expect(switched.params).not.toHaveProperty("RESUME_SID");
  });

  test("an untouched value takes the new recipe's default", () => {
    const a = template("a", "cmd-a", { CWD: "", PROMPT: "from-a" });
    const b = template("b", "cmd-b", { CWD: "", PROMPT: "from-b" });
    const start = initialSessionCreatorForm([a, b]);
    expect(selectSessionCreatorTemplate(start, [a, b], "b").params.PROMPT).toBe("from-b");
  });

  test("an unknown name leaves the form untouched", () => {
    const start = initialSessionCreatorForm([PLAIN]);
    expect(selectSessionCreatorTemplate(start, [PLAIN], "nope")).toBe(start);
  });
});

describe("SESSION_CREATOR_MODELS / SESSION_CREATOR_EFFORTS", () => {
  // DR-0018 §2.1's fixed dropdown options — order matches the DR's listing,
  // which the form renders as-is (no client-side sort).
  test("model list matches the DR-0018 §2.1 spec, in order", () => {
    expect(SESSION_CREATOR_MODELS).toEqual([
      "sonnet",
      "opus",
      "fable",
      "gpt-5.6-luna",
      "gpt-5.6-terra",
      "gpt-5.6-sol",
    ]);
  });

  // The effort list is the CLI's own, verbatim: `claude --effort` answers an
  // unrecognized level with a stderr warning and its default effort, so an
  // option the CLI does not know silently drops the user's choice.
  test("effort list matches what `claude --effort` accepts, in order", () => {
    expect(SESSION_CREATOR_EFFORTS).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });
});

const DEFAULT_COMMAND = PLAIN.command;

function form(overrides: Partial<SessionCreatorForm> = {}): SessionCreatorForm {
  return {
    template: PLAIN.name,
    command: DEFAULT_COMMAND,
    ...overrides,
    params: {
      CWD: "/repo",
      MODEL: "fable",
      EFFORT: "medium",
      PROMPT: "hi",
      ...overrides.params,
    },
  };
}

describe("sessionCreatorFormValid", () => {
  test("valid once cwd is non-blank", () => {
    expect(sessionCreatorFormValid(form())).toBe(true);
    expect(sessionCreatorCwd(form())).toBe("/repo");
  });

  test("invalid with an empty cwd", () => {
    expect(sessionCreatorFormValid(form({ params: { CWD: "" } }))).toBe(false);
  });

  test("invalid with a whitespace-only cwd", () => {
    expect(sessionCreatorFormValid(form({ params: { CWD: "   " } }))).toBe(false);
  });

  // Other parameters are deliberately not part of the gate — an empty prompt is
  // still a launchable `claude` invocation (see session-creator.ts).
  test("valid with an empty prompt, as long as cwd is set", () => {
    expect(sessionCreatorFormValid(form({ params: { PROMPT: "" } }))).toBe(true);
  });
});

// issue 2026-07-17-session-creator-cwd-picker-unify: pure mode-transition
// helpers for CwdPicker's editing/confirmed toggle.
describe("initialCwdPickerMode", () => {
  test("editing when cwd is empty", () => {
    expect(initialCwdPickerMode("")).toBe("editing");
  });

  test("editing when cwd is whitespace-only", () => {
    expect(initialCwdPickerMode("   ")).toBe("editing");
  });

  test("confirmed when a cwd is already set (fork inheritance, declared default)", () => {
    expect(initialCwdPickerMode("/repo")).toBe("confirmed");
  });
});

describe("commitCwdInput", () => {
  test("null on an empty value — an empty Enter press is a no-op", () => {
    expect(commitCwdInput("")).toBeNull();
  });

  test("null on a whitespace-only value", () => {
    expect(commitCwdInput("   ")).toBeNull();
  });

  test("trims and confirms a directly-typed path", () => {
    expect(commitCwdInput("  /repo/deep/path  ")).toEqual({
      cwd: "/repo/deep/path",
      mode: "confirmed",
    });
  });
});

describe("buildSessionLaunchRequest", () => {
  test("null when the form isn't launchable (empty cwd)", () => {
    expect(buildSessionLaunchRequest(form({ params: { CWD: "" } }), [PLAIN])).toBeNull();
  });

  // CWD leaves as the request's own field (the daemon containment-checks it and
  // spawns there); every other parameter travels in `params`, untouched.
  test("trims cwd out into its own field and carries the rest as params", () => {
    expect(
      buildSessionLaunchRequest(
        form({
          params: { CWD: "  /repo/ws  ", MODEL: "gpt-5.6-sol", EFFORT: "high", PROMPT: "go" },
        }),
        [PLAIN],
      ),
    ).toEqual({
      cwd: "/repo/ws",
      params: { MODEL: "gpt-5.6-sol", EFFORT: "high", PROMPT: "go" },
      template: "default",
    });
  });

  test("values are passed through verbatim, including leading/trailing whitespace", () => {
    const req = buildSessionLaunchRequest(form({ params: { PROMPT: "  keep spacing  " } }), [
      PLAIN,
    ]);
    expect(req?.params.PROMPT).toBe("  keep spacing  ");
  });

  // No-edit case: command unchanged from the daemon-configured template, so no
  // `command` field rides along and the daemon runs its own recipe.
  test("omits command when it matches the daemon default verbatim", () => {
    const req = buildSessionLaunchRequest(form({ command: DEFAULT_COMMAND }), [PLAIN]);
    expect(req).not.toHaveProperty("command");
  });

  // Any user edit is sent as-is. The daemon rejects an empty override with
  // invalid_args, so we deliberately pass through empty/whitespace-only
  // strings rather than falling back to the config value.
  test("sends command override when it differs from the default, verbatim", () => {
    expect(buildSessionLaunchRequest(form({ command: "custom --run" }), [PLAIN])).toEqual({
      cwd: "/repo",
      params: { MODEL: "fable", EFFORT: "medium", PROMPT: "hi" },
      template: "default",
      command: "custom --run",
    });
  });

  test("empty command is forwarded (daemon rejects with invalid_args)", () => {
    const req = buildSessionLaunchRequest(form({ command: "" }), [PLAIN]);
    expect(req).toMatchObject({ command: "" });
  });

  // Whitespace-only difference still counts as an edit — trimming would hide
  // an intentional trailing newline the user added.
  test("whitespace-only difference from the default is treated as an edit", () => {
    const req = buildSessionLaunchRequest(form({ command: `${DEFAULT_COMMAND}\n` }), [PLAIN]);
    expect(req?.command).toBe(`${DEFAULT_COMMAND}\n`);
  });

  test("carries the fork values as ordinary params", () => {
    const req = buildSessionLaunchRequest(
      form({
        template: "fork",
        command: FORK.command,
        params: { RESUME_SID: "s-1", RESUME_AT: "u-1" },
      }),
      [PLAIN, FORK],
    );
    expect(req).toMatchObject({ template: "fork" });
    expect(req?.params).toMatchObject({ RESUME_SID: "s-1", RESUME_AT: "u-1" });
    expect(buildSessionLaunchRequest(form(), [PLAIN])?.params).not.toHaveProperty("RESUME_AT");
  });

  // The command baseline is the SELECTED recipe, so an unedited fork command
  // is still a no-override launch even though it differs from the default one.
  test("the no-override comparison follows the selected template", () => {
    const req = buildSessionLaunchRequest(form({ template: "fork", command: FORK.command }), [
      PLAIN,
      FORK,
    ]);
    expect(req).not.toHaveProperty("command");
  });
});
