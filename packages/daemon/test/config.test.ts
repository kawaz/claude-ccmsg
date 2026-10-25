// Daemon configuration reading (DR-0018 §3.1, DR-0038 §6): the whole file is
// read by one schema, and a file that does not read is answered with every
// reason (file, place, what was expected) so the daemon stops at startup.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_DIR_TREE_DEPTH, DEFAULT_LAUNCH_TIMEOUT_SECONDS } from "@ccmsg/protocol";
import {
  CONFIG_TYPES_BASENAME,
  loadConfig,
  type ResolvedCcmsgConfig,
  writeConfigTypesFile,
} from "../src/config.ts";

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

  /** The configuration the files read as, failing the test when they do not
   * read. */
  async function loaded(): Promise<ResolvedCcmsgConfig> {
    const read = await loadConfig(files, log);
    if (!read.ok) throw new Error(read.errors.join("\n"));
    return read.config;
  }

  /** Why the files do not read, failing the test when they do. */
  async function refusal(): Promise<readonly string[]> {
    const read = await loadConfig(files, log);
    if (read.ok) throw new Error(`the configuration read: ${JSON.stringify(read.config)}`);
    return read.errors;
  }

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
    expect(await loaded()).toEqual({});
    expect(warnings).toEqual([]);
  });

  // Broken JSON is not a configuration: the daemon does not start, and the
  // reason names the file.
  test("broken JSON does not read", async () => {
    fs.writeFileSync(file, "{not-json");
    expect(await refusal()).toEqual([expect.stringContaining(file)]);
  });

  // The top-level contract is a JSON object. Scalars and arrays cannot contain
  // daemon keys, so they do not read.
  test("non-object JSON values do not read", async () => {
    for (const value of ["null", "42", "[]"]) {
      fs.writeFileSync(file, value);
      expect(await refusal()).toHaveLength(1);
    }
  });

  /** `session_launcher` with the two required keys and `extra`. */
  function launcher(extra: object = {}): object {
    return { session_launcher: { launch_command: ["launch"], root_dirs: [dir], ...extra } };
  }

  // This is the complete accepted shape: every configured field survives while
  // root paths are normalized before they become containment boundaries.
  test("complete session_launcher parses every field", async () => {
    const root = path.join(dir, "root", "..");
    fs.writeFileSync(
      file,
      JSON.stringify({
        session_launcher: {
          launch_command: ["/opt/bin/launch-claude", "--profile", "work"],
          root_dirs: [root],
          dir_tree_depth: 3,
          timeout_seconds: 25,
          clean_env: ["CLAUDE_*", "AI_AGENT"],
          keep_env: ["CLAUDE_CONFIG_DIR"],
        },
      }),
    );

    expect(await loaded()).toEqual({
      session_launcher: {
        launch_command: ["/opt/bin/launch-claude", "--profile", "work"],
        root_dirs: [path.resolve(root)],
        dir_tree_depth: 3,
        timeout_seconds: 25,
        clean_env: ["CLAUDE_*", "AI_AGENT"],
        keep_env: ["CLAUDE_CONFIG_DIR"],
      },
    });
    expect(warnings).toEqual([]);
  });

  // The schema gives the defaults of a field left out, and only then.
  test("absent optional fields take their defaults without warning", async () => {
    fs.writeFileSync(file, JSON.stringify(launcher()));
    expect(await loaded()).toEqual({
      session_launcher: {
        launch_command: ["launch"],
        root_dirs: [path.resolve(dir)],
        dir_tree_depth: DEFAULT_DIR_TREE_DEPTH,
        timeout_seconds: DEFAULT_LAUNCH_TIMEOUT_SECONDS,
        clean_env: [],
        keep_env: [],
      },
    });
    expect(warnings).toEqual([]);
  });

  // The program is a path the daemon can find from any launch's cwd: an
  // absolute one, a ~/ one (expanded against the daemon user's home), or a
  // name looked up in PATH.
  test("the program is absolute, ~/-expanded, or a bare name", async () => {
    for (const [program, read] of [
      ["/usr/local/bin/launch", "/usr/local/bin/launch"],
      ["~/bin/launch", path.join(os.homedir(), "bin", "launch")],
      ["launch-claude", "launch-claude"],
    ] as const) {
      fs.writeFileSync(file, JSON.stringify(launcher({ launch_command: [program, "~/arg"] })));
      // Only the program is a path; the arguments are passed as written.
      expect((await loaded()).session_launcher?.launch_command).toEqual([read, "~/arg"]);
    }
  });

  // A relative path would resolve against each launch's cwd.
  test("a relative program path does not read", async () => {
    fs.writeFileSync(file, JSON.stringify(launcher({ launch_command: ["bin/launch"] })));
    expect(await refusal()).toEqual([
      expect.stringContaining(
        "session_launcher.launch_command.0: must be an absolute path, start with ~/, or be a command name looked up in PATH",
      ),
    ]);
  });

  test("a missing, empty, or non-array launch_command does not read", async () => {
    for (const launch_command of [undefined, [], "launch", [""], ["launch", ""], ["launch", 1]]) {
      fs.writeFileSync(
        file,
        JSON.stringify({
          session_launcher: {
            root_dirs: [dir],
            ...(launch_command === undefined ? {} : { launch_command }),
          },
        }),
      );
      expect(await refusal()).toEqual([expect.stringContaining("session_launcher.launch_command")]);
    }
  });

  // A launcher of another shape (templates of shell snippets, a shell) is
  // not a launcher with parts missing: it does not read, naming what is
  // unknown and what is missing, and the daemon does not start.
  test("a launcher with templates and a shell does not read", async () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        session_launcher: {
          root_dirs: [dir],
          shell: "bash",
          templates: [{ name: "default", command: "run", params: { CWD: "" } }],
        },
      }),
    );
    // The first key it does not know is named (here `shell`, before
    // `templates`).
    expect(await refusal()).toEqual([
      `config: ${file}: session_launcher.launch_command: Invalid key: Expected "launch_command" but received undefined`,
      `config: ${file}: session_launcher.shell: Invalid key: Expected never but received "shell"`,
    ]);
  });

  test("an unknown key beside launch_command does not read", async () => {
    fs.writeFileSync(file, JSON.stringify(launcher({ command: "launch" })));
    expect(await refusal()).toEqual([expect.stringContaining("session_launcher.command")]);
  });

  // DR-0018's user-facing examples use ~/..., so the parser expands it against
  // the daemon user's actual home before absolute-path normalization.
  test("a ~/ root expands to the daemon user's home", async () => {
    fs.writeFileSync(file, JSON.stringify(launcher({ root_dirs: ["~/launcher-root"] })));
    expect((await loaded()).session_launcher?.root_dirs).toEqual([
      path.join(os.homedir(), "launcher-root"),
    ]);
  });

  test("missing, empty, or non-array root_dirs does not read", async () => {
    for (const root_dirs of [undefined, [], "not-an-array"]) {
      fs.writeFileSync(
        file,
        JSON.stringify({
          session_launcher: {
            launch_command: ["launch"],
            ...(root_dirs === undefined ? {} : { root_dirs }),
          },
        }),
      );
      expect(await refusal()).toEqual([expect.stringContaining("session_launcher.root_dirs")]);
    }
  });

  // A relative root is not a containment boundary; it does not read, with the
  // entry named.
  test("a relative root entry does not read", async () => {
    fs.writeFileSync(file, JSON.stringify(launcher({ root_dirs: ["relative/root", dir] })));
    expect(await refusal()).toEqual([
      expect.stringContaining("session_launcher.root_dirs.0: must be absolute or start with ~/"),
    ]);
  });

  // timeout_seconds is a whole number of seconds from 1 to 50: the launch
  // tool waits 60 s, which has to hold the timeout, the kill grace and the
  // output files. A value outside does not read rather than being replaced.
  test("timeout_seconds outside 1..50 or not whole does not read", async () => {
    for (const ok of [1, 50]) {
      fs.writeFileSync(file, JSON.stringify(launcher({ timeout_seconds: ok })));
      expect((await loaded()).session_launcher?.timeout_seconds).toBe(ok);
    }
    for (const invalid of ["abc", 0, 51, 1.5, -1]) {
      fs.writeFileSync(file, JSON.stringify(launcher({ timeout_seconds: invalid })));
      expect(await refusal()).toEqual([
        expect.stringContaining("session_launcher.timeout_seconds"),
      ]);
    }
  });

  test("a dir_tree_depth that is not a positive number does not read", async () => {
    for (const invalid of ["abc", -1, 0]) {
      fs.writeFileSync(file, JSON.stringify(launcher({ dir_tree_depth: invalid })));
      expect(await refusal()).toEqual([expect.stringContaining("session_launcher.dir_tree_depth")]);
    }
  });

  for (const key of ["clean_env", "keep_env"] as const) {
    test(`non-array ${key} does not read`, async () => {
      fs.writeFileSync(file, JSON.stringify(launcher({ [key]: "CLAUDE_*" })));
      expect(await refusal()).toEqual([expect.stringContaining(`session_launcher.${key}`)]);
    });

    test(`empty or non-string ${key} entries do not read, each reported`, async () => {
      fs.writeFileSync(file, JSON.stringify(launcher({ [key]: ["CLAUDE_*", "", 42, "AI_AGENT"] })));
      const errors = await refusal();
      expect(errors).toHaveLength(2);
      expect(errors[0]).toContain(`session_launcher.${key}.1`);
      expect(errors[1]).toContain(`session_launcher.${key}.2`);
    });
  }

  // terminal_gateway_url (issue 2026-07-21-webui-terminal-tab-embed):
  // 独立トップレベルキー。session_launcher の有無とは無関係にパースする。
  describe("terminal_gateway_url", () => {
    test("valid https URL is retained", async () => {
      fs.writeFileSync(file, JSON.stringify({ terminal_gateway_url: "https://gw.example" }));
      expect((await loaded()).terminal_gateway_url).toBe("https://gw.example");
      expect(warnings).toEqual([]);
    });

    test("valid http URL with port is retained", async () => {
      fs.writeFileSync(file, JSON.stringify({ terminal_gateway_url: "http://127.0.0.1:43690" }));
      expect((await loaded()).terminal_gateway_url).toBe("http://127.0.0.1:43690");
    });

    test("whitespace is trimmed", async () => {
      fs.writeFileSync(file, JSON.stringify({ terminal_gateway_url: "  https://gw.example  " }));
      expect((await loaded()).terminal_gateway_url).toBe("https://gw.example");
    });

    test("non-string / empty value does not read", async () => {
      for (const value of [42, "", "   ", null]) {
        fs.writeFileSync(file, JSON.stringify({ terminal_gateway_url: value }));
        expect(await refusal()).toEqual([expect.stringContaining("terminal_gateway_url")]);
      }
    });

    test("unparseable URL does not read", async () => {
      fs.writeFileSync(file, JSON.stringify({ terminal_gateway_url: "not a url" }));
      expect(await refusal()).toEqual([
        expect.stringContaining("terminal_gateway_url: must be an absolute URL"),
      ]);
    });

    test("non-http scheme is rejected (ftp / javascript / file)", async () => {
      for (const value of ["ftp://gw.example", "javascript:alert(1)", "file:///etc/passwd"]) {
        fs.writeFileSync(file, JSON.stringify({ terminal_gateway_url: value }));
        expect(await refusal()).toEqual([
          expect.stringContaining("terminal_gateway_url: must be http:// or https://"),
        ]);
      }
    });

    test("coexists with session_launcher", async () => {
      fs.writeFileSync(
        file,
        JSON.stringify({
          session_launcher: { launch_command: ["launch"], root_dirs: [dir] },
          terminal_gateway_url: "https://gw.example",
        }),
      );
      const cfg = await loaded();
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
      expect((await loaded()).llm_usage_url).toBe("https://gw.example/usage");
      expect(warnings).toEqual([]);
    });

    test("whitespace is trimmed", async () => {
      fs.writeFileSync(file, JSON.stringify({ llm_usage_url: "  http://127.0.0.1:8080/usage  " }));
      expect((await loaded()).llm_usage_url).toBe("http://127.0.0.1:8080/usage");
    });

    test("non-string / empty / unparseable / non-http does not read", async () => {
      for (const value of [42, "", "   ", null, "not a url", "file:///etc/passwd"]) {
        fs.writeFileSync(file, JSON.stringify({ llm_usage_url: value }));
        expect(await refusal()).toEqual([expect.stringContaining("llm_usage_url")]);
      }
    });

    // A typo in one URL key is reported by its own name, not as the other's.
    test("a malformed sibling URL key is reported by its own name", async () => {
      fs.writeFileSync(
        file,
        JSON.stringify({
          terminal_gateway_url: "not a url",
          llm_usage_url: "https://gw.example/usage",
        }),
      );
      expect(await refusal()).toEqual([expect.stringContaining("terminal_gateway_url")]);
    });
  });

  // llm_stats_url: the spend endpoint, configured independently of the quota
  // one — an operator can set up either without the other, and the webui shows
  // only the section whose endpoint exists.
  describe("llm_stats_url", () => {
    test("valid https URL is retained", async () => {
      fs.writeFileSync(file, JSON.stringify({ llm_stats_url: "https://gw.example/stats" }));
      expect((await loaded()).llm_stats_url).toBe("https://gw.example/stats");
      expect(warnings).toEqual([]);
    });

    // The operator's likely source is a URL they were reading in a browser,
    // which already carries a window; the query string has to survive the
    // config (the op overwrites just the `days` parameter).
    test("an existing query string is retained", async () => {
      fs.writeFileSync(file, JSON.stringify({ llm_stats_url: "https://gw.example/stats?days=30" }));
      expect((await loaded()).llm_stats_url).toBe("https://gw.example/stats?days=30");
    });

    test("non-string / empty / unparseable / non-http does not read", async () => {
      for (const value of [42, "", "   ", null, "not a url", "file:///etc/passwd"]) {
        fs.writeFileSync(file, JSON.stringify({ llm_stats_url: value }));
        expect(await refusal()).toEqual([expect.stringContaining("llm_stats_url")]);
      }
    });

    test("the two llm URL keys are reported by their own names", async () => {
      fs.writeFileSync(
        file,
        JSON.stringify({
          llm_usage_url: "not a url",
          llm_stats_url: "https://gw.example/stats",
        }),
      );
      expect(await refusal()).toEqual([expect.stringContaining("llm_usage_url")]);
    });
  });

  // llm_status_url: the upstream-service endpoint (gateway DR-0021), a third
  // independent key. Deliberately NOT derived from llm_usage_url: the three
  // endpoints are not guaranteed to sit on adjacent paths of one origin, and a
  // gateway old enough to serve usage may not serve status at all.
  describe("llm_status_url", () => {
    test("valid https URL is retained", async () => {
      fs.writeFileSync(file, JSON.stringify({ llm_status_url: "https://gw.example/status" }));
      expect((await loaded()).llm_status_url).toBe("https://gw.example/status");
      expect(warnings).toEqual([]);
    });

    test("non-string / empty / unparseable / non-http does not read", async () => {
      for (const value of [42, "", "   ", null, "not a url", "file:///etc/passwd"]) {
        fs.writeFileSync(file, JSON.stringify({ llm_status_url: value }));
        expect(await refusal()).toEqual([expect.stringContaining("llm_status_url")]);
      }
    });

    // Configuring usage says nothing about status: the capability the webui
    // reads has to come from this key alone.
    test("is unset when only the usage endpoint is configured", async () => {
      fs.writeFileSync(file, JSON.stringify({ llm_usage_url: "https://gw.example/usage" }));
      const cfg = await loaded();
      expect(cfg.llm_usage_url).toBe("https://gw.example/usage");
      expect(cfg.llm_status_url).toBeUndefined();
    });

    test("the three llm URL keys are reported by their own names", async () => {
      fs.writeFileSync(
        file,
        JSON.stringify({
          llm_usage_url: "not a url",
          llm_stats_url: "ftp://gw.example/stats",
          llm_status_url: "https://gw.example/status",
        }),
      );
      const errors = await refusal();
      expect(errors).toHaveLength(2);
      expect(errors[0]).toContain("llm_usage_url");
      expect(errors[1]).toContain("llm_stats_url");
    });
  });

  // llm_keepalive_pause_url: the gateway's keepalive pause endpoint, a fourth
  // independent key for the same reason as the three above.
  describe("llm_keepalive_pause_url", () => {
    test("valid https URL is retained", async () => {
      const url = "https://gw.example/llm-gateway/keepalive/pause";
      fs.writeFileSync(file, JSON.stringify({ llm_keepalive_pause_url: url }));
      expect((await loaded()).llm_keepalive_pause_url).toBe(url);
      expect(warnings).toEqual([]);
    });

    test("non-string / empty / non-http does not read", async () => {
      for (const value of [42, "", "file:///etc/passwd"]) {
        fs.writeFileSync(file, JSON.stringify({ llm_keepalive_pause_url: value }));
        expect(await refusal()).toEqual([expect.stringContaining("llm_keepalive_pause_url")]);
      }
    });
  });

  // A key the configuration does not have is a typo or a retired key: it does
  // not read, with its name, rather than doing nothing without a word.
  describe("unknown keys", () => {
    test("an unknown top-level key does not read", async () => {
      fs.writeFileSync(file, JSON.stringify({ llm_events_url: "http://127.0.0.1:8402/events" }));
      expect(await refusal()).toEqual([expect.stringContaining("llm_events_url")]);
    });

    test("an unknown key in session_launcher does not read", async () => {
      fs.writeFileSync(
        file,
        JSON.stringify({
          session_launcher: { launch_command: ["launch"], root_dirs: [dir], shel: "zsh" },
        }),
      );
      expect(await refusal()).toEqual([expect.stringContaining("session_launcher.shel")]);
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
      const cfg = await loaded();
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
      expect(Object.keys((await loaded()).webhooks ?? {}).sort()).toEqual([
        "llm-gateway",
        "some-other",
      ]);
    });

    test("a source name that could not be a path segment does not read", async () => {
      // The name selects a config entry from a URL path, so anything that
      // could express traversal or case tricks must not be accepted.
      for (const source of ["../etc", "Llm-Gateway", "llm gateway", "a".repeat(65), ""]) {
        fs.writeFileSync(file, JSON.stringify({ webhooks: { [source]: { token_file: "/t" } } }));
        expect(await refusal()).toEqual([expect.stringContaining("is not a source name")]);
      }
    });

    test("an entry without a usable token_file does not read, each reported", async () => {
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
      const errors = await refusal();
      expect(errors).toHaveLength(2);
      expect(errors[0]).toContain("webhooks.broken.token_file");
      expect(errors[1]).toContain("webhooks.also-broken.token_file");
    });

    test("a non-object webhooks value does not read", async () => {
      fs.writeFileSync(file, JSON.stringify({ webhooks: "llm-gateway" }));
      expect(await refusal()).toEqual([expect.stringContaining("webhooks")]);
    });
  });
  // `config.js` lets a module build values JSON can only spell out literally
  // (a multi-line string, a shared list). Everything past the file read
  // is shared with the JSON path, so these cases cover the choice of file and
  // the module-specific failures — not the field validation above.
  describe("config.js", () => {
    test("a module's default export is used and multi-line strings survive", async () => {
      fs.writeFileSync(
        jsFile,
        [
          "export default {",
          "  session_launcher: {",
          "    launch_command: ['launch', `line 1",
          "line 2`],",
          "    root_dirs: [" + JSON.stringify(dir) + "],",
          "  },",
          "};",
        ].join("\n"),
      );
      expect((await loaded()).session_launcher?.launch_command).toEqual([
        "launch",
        "line 1\nline 2",
      ]);
      expect(warnings).toEqual([]);
    });

    // Both files present is a half-finished migration, not a merge: the newer
    // form wins and the user is told which file stopped being read.
    test("config.js wins over config.json, with one warning naming both", async () => {
      fs.writeFileSync(jsFile, 'export default { terminal_gateway_url: "http://js.example/" };');
      fs.writeFileSync(file, JSON.stringify({ terminal_gateway_url: "http://json.example/" }));
      expect((await loaded()).terminal_gateway_url).toBe("http://js.example/");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("config.json");
    });

    // A module that cannot be evaluated is not a configuration, exactly like
    // broken JSON: the daemon does not start, and the reason names the file.
    test("a module that throws or fails to parse does not read", async () => {
      for (const [i, source] of ["export default { a: ;", 'throw new Error("boom");'].entries()) {
        // A fresh path per case: modules are cached by path once required.
        jsFile = path.join(dir, `broken-${i}.js`);
        files = { config: file, configJs: jsFile, configTs: tsFile };
        fs.writeFileSync(jsFile, source);
        expect(await refusal()).toEqual([expect.stringContaining("could not be loaded")]);
      }
    });

    // A module that does not parse says where, error by error: bun reports a
    // build with several errors as one error whose message only counts them,
    // and the person has to find the typo from what the daemon says.
    test("a module that fails to parse names the line, column and text of each error", async () => {
      const at = (line: number): RegExp =>
        new RegExp(
          `^config: ${RegExp.escape(tsFile)}:${String(line)}:\\d+: could not be loaded \\(.+\\): `,
        );
      fs.writeFileSync(tsFile, 'export default {\n  a: ["x"].join("\\n")."\\n", b: {},\n};\n');
      const several = await refusal();
      expect(several.length).toBeGreaterThan(1);
      for (const line of several) {
        expect(line).toMatch(at(2));
        expect(line.endsWith(': a: ["x"].join("\\n")."\\n", b: {},')).toBe(true);
      }

      tsFile = path.join(dir, "one-error.ts");
      files = { config: file, configJs: jsFile, configTs: tsFile };
      fs.writeFileSync(tsFile, "export default { a: ;\n");
      const one = await refusal();
      expect(one).toHaveLength(1);
      expect(one[0]).toMatch(at(1));
      expect(one[0]?.endsWith(": export default { a: ;")).toBe(true);
    });

    // readJsConfig loads through a dynamic `import()`, which (unlike the
    // `createRequire` this used before) natively supports a module that
    // awaits something before its `export default` runs.
    test("a module using top-level await loads normally", async () => {
      fs.writeFileSync(
        jsFile,
        'await Promise.resolve();\nexport default { llm_usage_url: "http://127.0.0.1:1/u" };',
      );
      const config = await loaded();
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
      const config = await loaded();
      expect(config.llm_usage_url).toBe("http://127.0.0.1:1/p");
      expect(warnings).toEqual([]);
    });

    test("a rejected default export does not read", async () => {
      fs.writeFileSync(jsFile, 'export default Promise.reject(new Error("boom"));');
      expect(await refusal()).toEqual([expect.stringContaining("boom")]);
    });

    // A Promise that resolves to something other than an object is refused the
    // same way a synchronous non-object default export is.
    test("a Promise default export resolving to a non-object does not read", async () => {
      fs.writeFileSync(jsFile, "export default Promise.resolve(42);");
      expect(await refusal()).toHaveLength(1);
    });

    test("a module without an object default export does not read", async () => {
      for (const source of ["export const a = 1;", "export default 42;"]) {
        jsFile = path.join(dir, `nodefault-${source.length}.js`);
        files = { config: file, configJs: jsFile, configTs: tsFile };
        fs.writeFileSync(jsFile, source);
        expect(await refusal()).toHaveLength(1);
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
          "    launch_command: ['launch'],",
          "  },",
          "};",
        ].join("\n"),
      );
      const config = await loaded();
      expect(config.session_launcher?.root_dirs).toEqual([dir]);
      expect(warnings).toEqual([]);
    });

    // config.ts outranks both older forms — a partial migration should not
    // leave the reader guessing which file is live.
    test("config.ts wins over config.js and config.json, naming both as ignored", async () => {
      fs.writeFileSync(tsFile, 'export default { terminal_gateway_url: "http://ts.example/" };');
      fs.writeFileSync(jsFile, 'export default { terminal_gateway_url: "http://js.example/" };');
      fs.writeFileSync(file, JSON.stringify({ terminal_gateway_url: "http://json.example/" }));
      expect((await loaded()).terminal_gateway_url).toBe("http://ts.example/");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("config.js");
      expect(warnings[0]).toContain("config.json");
    });

    test("config.ts wins over config.js alone", async () => {
      fs.writeFileSync(tsFile, 'export default { terminal_gateway_url: "http://ts.example/" };');
      fs.writeFileSync(jsFile, 'export default { terminal_gateway_url: "http://js.example/" };');
      expect((await loaded()).terminal_gateway_url).toBe("http://ts.example/");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("config.js");
    });

    // A broken .ts is refused exactly like a broken .js — evaluation goes
    // through the same readJsConfig path.
    test("a .ts module that throws does not read", async () => {
      fs.writeFileSync(tsFile, 'throw new Error("boom");');
      expect(await refusal()).toEqual([expect.stringContaining("boom")]);
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
      expect((await loaded()).terminal_gateway_url).toBe("http://ts.example/");
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
    expect(fs.existsSync(match?.[1] ?? "")).toBe(true);
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
