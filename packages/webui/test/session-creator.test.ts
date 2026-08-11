// DR-0018 §2.1: pure form-state helpers for SessionCreator.tsx (default
// construction, run-button validity gate, wire-request projection).
import { describe, expect, test } from "bun:test";
import type { SessionLauncherConfigTemplate } from "@ccmsg/protocol";
import {
  buildSessionLaunchRequest,
  commandUsesVar,
  commitCwdInput,
  plainTemplate,
  forkSourceDefaults,
  forkTemplate,
  initialTemplate,
  launcherEffortFromTranscript,
  launcherModelFromTranscript,
  usesForkPoint,
  selectSessionCreatorTemplate,
  DEFAULT_SESSION_CREATOR_EFFORT,
  DEFAULT_SESSION_CREATOR_MODEL,
  initialCwdPickerMode,
  initialSessionCreatorForm,
  sessionCreatorFormValid,
  SESSION_CREATOR_EFFORTS,
  SESSION_CREATOR_MODELS,
  type SessionCreatorForm,
} from "../src/client/session-creator.ts";

/** One configured recipe, as session_launcher_config projects it. */
function template(
  name: string,
  command: string,
  defaultPrompt = "",
): SessionLauncherConfigTemplate {
  return { name, command, default_prompt: defaultPrompt };
}

const PLAIN = template("default", "run-launch", "hello");
const FORK = template("fork", 'run --resume "$RESUME_SID" --resume-session-at="$RESUME_AT"');

describe("initialSessionCreatorForm", () => {
  test("defaults model to fable and effort to middle, cwd empty", () => {
    const form = initialSessionCreatorForm([PLAIN]);
    expect(form).toEqual({
      cwd: "",
      model: DEFAULT_SESSION_CREATOR_MODEL,
      effort: DEFAULT_SESSION_CREATOR_EFFORT,
      prompt: "hello",
      template: "default",
      command: "run-launch",
      resumeSid: "",
      resumeAt: "",
    });
    expect(form.model).toBe("fable");
    expect(form.effort).toBe("middle");
  });

  test("carries the template's default_prompt verbatim, including empty string", () => {
    expect(initialSessionCreatorForm([template("t", "cmd", "")]).prompt).toBe("");
    expect(initialSessionCreatorForm([template("t", "cmd", "multi\nline\n")]).prompt).toBe(
      "multi\nline\n",
    );
  });

  // The command template is a shell body with `$CWD`/`$MODEL`/`$EFFORT`/
  // `$PROMPT` refs — the daemon never substitutes them, and neither does the
  // form. The user should see exactly what the daemon will run.
  test("carries the template's command verbatim, including $VAR refs and newlines", () => {
    const cmd = 'claude --model "$MODEL" --effort "$EFFORT"\n"$PROMPT"';
    expect(initialSessionCreatorForm([template("t", cmd, "p")]).command).toBe(cmd);
  });

  // A fork opens on a recipe that actually consumes the fork point, whatever
  // its position in the list, and carries the fork values into the form.
  test("a fork prefill opens on the fork recipe with the fork point filled in", () => {
    const form = initialSessionCreatorForm([PLAIN, FORK], { resumeSid: "sid-1", resumeAt: "u-9" });
    expect(form).toMatchObject({
      template: "fork",
      command: FORK.command,
      resumeSid: "sid-1",
      resumeAt: "u-9",
    });
  });

  // With no fork-capable recipe configured the form still opens (on the
  // default) carrying the fork point — SessionCreator warns that the command
  // will not act on it rather than dropping the request silently.
  test("a fork prefill falls back to the default recipe when none consumes $RESUME_AT", () => {
    const form = initialSessionCreatorForm([PLAIN], { resumeSid: "sid-1", resumeAt: "u-9" });
    expect(form).toMatchObject({ template: "default", resumeAt: "u-9" });
  });

  // Fork-source defaults win over the plain defaults, field by field.
  test("applies the fork source's cwd/model/effort when given", () => {
    const form = initialSessionCreatorForm(
      [PLAIN, FORK],
      { resumeSid: "s", resumeAt: "u" },
      {
        cwd: "/repos/app",
        model: "opus",
        effort: "high",
      },
    );
    expect(form).toMatchObject({ cwd: "/repos/app", model: "opus", effort: "high" });
  });

  // A partial inheritance leaves the untouched fields exactly where a plain
  // open leaves them.
  test("fields absent from the defaults keep the plain defaults", () => {
    const form = initialSessionCreatorForm([PLAIN], null, { model: "sonnet" });
    expect(form).toMatchObject({
      cwd: "",
      model: "sonnet",
      effort: DEFAULT_SESSION_CREATOR_EFFORT,
    });
  });
});

