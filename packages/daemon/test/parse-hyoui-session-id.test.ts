// Unit tests for parseHyouiSessionId / parseHyouiNamespace — the pure
// parsers for `ps eww` output used to lift HYOUI_SESSION_ID / HYOUI_NAMESPACE
// out of a claude process's environment (Status tab metadata surface, and
// session_rename's hyoui namespace argument).
import { describe, expect, test } from "bun:test";
import { parseHyouiNamespace, parseHyouiSessionId } from "../src/agents.ts";

describe("parseHyouiSessionId", () => {
  test("returns the value when present in a ps eww -o command= line", () => {
    const line =
      "/usr/local/bin/claude --resume abc SHELL=/bin/zsh HYOUI_SESSION_ID=sess-xyz-123 LANG=en_US.UTF-8";
    expect(parseHyouiSessionId(line)).toBe("sess-xyz-123");
  });

  test("returns null when the env var is absent", () => {
    const line = "/usr/local/bin/claude SHELL=/bin/zsh LANG=en_US.UTF-8 TERM=xterm";
    expect(parseHyouiSessionId(line)).toBeNull();
  });

  test("returns the value when HYOUI_SESSION_ID is the final token (no trailing space)", () => {
    const line = "/usr/local/bin/claude SHELL=/bin/zsh HYOUI_SESSION_ID=tail-value";
    expect(parseHyouiSessionId(line)).toBe("tail-value");
  });

  test("returns null when the value is empty", () => {
    const line = "/usr/local/bin/claude HYOUI_SESSION_ID= LANG=en_US.UTF-8";
    expect(parseHyouiSessionId(line)).toBeNull();
  });

  test("strips a trailing newline", () => {
    const line = "/usr/local/bin/claude HYOUI_SESSION_ID=with-newline\n";
    expect(parseHyouiSessionId(line)).toBe("with-newline");
  });

  test("does not match a variable whose name only ends with HYOUI_SESSION_ID", () => {
    // the leading space guard prevents e.g. FOO_HYOUI_SESSION_ID=... from matching
    const line = "/usr/local/bin/claude FOO_HYOUI_SESSION_ID=nope OTHER=x";
    expect(parseHyouiSessionId(line)).toBeNull();
  });
});

describe("parseHyouiNamespace", () => {
  // kawaz r135m40/41: a session launched under a business overlay's hyoui
  // wrapper sets HYOUI_NAMESPACE to that overlay's namespace, distinct from
  // the daemon's own — this is the value session_rename must forward.
  test("returns the value when present in a ps eww -o command= line", () => {
    const line =
      "/usr/local/bin/claude --resume abc HYOUI_SESSION_ID=sess-xyz-123 HYOUI_NAMESPACE=emeradaco LANG=en_US.UTF-8";
    expect(parseHyouiNamespace(line)).toBe("emeradaco");
  });

  test("returns null when the env var is absent", () => {
    const line = "/usr/local/bin/claude HYOUI_SESSION_ID=sess-xyz-123 LANG=en_US.UTF-8";
    expect(parseHyouiNamespace(line)).toBeNull();
  });

  test("returns the value when HYOUI_NAMESPACE is the final token (no trailing space)", () => {
    const line = "/usr/local/bin/claude SHELL=/bin/zsh HYOUI_NAMESPACE=tail-value";
    expect(parseHyouiNamespace(line)).toBe("tail-value");
  });

  test("returns null when the value is empty", () => {
    const line = "/usr/local/bin/claude HYOUI_NAMESPACE= LANG=en_US.UTF-8";
    expect(parseHyouiNamespace(line)).toBeNull();
  });

  test("does not match a variable whose name only ends with HYOUI_NAMESPACE", () => {
    const line = "/usr/local/bin/claude FOO_HYOUI_NAMESPACE=nope OTHER=x";
    expect(parseHyouiNamespace(line)).toBeNull();
  });
});
