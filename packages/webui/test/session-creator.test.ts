// DR-0018 §2.1: pure form-state helpers for SessionCreator.tsx (default
// construction, run-button validity gate, wire-request projection).
import { describe, expect, test } from "bun:test";
import {
  buildSessionLaunchRequest,
  commitCwdInput,
  DEFAULT_SESSION_CREATOR_EFFORT,
  DEFAULT_SESSION_CREATOR_MODEL,
  initialCwdPickerMode,
  initialSessionCreatorForm,
  sessionCreatorFormValid,
  SESSION_CREATOR_EFFORTS,
  SESSION_CREATOR_MODELS,
  type SessionCreatorForm,
} from "../src/client/session-creator.ts";

describe("initialSessionCreatorForm", () => {
  test("defaults model to fable and effort to middle, cwd empty", () => {
    const form = initialSessionCreatorForm("hello", "run --cmd");
    expect(form).toEqual({
      cwd: "",
      model: DEFAULT_SESSION_CREATOR_MODEL,
      effort: DEFAULT_SESSION_CREATOR_EFFORT,
      prompt: "hello",
      command: "run --cmd",
    });
    expect(form.model).toBe("fable");
    expect(form.effort).toBe("middle");
  });

  test("carries the daemon's default_prompt verbatim, including empty string", () => {
    expect(initialSessionCreatorForm("", "cmd").prompt).toBe("");
    expect(initialSessionCreatorForm("multi\nline\n", "cmd").prompt).toBe("multi\nline\n");
  });

  // The command template is a shell body with `$CWD`/`$MODEL`/`$EFFORT`/
  // `$PROMPT` refs — the daemon never substitutes them, and neither does the
  // form. The user should see exactly what the daemon will run.
  test("carries the daemon's command verbatim, including $VAR refs and newlines", () => {
    const cmd = 'claude --model "$MODEL" --effort "$EFFORT"\n"$PROMPT"';
    expect(initialSessionCreatorForm("p", cmd).command).toBe(cmd);
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

const DEFAULT_COMMAND = "run-launch";

function form(overrides: Partial<SessionCreatorForm> = {}): SessionCreatorForm {
  return {
    cwd: "/repo",
    model: "fable",
    effort: "middle",
    prompt: "hi",
    command: DEFAULT_COMMAND,
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
    expect(buildSessionLaunchRequest(form({ cwd: "" }), DEFAULT_COMMAND)).toBeNull();
  });

  test("trims cwd and carries model/effort/prompt through unchanged", () => {
    expect(
      buildSessionLaunchRequest(
        form({ cwd: "  /repo/ws  ", model: "gpt-5.6-sol", effort: "high", prompt: "go" }),
        DEFAULT_COMMAND,
      ),
    ).toEqual({ cwd: "/repo/ws", model: "gpt-5.6-sol", effort: "high", prompt: "go" });
  });

  test("prompt is passed through verbatim, including leading/trailing whitespace", () => {
    const req = buildSessionLaunchRequest(
      form({ prompt: "  keep this spacing  " }),
      DEFAULT_COMMAND,
    );
    expect(req?.prompt).toBe("  keep this spacing  ");
  });

  // No-edit case: command unchanged from the daemon-configured template, so
  // the wire request stays identical to the pre-addendum shape (no `command`
  // field). Keeps the common path bit-identical when the user only edited
  // cwd/model/effort/prompt.
  test("omits command when it matches the daemon default verbatim", () => {
    const req = buildSessionLaunchRequest(form({ command: DEFAULT_COMMAND }), DEFAULT_COMMAND);
    expect(req).toEqual({ cwd: "/repo", model: "fable", effort: "middle", prompt: "hi" });
    expect(req).not.toHaveProperty("command");
  });

  // Any user edit is sent as-is. The daemon rejects an empty override with
  // invalid_args, so we deliberately pass through empty/whitespace-only
  // strings rather than falling back to the config value.
  test("sends command override when it differs from the default, verbatim", () => {
    expect(buildSessionLaunchRequest(form({ command: "custom --run" }), DEFAULT_COMMAND)).toEqual({
      cwd: "/repo",
      model: "fable",
      effort: "middle",
      prompt: "hi",
      command: "custom --run",
    });
  });

  test("empty command is forwarded (daemon rejects with invalid_args)", () => {
    const req = buildSessionLaunchRequest(form({ command: "" }), DEFAULT_COMMAND);
    expect(req).toMatchObject({ command: "" });
  });

  // Whitespace-only difference still counts as an edit — trimming would hide
  // an intentional trailing newline the user added.
  test("whitespace-only difference from the default is treated as an edit", () => {
    const req = buildSessionLaunchRequest(
      form({ command: `${DEFAULT_COMMAND}\n` }),
      DEFAULT_COMMAND,
    );
    expect(req?.command).toBe(`${DEFAULT_COMMAND}\n`);
  });
});
