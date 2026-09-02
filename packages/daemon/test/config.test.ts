// Session launcher config parsing (DR-0018 Phase 1): malformed or partial
// user configuration must never prevent the daemon from starting.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_DIR_TREE_DEPTH, DEFAULT_LAUNCH_TIMEOUT_SECONDS } from "@ccmsg/protocol";
import { CONFIG_TYPES_BASENAME, loadConfig, writeConfigTypesFile } from "../src/config.ts";

describe("loadConfig", () => {
  let dir: string;
  let file: string;
  let jsFile: string;
  let tsFile: string;
  // The trio the daemon hands over; `file` stays the JSON one and `tsFile`
  // stays absent so the cases below read as they did before config.js/.ts
  // existed.
  let files: { config: string; configJs: string; configTs: string };
  let warnings: string[];
  const log = { warn: (msg: string) => warnings.push(msg) };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-config-"));
    file = path.join(dir, "config.json");
    jsFile = path.join(dir, "config.js");
    tsFile = path.join(dir, "config.ts");
    files = { config: file, configJs: jsFile, configTs: tsFile };
    warnings = [];
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // A missing file is the normal unconfigured state, so startup stays quiet and
  // exposes no launcher rather than treating first use as an error.
  test("missing file returns an empty config without warning", async () => {
    expect(await loadConfig(files, log)).toEqual({});
    expect(warnings).toEqual([]);
  });

  // Broken JSON is user-editable garbage: the daemon must stay available and
  // make the launcher unavailable, with one diagnostic for repair.
  test("broken JSON returns an empty config with one warning", async () => {
    fs.writeFileSync(file, "{not-json");
    expect(await loadConfig(files, log)).toEqual({});
    expect(warnings).toHaveLength(1);
  });

  // The top-level contract is a JSON object. Scalars and arrays cannot contain
  // daemon keys, so both degrade to the same safe empty configuration.
  test("non-object JSON values return an empty config with a warning", async () => {
    for (const value of ["null", "42", "[]"]) {
      fs.writeFileSync(file, value);
      warnings = [];
      expect(await loadConfig(files, log)).toEqual({});
      expect(warnings).toHaveLength(1);
    }
  });

  // This is the complete accepted shape: every configured field survives while
  // root paths are normalized before they become containment boundaries.
  test("complete session_launcher parses every field", async () => {
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

    expect(await loadConfig(files, log)).toEqual({
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
  test("a params declaration without CWD gets it prepended", async () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        session_launcher: {
          root_dirs: [dir],
          templates: [{ name: "t", command: "run", params: { PROMPT: "hi" } }],
        },
      }),
    );

    expect((await loadConfig(files, log)).session_launcher?.templates[0]?.params).toEqual([
      { name: "CWD", default: "" },
      { name: "PROMPT", default: "hi" },
    ]);
    expect(warnings).toEqual([]);
  });

  // A parameter name reaches the launcher shell as a variable assignment, so
  // anything that is not an identifier would be a syntax error at launch;
  // rejecting it here costs one input instead of the whole launch. A
  // non-string default is the same class of repairable typo.
  test("a parameter with a bad name or a non-string default is skipped", async () => {
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

    expect((await loadConfig(files, log)).session_launcher?.templates[0]?.params).toEqual([
      { name: "CWD", default: "" },
      { name: "PROMPT", default: "" },
    ]);
    expect(warnings).toHaveLength(3);
  });

  // `params` is the only source of truth for the form's inputs, so a template
  // that omits it (or its command) is unusable and must not silently launch a
  // recipe nobody declared — it is skipped with a warning, exactly like any
  // other malformed entry, while its siblings keep working.
  test("templates without params or command are ignored with a warning", async () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        session_launcher: {
          root_dirs: [dir],
          templates: [
            { name: "no-params", command: 'run "$PROMPT"' },
            { name: "no-command", params: { PROMPT: "" } },
            { name: "ok", command: 'run "$PROMPT"', params: { PROMPT: "hi" } },
          ],
        },
      }),
    );

    expect((await loadConfig(files, log)).session_launcher?.templates).toEqual([
      {
        name: "ok",
        command: 'run "$PROMPT"',
        params: [
          { name: "CWD", default: "" },
          { name: "PROMPT", default: "hi" },
        ],
        shell: "bash",
      },
    ]);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("no params");
    expect(warnings[1]).toContain("command must be a non-empty string");
  });

  // No `templates` key at all leaves nothing to launch, so the launcher is
  // disabled rather than inferring a recipe from other fields.
  test("a launcher without templates is disabled", async () => {
    fs.writeFileSync(file, JSON.stringify({ session_launcher: { root_dirs: [dir] } }));

    expect((await loadConfig(files, log)).session_launcher).toBeUndefined();
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("templates must be an array");
    expect(warnings[1]).toContain("launcher disabled");
  });

  // DR-0018's user-facing examples use ~/..., so the parser expands it against
  // the daemon user's actual home before absolute-path normalization.
  test("a ~/ root expands to the daemon user's home", async () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        session_launcher: {
          root_dirs: ["~/launcher-root"],
          templates: [{ name: "default", command: "run", params: { CWD: "" } }],
        },
      }),
    );

    expect((await loadConfig(files, log)).session_launcher?.root_dirs).toEqual([
      path.join(os.homedir(), "launcher-root"),
    ]);
  });

  // shell is deliberately a built-in two-choice contract. Missing selects the
  // documented bash default; malformed supplied values also default but warn.
  test("shell defaults to bash and rejects values outside bash or zsh", async () => {
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
      expect((await loadConfig(files, log)).session_launcher?.templates[0]?.shell).toBe("bash");
      expect(warnings).toHaveLength(warningCount);
    }
  });

  // Each entry may state only what differs from the launcher-level `shell`,
  // and the parsed form is fully resolved so nothing downstream re-applies the
  // inheritance.
  test("templates inherit the launcher-level shell", async () => {
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

    expect((await loadConfig(files, log)).session_launcher?.templates).toEqual([
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
  test("a broken template entry is skipped while its siblings survive", async () => {
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

    expect((await loadConfig(files, log)).session_launcher?.templates).toEqual([
      { name: "good", command: "run", params: [{ name: "CWD", default: "" }], shell: "bash" },
    ]);
    expect(warnings).toHaveLength(4);
  });

  // With no usable recipe left there is nothing to launch, so the launcher
  // disables itself exactly as a missing command used to.
  test("templates that all fail to parse disable session_launcher", async () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        session_launcher: {
          root_dirs: [dir],
          templates: [{ name: "commandless" }],
        },
      }),
    );

    expect((await loadConfig(files, log)).session_launcher).toBeUndefined();
  });

  // Containment cannot be defined without at least one root, so absent, empty,
  // or wrong-typed roots disable the whole launcher rather than opening it wide.
  test("missing, empty, or non-array root_dirs disables session_launcher", async () => {
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
      expect((await loadConfig(files, log)).session_launcher).toBeUndefined();
      expect(warnings).toHaveLength(1);
    }
  });

  // Numeric garbage is localized to the affected field: the launcher remains
  // usable and receives the DR defaults instead of crashing or accepting zero.
  test("invalid timeout and tree depth fall back to defaults", async () => {
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
      const cfg = (await loadConfig(files, log)).session_launcher!;
      expect(cfg.timeout_seconds).toBe(DEFAULT_LAUNCH_TIMEOUT_SECONDS);
      expect(cfg.dir_tree_depth).toBe(DEFAULT_DIR_TREE_DEPTH);
      expect(warnings).toHaveLength(2);
    }
  });

  // A bad element must not erase independent good roots. Relative entries are
  // excluded with a warning, preserving the valid containment boundary.
  test("relative root entries are excluded while valid roots survive", async () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        session_launcher: {
          root_dirs: ["relative/root", dir],
          templates: [{ name: "default", command: "run", params: { CWD: "" } }],
        },
      }),
    );

    expect((await loadConfig(files, log)).session_launcher?.root_dirs).toEqual([path.resolve(dir)]);
    expect(warnings).toHaveLength(1);
  });

  // clean_env absent means "no cleaning" (the pre-addendum contract): the
  // parsed config carries an empty list, so the launcher passes the daemon
  // env through untouched — existing configs keep their exact behavior.
  test("absent clean_env parses to an empty list without warning", async () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        session_launcher: {
          root_dirs: [dir],
          templates: [{ name: "default", command: "run", params: { CWD: "" } }],
        },
      }),
    );
    expect((await loadConfig(files, log)).session_launcher?.clean_env).toEqual([]);
    expect(warnings).toEqual([]);
  });

  // A wrong-typed clean_env is a repairable pattern list, not a security
  // boundary like root_dirs: it degrades to "no cleaning" with one warning
  // while the launcher itself stays available.
  test("non-array clean_env warns and degrades to no cleaning", async () => {
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
    expect((await loadConfig(files, log)).session_launcher?.clean_env).toEqual([]);
    expect(warnings).toHaveLength(1);
  });

  // Bad elements are skipped individually (same policy as root_dirs entries):
  // an empty string or non-string entry cannot express a key pattern, but it
  // must not erase the independent good patterns beside it.
  test("empty or non-string clean_env entries are skipped while good patterns survive", async () => {
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
    expect((await loadConfig(files, log)).session_launcher?.clean_env).toEqual([
      "CLAUDE_*",
      "AI_AGENT",
    ]);
    expect(warnings).toHaveLength(2);
  });

  // keep_env absent means "no exceptions" (clean_env removes its matches
  // unimpeded): existing configs written before the allowlist keep their
  // exact behavior, expressed as an empty list.
  test("absent keep_env parses to an empty list without warning", async () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        session_launcher: {
          root_dirs: [dir],
          templates: [{ name: "default", command: "run", params: { CWD: "" } }],
        },
      }),
    );
    expect((await loadConfig(files, log)).session_launcher?.keep_env).toEqual([]);
    expect(warnings).toEqual([]);
  });

  // Same degrade policy as clean_env (shared parser): a wrong-typed keep_env
  // is a repairable pattern list — one warning, empty list, launcher stays
  // available. Note the failure direction differs from clean_env: degrading
  // keep_env to [] means MORE keys get cleaned, which is the safe direction
  // for the cleaning contract (an unparseable allowlist must not silently
  // disable cleaning).
  test("non-array keep_env warns and degrades to no exceptions", async () => {
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
    expect((await loadConfig(files, log)).session_launcher?.keep_env).toEqual([]);
    expect(warnings).toHaveLength(1);
  });

  // Element-level skipping mirrors clean_env: a malformed entry is dropped
  // with a warning, and independent good keep patterns beside it survive.
  test("empty or non-string keep_env entries are skipped while good patterns survive", async () => {
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
    expect((await loadConfig(files, log)).session_launcher?.keep_env).toEqual([
      "CLAUDE_CONFIG_DIR",
      "CLAUDE_CODE_ENTRYPOINT",
    ]);
    expect(warnings).toHaveLength(2);
  });

  // terminal_gateway_url (issue 2026-07-21-webui-terminal-tab-embed):
  // 独立トップレベルキー。session_launcher の有無とは無関係にパースする。
  describe("terminal_gateway_url", () => {
    test("valid https URL is retained", async () => {
      fs.writeFileSync(file, JSON.stringify({ terminal_gateway_url: "https://gw.example" }));
      expect((await loadConfig(files, log)).terminal_gateway_url).toBe("https://gw.example");
      expect(warnings).toEqual([]);
    });

    test("valid http URL with port is retained", async () => {
      fs.writeFileSync(file, JSON.stringify({ terminal_gateway_url: "http://127.0.0.1:43690" }));
      expect((await loadConfig(files, log)).terminal_gateway_url).toBe("http://127.0.0.1:43690");
    });

    test("whitespace is trimmed", async () => {
      fs.writeFileSync(file, JSON.stringify({ terminal_gateway_url: "  https://gw.example  " }));
      expect((await loadConfig(files, log)).terminal_gateway_url).toBe("https://gw.example");
    });

    test("non-string / empty value degrades to unset with a warning", async () => {
      for (const value of [42, "", "   ", null]) {
        fs.writeFileSync(file, JSON.stringify({ terminal_gateway_url: value }));
        warnings = [];
        expect((await loadConfig(files, log)).terminal_gateway_url).toBeUndefined();
        expect(warnings).toHaveLength(1);
      }
    });

    test("unparseable URL degrades to unset with a warning", async () => {
      fs.writeFileSync(file, JSON.stringify({ terminal_gateway_url: "not a url" }));
      expect((await loadConfig(files, log)).terminal_gateway_url).toBeUndefined();
      expect(warnings).toHaveLength(1);
    });

    test("non-http scheme is rejected (ftp / javascript / file)", async () => {
      for (const value of ["ftp://gw.example", "javascript:alert(1)", "file:///etc/passwd"]) {
        fs.writeFileSync(file, JSON.stringify({ terminal_gateway_url: value }));
        warnings = [];
        expect((await loadConfig(files, log)).terminal_gateway_url).toBeUndefined();
        expect(warnings).toHaveLength(1);
      }
    });

    test("coexists with session_launcher", async () => {
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
      const cfg = await loadConfig(files, log);
      expect(cfg.session_launcher).toBeDefined();
      expect(cfg.terminal_gateway_url).toBe("https://gw.example");
    });
  });

  // llm_usage_url: another independent top-level key, sharing
  // terminal_gateway_url's absolute-http(s)-URL rule. Its own describe rather
  // than parametrising both keys through one block — the two features fail
  // independently, and a shared table would hide which one a regression hit.
  describe("llm_usage_url", () => {
    test("valid https URL is retained", async () => {
      fs.writeFileSync(file, JSON.stringify({ llm_usage_url: "https://gw.example/usage" }));
      expect((await loadConfig(files, log)).llm_usage_url).toBe("https://gw.example/usage");
      expect(warnings).toEqual([]);
    });

    test("whitespace is trimmed", async () => {
      fs.writeFileSync(file, JSON.stringify({ llm_usage_url: "  http://127.0.0.1:8080/usage  " }));
      expect((await loadConfig(files, log)).llm_usage_url).toBe("http://127.0.0.1:8080/usage");
    });

    test("non-string / empty / unparseable / non-http degrades to unset with a warning", async () => {
      for (const value of [42, "", "   ", null, "not a url", "file:///etc/passwd"]) {
        fs.writeFileSync(file, JSON.stringify({ llm_usage_url: value }));
        warnings = [];
        expect((await loadConfig(files, log)).llm_usage_url).toBeUndefined();
        expect(warnings).toHaveLength(1);
      }
    });

    // Each URL key must degrade on its own: a typo in one cannot take the
    // other feature down with it.
    test("a malformed sibling URL key does not disturb this one", async () => {
      fs.writeFileSync(
        file,
        JSON.stringify({
          terminal_gateway_url: "not a url",
          llm_usage_url: "https://gw.example/usage",
        }),
      );
      const cfg = await loadConfig(files, log);
      expect(cfg.terminal_gateway_url).toBeUndefined();
      expect(cfg.llm_usage_url).toBe("https://gw.example/usage");
      expect(warnings).toHaveLength(1);
    });
  });

  // llm_stats_url: the spend endpoint, configured independently of the quota
  // one — an operator can set up either without the other, and the webui shows
  // only the section whose endpoint exists.
  describe("llm_stats_url", () => {
    test("valid https URL is retained", async () => {
      fs.writeFileSync(file, JSON.stringify({ llm_stats_url: "https://gw.example/stats" }));
      expect((await loadConfig(files, log)).llm_stats_url).toBe("https://gw.example/stats");
      expect(warnings).toEqual([]);
    });

    // The operator's likely source is a URL they were reading in a browser,
    // which already carries a window; the query string has to survive the
    // config (the op overwrites just the `days` parameter).
    test("an existing query string is retained", async () => {
      fs.writeFileSync(file, JSON.stringify({ llm_stats_url: "https://gw.example/stats?days=30" }));
      expect((await loadConfig(files, log)).llm_stats_url).toBe("https://gw.example/stats?days=30");
    });

    test("non-string / empty / unparseable / non-http degrades to unset with a warning", async () => {
      for (const value of [42, "", "   ", null, "not a url", "file:///etc/passwd"]) {
        fs.writeFileSync(file, JSON.stringify({ llm_stats_url: value }));
        warnings = [];
        expect((await loadConfig(files, log)).llm_stats_url).toBeUndefined();
        expect(warnings).toHaveLength(1);
      }
    });

    test("the two llm URL keys degrade independently of each other", async () => {
      fs.writeFileSync(
        file,
        JSON.stringify({
          llm_usage_url: "not a url",
          llm_stats_url: "https://gw.example/stats",
        }),
      );
      const cfg = await loadConfig(files, log);
      expect(cfg.llm_usage_url).toBeUndefined();
      expect(cfg.llm_stats_url).toBe("https://gw.example/stats");
      expect(warnings).toHaveLength(1);
    });
  });

  // llm_status_url: the upstream-service endpoint (gateway DR-0021), a third
  // independent key. Deliberately NOT derived from llm_usage_url: the three
  // endpoints are not guaranteed to sit on adjacent paths of one origin, and a
  // gateway old enough to serve usage may not serve status at all.
  describe("llm_status_url", () => {
    test("valid https URL is retained", async () => {
      fs.writeFileSync(file, JSON.stringify({ llm_status_url: "https://gw.example/status" }));
      expect((await loadConfig(files, log)).llm_status_url).toBe("https://gw.example/status");
      expect(warnings).toEqual([]);
    });

    test("non-string / empty / unparseable / non-http degrades to unset with a warning", async () => {
      for (const value of [42, "", "   ", null, "not a url", "file:///etc/passwd"]) {
        fs.writeFileSync(file, JSON.stringify({ llm_status_url: value }));
        warnings = [];
        expect((await loadConfig(files, log)).llm_status_url).toBeUndefined();
        expect(warnings).toHaveLength(1);
      }
    });

    // Configuring usage says nothing about status: the capability the webui
    // reads has to come from this key alone.
    test("is unset when only the usage endpoint is configured", async () => {
      fs.writeFileSync(file, JSON.stringify({ llm_usage_url: "https://gw.example/usage" }));
      const cfg = await loadConfig(files, log);
      expect(cfg.llm_usage_url).toBe("https://gw.example/usage");
      expect(cfg.llm_status_url).toBeUndefined();
    });

    test("the three llm URL keys degrade independently of each other", async () => {
      fs.writeFileSync(
        file,
        JSON.stringify({
          llm_usage_url: "not a url",
          llm_stats_url: "https://gw.example/stats",
          llm_status_url: "https://gw.example/status",
        }),
      );
      const cfg = await loadConfig(files, log);
      expect(cfg.llm_usage_url).toBeUndefined();
      expect(cfg.llm_stats_url).toBe("https://gw.example/stats");
      expect(cfg.llm_status_url).toBe("https://gw.example/status");
      expect(warnings).toHaveLength(1);
    });
  });

  // llm_events_url named the SSE stream the daemon used to subscribe to. The
  // gateway now posts to ccmsg instead, so the key is dead — but a config
  // still carrying it must say so rather than silently doing nothing.
  describe("llm_events_url (retired)", () => {
    test("is ignored with a warning pointing at its replacement", async () => {
      fs.writeFileSync(file, JSON.stringify({ llm_events_url: "http://127.0.0.1:8402/events" }));
      const cfg = await loadConfig(files, log);
      expect(cfg).toEqual({});
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("webhooks");
    });
  });

  // webhooks: which producers may POST to /webhook/<source>, and where each
  // one's bearer token is kept. The token itself is deliberately not a config
  // value — see the ResolvedCcmsgConfig doc comment.
  describe("webhooks", () => {
    test("a source with a token file is retained, with ~ expanded", async () => {
      fs.writeFileSync(
        file,
        JSON.stringify({ webhooks: { "llm-gateway": { token_file: "~/secrets/gw.token" } } }),
      );
      const cfg = await loadConfig(files, log);
      expect(cfg.webhooks?.["llm-gateway"]?.token_file).toBe(
        path.join(os.homedir(), "secrets/gw.token"),
      );
      expect(warnings).toEqual([]);
    });

    test("several sources coexist", async () => {
      fs.writeFileSync(
        file,
        JSON.stringify({
          webhooks: {
            "llm-gateway": { token_file: "/tmp/a.token" },
            "some-other": { token_file: "/tmp/b.token" },
          },
        }),
      );
      expect(Object.keys((await loadConfig(files, log)).webhooks ?? {}).sort()).toEqual([
        "llm-gateway",
        "some-other",
      ]);
    });

    test("a source name that could not be a path segment is dropped", async () => {
      // The name selects a config entry from a URL path, so anything that
      // could express traversal or case tricks must not survive parsing.
      for (const source of ["../etc", "Llm-Gateway", "llm gateway", "a".repeat(65), ""]) {
        fs.writeFileSync(file, JSON.stringify({ webhooks: { [source]: { token_file: "/t" } } }));
        warnings = [];
        expect((await loadConfig(files, log)).webhooks).toBeUndefined();
        expect(warnings).toHaveLength(1);
      }
    });

    test("an entry without a usable token_file is dropped, leaving the others", async () => {
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
      const cfg = await loadConfig(files, log);
      expect(Object.keys(cfg.webhooks ?? {})).toEqual(["llm-gateway"]);
      expect(warnings).toHaveLength(2);
    });

    test("a non-object webhooks value degrades to unset with a warning", async () => {
      fs.writeFileSync(file, JSON.stringify({ webhooks: "llm-gateway" }));
      expect((await loadConfig(files, log)).webhooks).toBeUndefined();
      expect(warnings).toHaveLength(1);
    });
  });
  // `config.js` exists because a launcher command is a shell script, and JSON
  // can only hold one as a single escaped line. Everything past the file read
  // is shared with the JSON path, so these cases cover the choice of file and
  // the module-specific failures — not the field validation above.
  describe("config.js", () => {
    test("a module's default export is used and multi-line strings survive", async () => {
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
      const templates = (await loadConfig(files, log)).session_launcher?.templates;
      expect(templates?.[0]?.command).toBe("cd $CWD &&\n  claude --model $MODEL");
      expect(warnings).toEqual([]);
    });

    // Both files present is a half-finished migration, not a merge: the newer
    // form wins and the user is told which file stopped being read.
    test("config.js wins over config.json, with one warning naming both", async () => {
      fs.writeFileSync(jsFile, 'export default { terminal_gateway_url: "http://js.example/" };');
      fs.writeFileSync(file, JSON.stringify({ terminal_gateway_url: "http://json.example/" }));
      expect((await loadConfig(files, log)).terminal_gateway_url).toBe("http://js.example/");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("config.json");
    });

    // A module that cannot be evaluated is user-editable garbage, exactly like
    // broken JSON: warn once, start the daemon, expose nothing.
    test("a module that throws or fails to parse returns an empty config", async () => {
      for (const source of ["export default { a: ;", 'throw new Error("boom");']) {
        fs.rmSync(jsFile, { force: true });
        // A fresh path per case: modules are cached by path once required.
        jsFile = path.join(dir, `broken-${warnings.length}-${source.length}.js`);
        files = { config: file, configJs: jsFile, configTs: tsFile };
        fs.writeFileSync(jsFile, source);
        warnings = [];
        expect(await loadConfig(files, log)).toEqual({});
        expect(warnings).toHaveLength(1);
      }
    });

    // readJsConfig loads through a dynamic `import()`, which (unlike the
    // `createRequire` this used before) natively supports a module that
    // awaits something before its `export default` runs.
    test("a module using top-level await loads normally", async () => {
      fs.writeFileSync(
        jsFile,
        'await Promise.resolve();\nexport default { llm_usage_url: "http://127.0.0.1:1/u" };',
      );
      const config = await loadConfig(files, log);
      expect(config.llm_usage_url).toBe("http://127.0.0.1:1/u");
      expect(warnings).toEqual([]);
    });

    // The default export itself may be a `Promise` of the config object, not
    // just a value produced after some top-level await — both are ordinary
    // outcomes of evaluating an ES module.
    test("a Promise default export is awaited and validated", async () => {
      fs.writeFileSync(
        jsFile,
        'export default Promise.resolve({ llm_usage_url: "http://127.0.0.1:1/p" });',
      );
      const config = await loadConfig(files, log);
      expect(config.llm_usage_url).toBe("http://127.0.0.1:1/p");
      expect(warnings).toEqual([]);
    });

    // A rejected default export is user-editable garbage exactly like a
    // thrown module body: warn once, degrade to empty, never crash startup.
    test("a rejected default export returns an empty config with one warning", async () => {
      fs.writeFileSync(jsFile, 'export default Promise.reject(new Error("boom"));');
      expect(await loadConfig(files, log)).toEqual({});
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("boom");
    });

    // A Promise that resolves to something other than an object degrades the
    // same way a synchronous non-object default export does.
    test("a Promise default export resolving to a non-object degrades with a warning", async () => {
      fs.writeFileSync(jsFile, "export default Promise.resolve(42);");
      expect(await loadConfig(files, log)).toEqual({});
      expect(warnings).toHaveLength(1);
    });

    test("a module without an object default export returns an empty config", async () => {
      for (const source of ["export const a = 1;", "export default 42;"]) {
        jsFile = path.join(dir, `nodefault-${source.length}.js`);
        files = { config: file, configJs: jsFile, configTs: tsFile };
        fs.writeFileSync(jsFile, source);
        warnings = [];
        expect(await loadConfig(files, log)).toEqual({});
        expect(warnings).toHaveLength(1);
      }
    });
  });

  describe("config.ts", () => {
    // Type annotations on the default export are the only reason to prefer
    // this over config.js; the accepted shape (and every degrade rule) is
    // identical, so the coverage here is precedence-focused rather than a
    // full re-run of the config.js cases.
    test("type annotations are stripped and the default export is used", async () => {
      fs.writeFileSync(
        tsFile,
        [
          "interface Shape { root_dirs: string[] }",
          "const launcher: Shape = { root_dirs: [" + JSON.stringify(dir) + "] };",
          "export default {",
          "  session_launcher: {",
          "    ...launcher,",
          "    templates: [{ name: 'typed', command: 'echo $CWD', params: { CWD: '' } }],",
          "  },",
          "};",
        ].join("\n"),
      );
      const config = await loadConfig(files, log);
      expect(config.session_launcher?.root_dirs).toEqual([dir]);
      expect(warnings).toEqual([]);
    });

    // config.ts outranks both older forms — a partial migration should not
    // leave the reader guessing which file is live.
    test("config.ts wins over config.js and config.json, naming both as ignored", async () => {
      fs.writeFileSync(tsFile, 'export default { terminal_gateway_url: "http://ts.example/" };');
      fs.writeFileSync(jsFile, 'export default { terminal_gateway_url: "http://js.example/" };');
      fs.writeFileSync(file, JSON.stringify({ terminal_gateway_url: "http://json.example/" }));
      expect((await loadConfig(files, log)).terminal_gateway_url).toBe("http://ts.example/");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("config.js");
      expect(warnings[0]).toContain("config.json");
    });

    test("config.ts wins over config.js alone", async () => {
      fs.writeFileSync(tsFile, 'export default { terminal_gateway_url: "http://ts.example/" };');
      fs.writeFileSync(jsFile, 'export default { terminal_gateway_url: "http://js.example/" };');
      expect((await loadConfig(files, log)).terminal_gateway_url).toBe("http://ts.example/");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("config.js");
    });

    // A broken .ts degrades exactly like a broken .js — evaluation goes
    // through the same readJsConfig path.
    test("a .ts module that throws returns an empty config with one warning", async () => {
      fs.writeFileSync(tsFile, 'throw new Error("boom");');
      expect(await loadConfig(files, log)).toEqual({});
      expect(warnings).toHaveLength(1);
    });

    // Top-level await and a Promise default export are the same ordinary ESM
    // outcomes for a .ts module as they are for a .js one — type annotations
    // are the only thing that's different about this file.
    test("top-level await and a typed Promise default export both work", async () => {
      fs.writeFileSync(
        tsFile,
        [
          "interface Shape { terminal_gateway_url: string }",
          "await Promise.resolve();",
          'const cfg: Promise<Shape> = Promise.resolve({ terminal_gateway_url: "http://ts.example/" });',
          "export default cfg;",
        ].join("\n"),
      );
      expect((await loadConfig(files, log)).terminal_gateway_url).toBe("http://ts.example/");
      expect(warnings).toEqual([]);
    });
  });
});

