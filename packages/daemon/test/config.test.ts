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
  let jsFile: string;
  // The pair the daemon hands over; `file` stays the JSON one so the cases
  // below read as they did before config.js existed.
  let files: { config: string; configJs: string };
  let warnings: string[];
  const log = { warn: (msg: string) => warnings.push(msg) };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-config-"));
    file = path.join(dir, "config.json");
    jsFile = path.join(dir, "config.js");
    files = { config: file, configJs: jsFile };
    warnings = [];
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // A missing file is the normal unconfigured state, so startup stays quiet and
  // exposes no launcher rather than treating first use as an error.
  test("missing file returns an empty config without warning", () => {
    expect(loadConfig(files, log)).toEqual({});
    expect(warnings).toEqual([]);
  });

  // Broken JSON is user-editable garbage: the daemon must stay available and
  // make the launcher unavailable, with one diagnostic for repair.
  test("broken JSON returns an empty config with one warning", () => {
    fs.writeFileSync(file, "{not-json");
    expect(loadConfig(files, log)).toEqual({});
    expect(warnings).toHaveLength(1);
  });

  // The top-level contract is a JSON object. Scalars and arrays cannot contain
  // daemon keys, so both degrade to the same safe empty configuration.
  test("non-object JSON values return an empty config with a warning", () => {
    for (const value of ["null", "42", "[]"]) {
      fs.writeFileSync(file, value);
      warnings = [];
      expect(loadConfig(files, log)).toEqual({});
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
          shell: "zsh",
          templates: [
            {
              name: "new",
              command: 'claude --model "$MODEL" "$PROMPT"',
              params: { CWD: "", MODEL: "fable", PROMPT: "start here" },
            },
          ],
          timeout_seconds: 25,
          dir_tree_depth: 3,
          clean_env: ["CLAUDE_*", "AI_AGENT"],
          keep_env: ["CLAUDE_CONFIG_DIR"],
        },
      }),
    );

    expect(loadConfig(files, log)).toEqual({
      session_launcher: {
        root_dirs: [path.resolve(root)],
        templates: [
          {
            name: "new",
            command: 'claude --model "$MODEL" "$PROMPT"',
            // Declaration order is the form's field order, so it is preserved
            // as written rather than normalized into some canonical order.
            params: [
              { name: "CWD", default: "" },
              { name: "MODEL", default: "fable" },
              { name: "PROMPT", default: "start here" },
            ],
            shell: "zsh",
          },
        ],
        timeout_seconds: 25,
        dir_tree_depth: 3,
        clean_env: ["CLAUDE_*", "AI_AGENT"],
        keep_env: ["CLAUDE_CONFIG_DIR"],
      },
    });
    expect(warnings).toEqual([]);
  });

  // Every recipe needs a directory to run in, so a declaration that forgot CWD
  // gets it first rather than producing a form with no way to pick one.
  test("a params declaration without CWD gets it prepended", () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        session_launcher: {
          root_dirs: [dir],
          templates: [{ name: "t", command: "run", params: { PROMPT: "hi" } }],
        },
      }),
    );

    expect(loadConfig(files, log).session_launcher?.templates[0]?.params).toEqual([
      { name: "CWD", default: "" },
      { name: "PROMPT", default: "hi" },
    ]);
    expect(warnings).toEqual([]);
  });

  // A parameter name reaches the launcher shell as a variable assignment, so
  // anything that is not an identifier would be a syntax error at launch;
  // rejecting it here costs one input instead of the whole launch. A
  // non-string default is the same class of repairable typo.
  test("a parameter with a bad name or a non-string default is skipped", () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        session_launcher: {
          root_dirs: [dir],
          templates: [
            {
              name: "t",
              command: "run",
              params: { "not an ident": "", "1ST": "", MODEL: 7, PROMPT: "" },
            },
          ],
        },
      }),
    );

    expect(loadConfig(files, log).session_launcher?.templates[0]?.params).toEqual([
      { name: "CWD", default: "" },
      { name: "PROMPT", default: "" },
    ]);
    expect(warnings).toHaveLength(3);
  });

  // The pre-`params` form still launches: its parameter list is re-derived from
  // the variables each command actually reads, which is the same set the webui
  // used to infer at render time. One warning points at the current form.
  test("a legacy config is normalized into params, with a deprecation warning", () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        session_launcher: {
          root_dirs: [dir],
          default_prompt: "shared",
          command: 'claude --model "$MODEL" --effort "$EFFORT" "$PROMPT"',
          templates: [
            { name: "new" },
            {
              name: "fork",
              default_prompt: "",
              command: 'claude --resume "$RESUME_SID" --resume-session-at="$RESUME_AT" "$PROMPT"',
            },
          ],
        },
      }),
    );

    const templates = loadConfig(files, log).session_launcher?.templates;
    expect(templates?.[0]?.params).toEqual([
      { name: "CWD", default: "" },
      { name: "MODEL", default: "fable" },
      { name: "EFFORT", default: "medium" },
      { name: "PROMPT", default: "shared" },
    ]);
    // The fork recipe reads the resume pair and overrode the prompt to empty;
    // it never mentions $MODEL, so no model input is implied for it.
    expect(templates?.[1]?.params).toEqual([
      { name: "CWD", default: "" },
      { name: "PROMPT", default: "" },
      { name: "RESUME_SID", default: "" },
      { name: "RESUME_AT", default: "" },
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("params");
  });

  // The flat (pre-templates) form goes through the same normalization: one
  // implicit recipe, its parameters read off its command.
  test("the flat single-command form normalizes to one declared recipe", () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        session_launcher: { root_dirs: [dir], command: 'run "$PROMPT"', default_prompt: "hi" },
      }),
    );

    expect(loadConfig(files, log).session_launcher?.templates).toEqual([
      {
        name: "default",
        command: 'run "$PROMPT"',
        params: [
          { name: "CWD", default: "" },
          { name: "PROMPT", default: "hi" },
        ],
        shell: "bash",
      },
    ]);
    expect(warnings).toHaveLength(1);
  });

  // DR-0018's user-facing examples use ~/..., so the parser expands it against
  // the daemon user's actual home before absolute-path normalization.
  test("a ~/ root expands to the daemon user's home", () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        session_launcher: {
          root_dirs: ["~/launcher-root"],
          templates: [{ name: "default", command: "run", params: { CWD: "" } }],
        },
      }),
    );

    expect(loadConfig(files, log).session_launcher?.root_dirs).toEqual([
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
            templates: [{ name: "default", command: "run", params: { CWD: "" } }],
            ...(shell === undefined ? {} : { shell }),
          },
        }),
      );
      warnings = [];
      expect(loadConfig(files, log).session_launcher?.templates[0]?.shell).toBe("bash");
      expect(warnings).toHaveLength(warningCount);
    }
  });

  // Each entry may state only what differs from the launcher-level `shell`,
  // and the parsed form is fully resolved so nothing downstream re-applies the
  // inheritance.
  test("templates inherit the launcher-level shell", () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        session_launcher: {
          root_dirs: [dir],
          shell: "zsh",
          templates: [
            { name: "plain", command: "run $PROMPT", params: { PROMPT: "shared" } },
            {
              name: "fork",
              command: 'run --resume "$RESUME_SID"',
              params: { RESUME_SID: "" },
              shell: "bash",
            },
          ],
        },
      }),
    );

    expect(loadConfig(files, log).session_launcher?.templates).toEqual([
      {
        name: "plain",
        command: "run $PROMPT",
        params: [
          { name: "CWD", default: "" },
          { name: "PROMPT", default: "shared" },
        ],
        shell: "zsh",
      },
      {
        name: "fork",
        command: 'run --resume "$RESUME_SID"',
        params: [
          { name: "CWD", default: "" },
          { name: "RESUME_SID", default: "" },
        ],
        shell: "bash",
      },
    ]);
    expect(warnings).toEqual([]);
  });

  // One unusable recipe must not take the usable ones down with it — the same
  // entry-level degradation the env pattern lists use. Each rejected entry
  // gets its own warning so the user knows which line to repair.
  test("a broken template entry is skipped while its siblings survive", () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        session_launcher: {
          root_dirs: [dir],
          templates: [
            "not-an-object",
            { name: "", command: "run", params: {} },
            { name: "good", command: "run", params: {} },
            { name: "good", command: "shadow", params: {} },
            { name: "commandless", params: {} },
          ],
        },
      }),
    );

    expect(loadConfig(files, log).session_launcher?.templates).toEqual([
      { name: "good", command: "run", params: [{ name: "CWD", default: "" }], shell: "bash" },
    ]);
    expect(warnings).toHaveLength(4);
  });

  // With no usable recipe left there is nothing to launch, so the launcher
  // disables itself exactly as a missing command used to.
  test("templates that all fail to parse disable session_launcher", () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        session_launcher: {
          root_dirs: [dir],
          templates: [{ name: "commandless" }],
        },
      }),
    );

    expect(loadConfig(files, log).session_launcher).toBeUndefined();
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
            templates: [{ name: "default", command: "run", params: { CWD: "" } }],
          },
        }),
      );
      warnings = [];
      expect(loadConfig(files, log).session_launcher).toBeUndefined();
      expect(warnings).toHaveLength(1);
    }
  });

  // command is the fixed launch program selected by the administrator. Without
  // it, accepting session_launch would create an undefined execution contract.
  test("missing command disables session_launcher", () => {
    fs.writeFileSync(file, JSON.stringify({ session_launcher: { root_dirs: [dir] } }));
    expect(loadConfig(files, log).session_launcher).toBeUndefined();
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
            templates: [{ name: "default", command: "run", params: { CWD: "" } }],
            timeout_seconds: invalid,
            dir_tree_depth: invalid,
          },
        }),
      );
      warnings = [];
      const cfg = loadConfig(files, log).session_launcher!;
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
          templates: [{ name: "default", command: "run", params: { CWD: "" } }],
        },
      }),
    );

    expect(loadConfig(files, log).session_launcher?.root_dirs).toEqual([path.resolve(dir)]);
    expect(warnings).toHaveLength(1);
  });

  // clean_env absent means "no cleaning" (the pre-addendum contract): the
  // parsed config carries an empty list, so the launcher passes the daemon
  // env through untouched — existing configs keep their exact behavior.
  test("absent clean_env parses to an empty list without warning", () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        session_launcher: {
          root_dirs: [dir],
          templates: [{ name: "default", command: "run", params: { CWD: "" } }],
        },
      }),
    );
    expect(loadConfig(files, log).session_launcher?.clean_env).toEqual([]);
    expect(warnings).toEqual([]);
  });

  // A wrong-typed clean_env is a repairable pattern list, not a security
  // boundary like root_dirs: it degrades to "no cleaning" with one warning
  // while the launcher itself stays available.
  test("non-array clean_env warns and degrades to no cleaning", () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        session_launcher: {
          root_dirs: [dir],
          templates: [{ name: "default", command: "run", params: { CWD: "" } }],
          clean_env: "CLAUDE_*",
        },
      }),
    );
    expect(loadConfig(files, log).session_launcher?.clean_env).toEqual([]);
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
          templates: [{ name: "default", command: "run", params: { CWD: "" } }],
          clean_env: ["CLAUDE_*", "", 42, "AI_AGENT"],
        },
      }),
    );
    expect(loadConfig(files, log).session_launcher?.clean_env).toEqual(["CLAUDE_*", "AI_AGENT"]);
    expect(warnings).toHaveLength(2);
  });

  // keep_env absent means "no exceptions" (clean_env removes its matches
  // unimpeded): existing configs written before the allowlist keep their
  // exact behavior, expressed as an empty list.
  test("absent keep_env parses to an empty list without warning", () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        session_launcher: {
          root_dirs: [dir],
          templates: [{ name: "default", command: "run", params: { CWD: "" } }],
        },
      }),
    );
    expect(loadConfig(files, log).session_launcher?.keep_env).toEqual([]);
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
        session_launcher: {
          root_dirs: [dir],
          templates: [{ name: "default", command: "run", params: { CWD: "" } }],
          keep_env: "CLAUDE_CONFIG_DIR",
        },
      }),
    );
    expect(loadConfig(files, log).session_launcher?.keep_env).toEqual([]);
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
          templates: [{ name: "default", command: "run", params: { CWD: "" } }],
          keep_env: ["CLAUDE_CONFIG_DIR", "", 42, "CLAUDE_CODE_ENTRYPOINT"],
        },
      }),
    );
    expect(loadConfig(files, log).session_launcher?.keep_env).toEqual([
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
      expect(loadConfig(files, log).terminal_gateway_url).toBe("https://gw.example");
      expect(warnings).toEqual([]);
    });

    test("valid http URL with port is retained", () => {
      fs.writeFileSync(file, JSON.stringify({ terminal_gateway_url: "http://127.0.0.1:43690" }));
      expect(loadConfig(files, log).terminal_gateway_url).toBe("http://127.0.0.1:43690");
    });

    test("whitespace is trimmed", () => {
      fs.writeFileSync(file, JSON.stringify({ terminal_gateway_url: "  https://gw.example  " }));
      expect(loadConfig(files, log).terminal_gateway_url).toBe("https://gw.example");
    });

    test("non-string / empty value degrades to unset with a warning", () => {
      for (const value of [42, "", "   ", null]) {
        fs.writeFileSync(file, JSON.stringify({ terminal_gateway_url: value }));
        warnings = [];
        expect(loadConfig(files, log).terminal_gateway_url).toBeUndefined();
        expect(warnings).toHaveLength(1);
      }
    });

    test("unparseable URL degrades to unset with a warning", () => {
      fs.writeFileSync(file, JSON.stringify({ terminal_gateway_url: "not a url" }));
      expect(loadConfig(files, log).terminal_gateway_url).toBeUndefined();
      expect(warnings).toHaveLength(1);
    });

    test("non-http scheme is rejected (ftp / javascript / file)", () => {
      for (const value of ["ftp://gw.example", "javascript:alert(1)", "file:///etc/passwd"]) {
        fs.writeFileSync(file, JSON.stringify({ terminal_gateway_url: value }));
        warnings = [];
        expect(loadConfig(files, log).terminal_gateway_url).toBeUndefined();
        expect(warnings).toHaveLength(1);
      }
    });

    test("coexists with session_launcher", () => {
      fs.writeFileSync(
        file,
        JSON.stringify({
          session_launcher: {
            root_dirs: [dir],
            templates: [{ name: "default", command: "run", params: { CWD: "" } }],
          },
          terminal_gateway_url: "https://gw.example",
        }),
      );
      const cfg = loadConfig(files, log);
      expect(cfg.session_launcher).toBeDefined();
      expect(cfg.terminal_gateway_url).toBe("https://gw.example");
    });
  });

  // llm_usage_url: another independent top-level key, sharing
  // terminal_gateway_url's absolute-http(s)-URL rule. Its own describe rather
  // than parametrising both keys through one block — the two features fail
  // independently, and a shared table would hide which one a regression hit.
  describe("llm_usage_url", () => {
    test("valid https URL is retained", () => {
      fs.writeFileSync(file, JSON.stringify({ llm_usage_url: "https://gw.example/usage" }));
      expect(loadConfig(files, log).llm_usage_url).toBe("https://gw.example/usage");
      expect(warnings).toEqual([]);
    });

    test("whitespace is trimmed", () => {
      fs.writeFileSync(file, JSON.stringify({ llm_usage_url: "  http://127.0.0.1:8080/usage  " }));
      expect(loadConfig(files, log).llm_usage_url).toBe("http://127.0.0.1:8080/usage");
    });

    test("non-string / empty / unparseable / non-http degrades to unset with a warning", () => {
      for (const value of [42, "", "   ", null, "not a url", "file:///etc/passwd"]) {
        fs.writeFileSync(file, JSON.stringify({ llm_usage_url: value }));
        warnings = [];
        expect(loadConfig(files, log).llm_usage_url).toBeUndefined();
        expect(warnings).toHaveLength(1);
      }
    });

    // Each URL key must degrade on its own: a typo in one cannot take the
    // other feature down with it.
    test("a malformed sibling URL key does not disturb this one", () => {
      fs.writeFileSync(
        file,
        JSON.stringify({
          terminal_gateway_url: "not a url",
          llm_usage_url: "https://gw.example/usage",
        }),
      );
      const cfg = loadConfig(files, log);
      expect(cfg.terminal_gateway_url).toBeUndefined();
      expect(cfg.llm_usage_url).toBe("https://gw.example/usage");
      expect(warnings).toHaveLength(1);
    });
  });

  // llm_stats_url: the spend endpoint, configured independently of the quota
  // one — an operator can set up either without the other, and the webui shows
  // only the section whose endpoint exists.
  describe("llm_stats_url", () => {
    test("valid https URL is retained", () => {
      fs.writeFileSync(file, JSON.stringify({ llm_stats_url: "https://gw.example/stats" }));
      expect(loadConfig(files, log).llm_stats_url).toBe("https://gw.example/stats");
      expect(warnings).toEqual([]);
    });

    // The operator's likely source is a URL they were reading in a browser,
    // which already carries a window; the query string has to survive the
    // config (the op overwrites just the `days` parameter).
    test("an existing query string is retained", () => {
      fs.writeFileSync(file, JSON.stringify({ llm_stats_url: "https://gw.example/stats?days=30" }));
      expect(loadConfig(files, log).llm_stats_url).toBe("https://gw.example/stats?days=30");
    });

    test("non-string / empty / unparseable / non-http degrades to unset with a warning", () => {
      for (const value of [42, "", "   ", null, "not a url", "file:///etc/passwd"]) {
        fs.writeFileSync(file, JSON.stringify({ llm_stats_url: value }));
        warnings = [];
        expect(loadConfig(files, log).llm_stats_url).toBeUndefined();
        expect(warnings).toHaveLength(1);
      }
    });

    test("the two llm URL keys degrade independently of each other", () => {
      fs.writeFileSync(
        file,
        JSON.stringify({
          llm_usage_url: "not a url",
          llm_stats_url: "https://gw.example/stats",
        }),
      );
      const cfg = loadConfig(files, log);
      expect(cfg.llm_usage_url).toBeUndefined();
      expect(cfg.llm_stats_url).toBe("https://gw.example/stats");
      expect(warnings).toHaveLength(1);
    });
  });

  // llm_events_url named the SSE stream the daemon used to subscribe to. The
  // gateway now posts to ccmsg instead, so the key is dead — but a config
  // still carrying it must say so rather than silently doing nothing.
  describe("llm_events_url (retired)", () => {
    test("is ignored with a warning pointing at its replacement", () => {
      fs.writeFileSync(file, JSON.stringify({ llm_events_url: "http://127.0.0.1:8402/events" }));
      const cfg = loadConfig(files, log);
      expect(cfg).toEqual({});
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("webhooks");
    });
  });

  // webhooks: which producers may POST to /webhook/<source>, and where each
  // one's bearer token is kept. The token itself is deliberately not a config
  // value — see the DaemonConfig doc comment.
  describe("webhooks", () => {
    test("a source with a token file is retained, with ~ expanded", () => {
      fs.writeFileSync(
        file,
        JSON.stringify({ webhooks: { "llm-gateway": { token_file: "~/secrets/gw.token" } } }),
      );
      const cfg = loadConfig(files, log);
      expect(cfg.webhooks?.["llm-gateway"]?.token_file).toBe(
        path.join(os.homedir(), "secrets/gw.token"),
      );
      expect(warnings).toEqual([]);
    });

    test("several sources coexist", () => {
      fs.writeFileSync(
        file,
        JSON.stringify({
          webhooks: {
            "llm-gateway": { token_file: "/tmp/a.token" },
            "some-other": { token_file: "/tmp/b.token" },
          },
        }),
      );
      expect(Object.keys(loadConfig(files, log).webhooks ?? {}).sort()).toEqual([
        "llm-gateway",
        "some-other",
      ]);
    });

    test("a source name that could not be a path segment is dropped", () => {
      // The name selects a config entry from a URL path, so anything that
      // could express traversal or case tricks must not survive parsing.
      for (const source of ["../etc", "Llm-Gateway", "llm gateway", "a".repeat(65), ""]) {
        fs.writeFileSync(file, JSON.stringify({ webhooks: { [source]: { token_file: "/t" } } }));
        warnings = [];
        expect(loadConfig(files, log).webhooks).toBeUndefined();
        expect(warnings).toHaveLength(1);
      }
    });

    test("an entry without a usable token_file is dropped, leaving the others", () => {
      fs.writeFileSync(
        file,
        JSON.stringify({
          webhooks: {
            "llm-gateway": { token_file: "/tmp/a.token" },
            broken: { token_file: "  " },
            "also-broken": {},
          },
        }),
      );
      const cfg = loadConfig(files, log);
      expect(Object.keys(cfg.webhooks ?? {})).toEqual(["llm-gateway"]);
      expect(warnings).toHaveLength(2);
    });

    test("a non-object webhooks value degrades to unset with a warning", () => {
      fs.writeFileSync(file, JSON.stringify({ webhooks: "llm-gateway" }));
      expect(loadConfig(files, log).webhooks).toBeUndefined();
      expect(warnings).toHaveLength(1);
    });
  });
  // `config.js` exists because a launcher command is a shell script, and JSON
  // can only hold one as a single escaped line. Everything past the file read
  // is shared with the JSON path, so these cases cover the choice of file and
  // the module-specific failures — not the field validation above.
  describe("config.js", () => {
    test("a module's default export is used and multi-line strings survive", () => {
      fs.writeFileSync(
        jsFile,
        [
          "export default {",
          "  session_launcher: {",
          "    root_dirs: [" + JSON.stringify(dir) + "],",
          "    templates: [",
          "      {",
          "        name: 'multiline',",
          "        command: `cd $CWD &&",
          "  claude --model $MODEL`,",
          "        params: { CWD: '', MODEL: 'fable' },",
          "      },",
          "    ],",
          "  },",
          "};",
        ].join("\n"),
      );
      const templates = loadConfig(files, log).session_launcher?.templates;
      expect(templates?.[0]?.command).toBe("cd $CWD &&\n  claude --model $MODEL");
      expect(warnings).toEqual([]);
    });

    // Both files present is a half-finished migration, not a merge: the newer
    // form wins and the user is told which file stopped being read.
    test("config.js wins over config.json, with one warning naming both", () => {
      fs.writeFileSync(jsFile, 'export default { terminal_gateway_url: "http://js.example/" };');
      fs.writeFileSync(file, JSON.stringify({ terminal_gateway_url: "http://json.example/" }));
      expect(loadConfig(files, log).terminal_gateway_url).toBe("http://js.example/");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("config.json");
    });

    // A module that cannot be evaluated is user-editable garbage, exactly like
    // broken JSON: warn once, start the daemon, expose nothing.
    test("a module that throws or fails to parse returns an empty config", () => {
      for (const source of ["export default { a: ;", 'throw new Error("boom");']) {
        fs.rmSync(jsFile, { force: true });
        // A fresh path per case: modules are cached by path once required.
        jsFile = path.join(dir, `broken-${warnings.length}-${source.length}.js`);
        files = { config: file, configJs: jsFile };
        fs.writeFileSync(jsFile, source);
        warnings = [];
        expect(loadConfig(files, log)).toEqual({});
        expect(warnings).toHaveLength(1);
      }
    });

    // Top-level `await` is the one shape a synchronous load cannot support.
    // It degrades like any other unloadable module rather than crashing startup.
    test("a module using top-level await degrades with a warning", () => {
      fs.writeFileSync(jsFile, "await Promise.resolve();\nexport default {};");
      expect(loadConfig(files, log)).toEqual({});
      expect(warnings).toHaveLength(1);
    });

    test("a module without an object default export returns an empty config", () => {
      for (const source of ["export const a = 1;", "export default 42;"]) {
        jsFile = path.join(dir, `nodefault-${source.length}.js`);
        files = { config: file, configJs: jsFile };
        fs.writeFileSync(jsFile, source);
        warnings = [];
        expect(loadConfig(files, log)).toEqual({});
        expect(warnings).toHaveLength(1);
      }
    });
  });
});
