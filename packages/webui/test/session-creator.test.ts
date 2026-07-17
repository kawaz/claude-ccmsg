// DR-0018 §2.1: pure form-state helpers for SessionCreator.tsx (default
// construction, run-button validity gate, wire-request projection).
import { describe, expect, test } from "bun:test";
import {
  buildSessionLaunchRequest,
  DEFAULT_SESSION_CREATOR_EFFORT,
  DEFAULT_SESSION_CREATOR_MODEL,
  initialSessionCreatorForm,
  sessionCreatorFormValid,
  SESSION_CREATOR_EFFORTS,
  SESSION_CREATOR_MODELS,
  type SessionCreatorForm,
} from "../src/client/session-creator.ts";

describe("initialSessionCreatorForm", () => {
  test("defaults model to fable and effort to middle, cwd empty", () => {
    const form = initialSessionCreatorForm("hello");
    expect(form).toEqual({
      cwd: "",
      model: DEFAULT_SESSION_CREATOR_MODEL,
      effort: DEFAULT_SESSION_CREATOR_EFFORT,
      prompt: "hello",
    });
    expect(form.model).toBe("fable");
    expect(form.effort).toBe("middle");
  });

  test("carries the daemon's default_prompt verbatim, including empty string", () => {
    expect(initialSessionCreatorForm("").prompt).toBe("");
    expect(initialSessionCreatorForm("multi\nline\n").prompt).toBe("multi\nline\n");
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

function form(overrides: Partial<SessionCreatorForm> = {}): SessionCreatorForm {
  return { cwd: "/repo", model: "fable", effort: "middle", prompt: "hi", ...overrides };
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

describe("buildSessionLaunchRequest", () => {
  test("null when the form isn't launchable (empty cwd)", () => {
    expect(buildSessionLaunchRequest(form({ cwd: "" }))).toBeNull();
  });

  test("trims cwd and carries model/effort/prompt through unchanged", () => {
    expect(
      buildSessionLaunchRequest(
        form({ cwd: "  /repo/ws  ", model: "gpt-5.6-sol", effort: "high", prompt: "go" }),
      ),
    ).toEqual({ cwd: "/repo/ws", model: "gpt-5.6-sol", effort: "high", prompt: "go" });
  });

  test("prompt is passed through verbatim, including leading/trailing whitespace", () => {
    const req = buildSessionLaunchRequest(form({ prompt: "  keep this spacing  " }));
    expect(req?.prompt).toBe("  keep this spacing  ");
  });
});