describe("forkSourceDefaults", () => {
  const ROOTS = ["/repos", "/srv/work/"];

  test("takes cwd from the source when it sits under a configured root", () => {
    expect(forkSourceDefaults({ cwd: "/repos/app/main" }, ROOTS)).toEqual({
      cwd: "/repos/app/main",
    });
    // The root itself is a legal pick, and a root written with a trailing
    // slash matches the same paths as one without.
    expect(forkSourceDefaults({ cwd: "/repos" }, ROOTS)).toEqual({ cwd: "/repos" });
    expect(forkSourceDefaults({ cwd: "/srv/work/x" }, ROOTS)).toEqual({ cwd: "/srv/work/x" });
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
      model: "fable",
      effort: "middle",
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
  // answer — the caller keeps the plain default rather than guessing.
  test("unknown values map to nothing", () => {
    expect(launcherModelFromTranscript("<synthetic>")).toBeUndefined();
    expect(launcherModelFromTranscript("claude-haiku-4-5-20251001")).toBeUndefined();
    expect(launcherModelFromTranscript("")).toBeUndefined();
  });
});

describe("launcherEffortFromTranscript", () => {
  // The vocabularies agree except at the middle rung.
  test("renames medium to middle and passes the rest through", () => {
    expect(launcherEffortFromTranscript("medium")).toBe("middle");
    for (const effort of SESSION_CREATOR_EFFORTS) {
      expect(launcherEffortFromTranscript(effort)).toBe(effort);
    }
  });

  test("unknown values map to nothing", () => {
    expect(launcherEffortFromTranscript("ultra")).toBeUndefined();
    expect(launcherEffortFromTranscript("")).toBeUndefined();
  });
});

describe("forkTemplate / initialTemplate", () => {
  // Fork capability is read off the command text: a recipe that never expands
  // the fork point cannot fork regardless of its name.
  test("picks the first recipe whose command reads the fork point", () => {
    expect(forkTemplate([PLAIN, FORK])?.name).toBe("fork");
    expect(forkTemplate([template("fork", "run --plain")])).toBeUndefined();
    expect(forkTemplate([template("braced", 'run "${RESUME_AT}"')])?.name).toBe("braced");
  });

  // `$RESUME_ATTEMPT` is a different variable; the word boundary keeps it from
  // reading as fork support.
  test("a longer variable name that merely starts with RESUME_AT does not count", () => {
    expect(forkTemplate([template("t", 'run "$RESUME_ATTEMPT"')])).toBeUndefined();
  });

  // The form asks the same question about the command actually about to run
  // (possibly hand-edited, or a plain recipe the user switched to after
  // asking for a fork), so the predicate is exposed on its own.
  test("usesForkPoint answers for one command text", () => {
    expect(usesForkPoint('run "$RESUME_AT"')).toBe(true);
    expect(usesForkPoint("run --plain")).toBe(false);
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
});

describe("commandUsesVar", () => {
  // Which inputs the form offers: a variable the command never reads has no
  // input, so this answers per-variable what usesForkPoint answers for the
  // fork point specifically.
  test("matches $VAR and ${VAR}, with a word boundary", () => {
    expect(commandUsesVar('run --resume "$RESUME_SID"', "RESUME_SID")).toBe(true);
    expect(commandUsesVar('run --resume "${RESUME_SID}"', "RESUME_SID")).toBe(true);
    expect(commandUsesVar('run "$RESUME_SIDECAR"', "RESUME_SID")).toBe(false);
    expect(commandUsesVar(PLAIN.command, "RESUME_SID")).toBe(false);
    expect(commandUsesVar(FORK.command, "RESUME_AT")).toBe(true);
  });
});

describe("selectSessionCreatorTemplate", () => {
  // Prompt and command belong to the recipe, so they follow the switch; the
  // user's own picks (cwd/model/effort and the fork point) survive it.
  test("switching a template replaces prompt and command, keeping user picks", () => {
    const start = initialSessionCreatorForm([PLAIN, FORK], { resumeSid: "s", resumeAt: "u" });
    const switched = selectSessionCreatorTemplate(
      { ...start, cwd: "/repo", model: "opus" },
      [PLAIN, FORK],
      "default",
    );
    expect(switched).toMatchObject({
      template: "default",
      prompt: "hello",
      command: "run-launch",
      cwd: "/repo",
      model: "opus",
      resumeSid: "s",
      resumeAt: "u",
    });
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

  test("effort list matches the DR-0018 §2.1 spec, in order", () => {
    expect(SESSION_CREATOR_EFFORTS).toEqual(["low", "middle", "high", "xhigh"]);
  });
});

const DEFAULT_COMMAND = PLAIN.command;

function form(overrides: Partial<SessionCreatorForm> = {}): SessionCreatorForm {
  return {
    cwd: "/repo",
    model: "fable",
    effort: "middle",
    prompt: "hi",
    template: PLAIN.name,
    command: DEFAULT_COMMAND,
    resumeSid: "",
    resumeAt: "",
    ...overrides,
  };
}

describe("sessionCreatorFormValid", () => {
  test("valid once cwd is non-blank", () => {
    expect(sessionCreatorFormValid(form({ cwd: "/repo" }))).toBe(true);
  });

  test("invalid with an empty cwd", () => {
    expect(sessionCreatorFormValid(form({ cwd: "" }))).toBe(false);
  });

  test("invalid with a whitespace-only cwd", () => {
    expect(sessionCreatorFormValid(form({ cwd: "   " }))).toBe(false);
  });

  // Prompt is deliberately not part of the gate — an empty prompt is still a
  // launchable `claude` invocation (see the doc comment in session-creator.ts).
  test("valid with an empty prompt, as long as cwd is set", () => {
    expect(sessionCreatorFormValid(form({ cwd: "/repo", prompt: "" }))).toBe(true);
  });
});

// issue 2026-07-17-session-creator-cwd-picker-unify: pure mode-transition
// helpers for CwdPicker's editing/confirmed toggle.
describe("initialCwdPickerMode", () => {
  test("editing when cwd is empty (initialSessionCreatorForm's default)", () => {
    expect(initialCwdPickerMode("")).toBe("editing");
  });

  test("editing when cwd is whitespace-only", () => {
    expect(initialCwdPickerMode("   ")).toBe("editing");
  });

  test("confirmed when a cwd is already set (future default-cwd source)", () => {
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
    expect(buildSessionLaunchRequest(form({ cwd: "" }), [PLAIN])).toBeNull();
  });

  test("trims cwd and carries model/effort/prompt through unchanged", () => {
    expect(
      buildSessionLaunchRequest(
        form({ cwd: "  /repo/ws  ", model: "gpt-5.6-sol", effort: "high", prompt: "go" }),
        [PLAIN],
      ),
    ).toEqual({
      cwd: "/repo/ws",
      model: "gpt-5.6-sol",
      effort: "high",
      prompt: "go",
      template: "default",
    });
  });

  test("prompt is passed through verbatim, including leading/trailing whitespace", () => {
    const req = buildSessionLaunchRequest(form({ prompt: "  keep this spacing  " }), [PLAIN]);
    expect(req?.prompt).toBe("  keep this spacing  ");
  });

  // No-edit case: command unchanged from the daemon-configured template, so
  // the wire request stays identical to the pre-addendum shape (no `command`
  // field). Keeps the common path bit-identical when the user only edited
  // cwd/model/effort/prompt.
  test("omits command when it matches the daemon default verbatim", () => {
    const req = buildSessionLaunchRequest(form({ command: DEFAULT_COMMAND }), [PLAIN]);
    expect(req).toEqual({
      cwd: "/repo",
      model: "fable",
      effort: "middle",
      prompt: "hi",
      template: "default",
    });
    expect(req).not.toHaveProperty("command");
  });

  // Any user edit is sent as-is. The daemon rejects an empty override with
  // invalid_args, so we deliberately pass through empty/whitespace-only
  // strings rather than falling back to the config value.
  test("sends command override when it differs from the default, verbatim", () => {
    expect(buildSessionLaunchRequest(form({ command: "custom --run" }), [PLAIN])).toEqual({
      cwd: "/repo",
      model: "fable",
      effort: "middle",
      prompt: "hi",
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

  // Fork values ride along as their own wire fields; empty ones are omitted
  // rather than sent blank (the daemon rejects a present-but-empty resume).
  test("carries the fork point when present and omits it when empty", () => {
    expect(
      buildSessionLaunchRequest(
        form({ template: "fork", command: FORK.command, resumeSid: "s-1", resumeAt: "u-1" }),
        [PLAIN, FORK],
      ),
    ).toMatchObject({ template: "fork", resume_sid: "s-1", resume_at: "u-1" });
    const plain = buildSessionLaunchRequest(form(), [PLAIN]);
    expect(plain).not.toHaveProperty("resume_sid");
    expect(plain).not.toHaveProperty("resume_at");
  });

  // The command baseline is the SELECTED recipe, so an unedited fork command
  // is still a no-override launch even though it differs from the default one.
  test("the no-override comparison follows the selected template", () => {
    const req = buildSessionLaunchRequest(
      form({ template: "fork", command: FORK.command, resumeAt: "u-1" }),
      [PLAIN, FORK],
    );
    expect(req).not.toHaveProperty("command");
  });
});
