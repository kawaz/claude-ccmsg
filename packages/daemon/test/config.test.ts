// Session launcher config parsing (DR-0018 Phase 1): malformed or partial
// user configuration must never prevent the daemon from starting.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_DIR_TREE_DEPTH, DEFAULT_LAUNCH_TIMEOUT_SECONDS } from "@ccmsg/protocol";
import { loadConfig } from "../src/config.ts";

describe("loadConfig", () => {
  let dir: string;
  let file: string;
  let warnings: string[];
  const log = { warn: (msg: string) => warnings.push(msg) };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-config-"));
    file = path.join(dir, "config.json");
    warnings = [];
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // A missing file is the normal unconfigured state, so startup stays quiet and
  // exposes no launcher rather than treating first use as an error.
  test("missing file returns an empty config without warning", () => {
    expect(loadConfig(file, log)).toEqual({});
    expect(warnings).toEqual([]);
  });

  // Broken JSON is user-editable garbage: the daemon must stay available and
  // make the launcher unavailable, with one diagnostic for repair.
  test("broken JSON returns an empty config with one warning", () => {
    fs.writeFileSync(file, "{not-json");
    expect(loadConfig(file, log)).toEqual({});
    expect(warnings).toHaveLength(1);
  });

  // The top-level contract is a JSON object. Scalars and arrays cannot contain
  // daemon keys, so both degrade to the same safe empty configuration.
  test("non-object JSON values return an empty config with a warning", () => {
    for (const value of ["null", "42", "[]"]) {
      fs.writeFileSync(file, value);
      warnings = [];
      expect(loadConfig(file, log)).toEqual({});
      expect(warnings).toHaveLength(1);
    }
  });

  // This is the complete accepted shape: every configured field survives while
  // root paths are normalized before they become containment boundaries.
  test("complete session_launcher parses every field", () => {
    const root = path.join(dir, "root", "..");
    fs.writeFileSync(
      file,
      JSON.stringify({
        session_launcher: {
          root_dirs: [root],
          default_prompt: "start here",
          shell: "zsh",
          command: 'claude --model "$MODEL" "$PROMPT"',
          timeout_seconds: 25,
          dir_tree_depth: 3,
          clean_env: ["CLAUDE_*", "AI_AGENT"],
          keep_env: ["CLAUDE_CONFIG_DIR"],
        },
      }),
    );

    expect(loadConfig(file, log)).toEqual({
      session_launcher: {
        root_dirs: [path.resolve(root)],
        default_prompt: "start here",
        shell: "zsh",
        command: 'claude --model "$MODEL" "$PROMPT"',
        timeout_seconds: 25,
        dir_tree_depth: 3,
        clean_env: ["CLAUDE_*", "AI_AGENT"],
        keep_env: ["CLAUDE_CONFIG_DIR"],
      },
    });
    expect(warnings).toEqual([]);
  });

  // DR-0018's user-facing examples use ~/..., so the parser expands it against
  // the daemon user's actual home before absolute-path normalization.
  test("a ~/ root expands to the daemon user's home", () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        session_launcher: {
          root_dirs: ["~/launcher-root"],
          command: "run",
        },
      }),
    );

    expect(loadConfig(file, log).session_launcher?.root_dirs).toEqual([
      path.join(os.homedir(), "launcher-root"),
    ]);
  });

  // shell is deliberately a built-in two-choice contract. Missing selects the
  // documented bash default; malformed supplied values also default but warn.
  test("shell defaults to bash and rejects values outside bash or zsh", () => {
    for (const [shell, warningCount] of [
      [undefined, 0],
      ["fish", 1],
      [123, 1],
    ] as const) {
      fs.writeFileSync(
        file,
        JSON.stringify({
          session_launcher: {
            root_dirs: [dir],
            command: "run",
            ...(shell === undefined ? {} : { shell }),
          },
        }),
      );
      warnings = [];
      expect(loadConfig(file, log).session_launcher?.shell).toBe("bash");
      expect(warnings).toHaveLength(warningCount);
    }
  });

  // Containment cannot be defined without at least one root, so absent, empty,
  // or wrong-typed roots disable the whole launcher rather than opening it wide.
  test("missing, empty, or non-array root_dirs disables session_launcher", () => {
    for (const root_dirs of [undefined, [], "not-an-array"]) {
      fs.writeFileSync(
        file,
        JSON.stringify({
          session_launcher: {
            ...(root_dirs === undefined ? {} : { root_dirs }),
            command: "run",
          },
        }),
      );
      warnings = [];
      expect(loadConfig(file, log).session_launcher).toBeUndefined();
      expect(warnings).toHaveLength(1);
    }
  });

  // command is the fixed launch program selected by the administrator. Without
  // it, accepting session_launch would create an undefined execution contract.
  test("missing command disables session_launcher", () => {
    fs.writeFileSync(file, JSON.stringify({ session_launcher: { root_dirs: [dir] } }));
    expect(loadConfig(file, log).session_launcher).toBeUndefined();
    expect(warnings).toHaveLength(1);
  });

  // Numeric garbage is localized to the affected field: the launcher remains
  // usable and receives the DR defaults instead of crashing or accepting zero.
  test("invalid timeout and tree depth fall back to defaults", () => {
    for (const invalid of ["abc", -1, 0]) {
      fs.writeFileSync(
        file,
        JSON.stringify({
          session_launcher: {
            root_dirs: [dir],
            command: "run",
            timeout_seconds: invalid,
            dir_tree_depth: invalid,
          },
        }),
      );
      warnings = [];
      const cfg = loadConfig(file, log).session_launcher!;
      expect(cfg.timeout_seconds).toBe(DEFAULT_LAUNCH_TIMEOUT_SECONDS);
      expect(cfg.dir_tree_depth).toBe(DEFAULT_DIR_TREE_DEPTH);
      expect(warnings).toHaveLength(2);
    }
  });

  // A bad element must not erase independent good roots. Relative entries are
  // excluded with a warning, preserving the valid containment boundary.
  test("relative root entries are excluded while valid roots survive", () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        session_launcher: {
          root_dirs: ["relative/root", dir],
          command: "run",
        },
      }),
    );

    expect(loadConfig(file, log).session_launcher?.root_dirs).toEqual([path.resolve(dir)]);
    expect(warnings).toHaveLength(1);
  });

  // clean_env absent means "no cleaning" (the pre-addendum contract): the
  // parsed config carries an empty list, so the launcher passes the daemon
  // env through untouched — existing configs keep their exact behavior.
  test("absent clean_env parses to an empty list without warning", () => {
    fs.writeFileSync(
      file,
      JSON.stringify({ session_launcher: { root_dirs: [dir], command: "run" } }),
    );
    expect(loadConfig(file, log).session_launcher?.clean_env).toEqual([]);
    expect(warnings).toEqual([]);
  });

  // A wrong-typed clean_env is a repairable pattern list, not a security
  // boundary like root_dirs: it degrades to "no cleaning" with one warning
  // while the launcher itself stays available.
  test("non-array clean_env warns and degrades to no cleaning", () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        session_launcher: { root_dirs: [dir], command: "run", clean_env: "CLAUDE_*" },
      }),
    );
    expect(loadConfig(file, log).session_launcher?.clean_env).toEqual([]);
    expect(warnings).toHaveLength(1);
  });

  // Bad elements are skipped individually (same policy as root_dirs entries):
  // an empty string or non-string entry cannot express a key pattern, but it
  // must not erase the independent good patterns beside it.
  test("empty or non-string clean_env entries are skipped while good patterns survive", () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        session_launcher: {
          root_dirs: [dir],
          command: "run",
          clean_env: ["CLAUDE_*", "", 42, "AI_AGENT"],
        },
      }),
    );
    expect(loadConfig(file, log).session_launcher?.clean_env).toEqual(["CLAUDE_*", "AI_AGENT"]);
    expect(warnings).toHaveLength(2);
  });

  // keep_env absent means "no exceptions" (clean_env removes its matches
  // unimpeded): existing configs written before the allowlist keep their
  // exact behavior, expressed as an empty list.
  test("absent keep_env parses to an empty list without warning", () => {
    fs.writeFileSync(
      file,
      JSON.stringify({ session_launcher: { root_dirs: [dir], command: "run" } }),
    );
    expect(loadConfig(file, log).session_launcher?.keep_env).toEqual([]);
    expect(warnings).toEqual([]);
  });

  // Same degrade policy as clean_env (shared parser): a wrong-typed keep_env
  // is a repairable pattern list — one warning, empty list, launcher stays
  // available. Note the failure direction differs from clean_env: degrading
  // keep_env to [] means MORE keys get cleaned, which is the safe direction
  // for the cleaning contract (an unparseable allowlist must not silently
  // disable cleaning).
  test("non-array keep_env warns and degrades to no exceptions", () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        session_launcher: { root_dirs: [dir], command: "run", keep_env: "CLAUDE_CONFIG_DIR" },
      }),
    );
    expect(loadConfig(file, log).session_launcher?.keep_env).toEqual([]);
    expect(warnings).toHaveLength(1);
  });

  // Element-level skipping mirrors clean_env: a malformed entry is dropped
  // with a warning, and independent good keep patterns beside it survive.
  test("empty or non-string keep_env entries are skipped while good patterns survive", () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        session_launcher: {
          root_dirs: [dir],
          command: "run",
          keep_env: ["CLAUDE_CONFIG_DIR", "", 42, "CLAUDE_CODE_ENTRYPOINT"],
        },
      }),
    );
    expect(loadConfig(file, log).session_launcher?.keep_env).toEqual([
      "CLAUDE_CONFIG_DIR",
      "CLAUDE_CODE_ENTRYPOINT",
    ]);
    expect(warnings).toHaveLength(2);
  });

  // terminal_gateway_url (issue 2026-07-21-webui-terminal-tab-embed):
  // 独立トップレベルキー。session_launcher の有無とは無関係にパースする。
  describe("terminal_gateway_url", () => {
    test("valid https URL is retained", () => {
      fs.writeFileSync(file, JSON.stringify({ terminal_gateway_url: "https://gw.example" }));
      expect(loadConfig(file, log).terminal_gateway_url).toBe("https://gw.example");
      expect(warnings).toEqual([]);
    });

    test("valid http URL with port is retained", () => {
      fs.writeFileSync(file, JSON.stringify({ terminal_gateway_url: "http://127.0.0.1:43690" }));
      expect(loadConfig(file, log).terminal_gateway_url).toBe("http://127.0.0.1:43690");
    });

    test("whitespace is trimmed", () => {
      fs.writeFileSync(file, JSON.stringify({ terminal_gateway_url: "  https://gw.example  " }));
      expect(loadConfig(file, log).terminal_gateway_url).toBe("https://gw.example");
    });

    test("non-string / empty value degrades to unset with a warning", () => {
      for (const value of [42, "", "   ", null]) {
        fs.writeFileSync(file, JSON.stringify({ terminal_gateway_url: value }));
        warnings = [];
        expect(loadConfig(file, log).terminal_gateway_url).toBeUndefined();
        expect(warnings).toHaveLength(1);
      }
    });

    test("unparseable URL degrades to unset with a warning", () => {
      fs.writeFileSync(file, JSON.stringify({ terminal_gateway_url: "not a url" }));
      expect(loadConfig(file, log).terminal_gateway_url).toBeUndefined();
      expect(warnings).toHaveLength(1);
    });

    test("non-http scheme is rejected (ftp / javascript / file)", () => {
      for (const value of ["ftp://gw.example", "javascript:alert(1)", "file:///etc/passwd"]) {
        fs.writeFileSync(file, JSON.stringify({ terminal_gateway_url: value }));
        warnings = [];
        expect(loadConfig(file, log).terminal_gateway_url).toBeUndefined();
        expect(warnings).toHaveLength(1);
      }
    });

    test("coexists with session_launcher", () => {
      fs.writeFileSync(
        file,
        JSON.stringify({
          session_launcher: { root_dirs: [dir], command: "run" },
          terminal_gateway_url: "https://gw.example",
        }),
      );
      const cfg = loadConfig(file, log);
      expect(cfg.session_launcher).toBeDefined();
      expect(cfg.terminal_gateway_url).toBe("https://gw.example");
    });
  });
});