describe("writeConfigTypesFile", () => {
  let dir: string;
  let warnings: string[];
  const log = { warn: (msg: string) => warnings.push(msg) };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-config-dts-"));
    warnings = [];
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // The daemon regenerates this file every startup rather than trusting a
  // stale copy: it must reflect the version currently running, not whatever
  // ran last.
  test("writes a re-export naming CcmsgConfig and the requesting version", async () => {
    writeConfigTypesFile(dir, "1.2.3", log);
    const target = path.join(dir, CONFIG_TYPES_BASENAME);
    expect(fs.existsSync(target)).toBe(true);
    const content = fs.readFileSync(target, "utf8");
    expect(content).toContain("ccmsg v1.2.3");
    expect(content).toContain("CcmsgConfig");
    expect(content).toContain("Do NOT edit");
    expect(warnings).toEqual([]);
  });

  // The re-export points at this daemon's own module — an absolute path to a
  // file that actually exists on disk right now — which is the whole reason
  // it never drifts from the type the daemon really validates against.
  test("the re-export's source path exists on disk", async () => {
    writeConfigTypesFile(dir, "1.2.3", log);
    const content = fs.readFileSync(path.join(dir, CONFIG_TYPES_BASENAME), "utf8");
    const match = content.match(/^export type \{ CcmsgConfig \} from "([^"]+)";$/m);
    expect(match).not.toBeNull();
    expect(fs.existsSync(match![1]!)).toBe(true);
  });

  test("a second call overwrites the first with the new version", async () => {
    writeConfigTypesFile(dir, "1.0.0", log);
    writeConfigTypesFile(dir, "2.0.0", log);
    const content = fs.readFileSync(path.join(dir, CONFIG_TYPES_BASENAME), "utf8");
    expect(content).toContain("ccmsg v2.0.0");
    expect(content).not.toContain("ccmsg v1.0.0");
  });

  // configDir may not exist yet on a fresh install (loadConfig itself never
  // creates it); this write must not depend on some earlier step having done so.
  test("creates configDir if it does not exist yet", async () => {
    const fresh = path.join(dir, "nested", "config");
    writeConfigTypesFile(fresh, "1.2.3", log);
    expect(fs.existsSync(path.join(fresh, CONFIG_TYPES_BASENAME))).toBe(true);
  });

  // Startup must never fail just because the type-declaration file couldn't
  // be written — it is a convenience for editors, not a config the daemon reads.
  test("an unwritable configDir warns instead of throwing", async () => {
    const blocked = path.join(dir, "not-a-dir");
    fs.writeFileSync(blocked, "");
    expect(() => writeConfigTypesFile(path.join(blocked, "deeper"), "1.2.3", log)).not.toThrow();
    expect(warnings).toHaveLength(1);
  });
});
