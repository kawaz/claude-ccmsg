// PATH に置く launcher (packages/cli/path-launcher.sh) と、それを置く
// `just install-launcher` の契約を、実物の sh / just を走らせて検証する。
//
// launcher の仕事は「Claude Code が今 install している ccmsg-v1 の版の bin/ccmsg に
// exec する」ことだけ。launchd のように plugin cache が PATH に乗らない所から
// `ccmsg` を呼べるようにするためのもので、plugin の update で版ディレクトリが
// 変わっても PATH 側に何もしなくて済むことが要件 (DR-0032 §2.2-4)。
//
// 何を保証するか:
//   - 版は `<config dir>/plugins/installed_plugins.json` の
//     `plugins["ccmsg-v1@ccmsg-v1"]` の user scope の `installPath` で決まる。cache に
//     並ぶ版ディレクトリの名前は見ない (名前から版を読むのは marketplace / plugin の
//     改名で黙って壊れ、update 前の古い版も cache に残るため)
//   - config dir は CLAUDE_CONFIG_DIR、未設定 (空を含む) なら Claude Code の既定の
//     `~/.claude`。CLI と daemon が config dir を決める規則と同じにして、launcher が
//     選んだ版と CLI が話す config dir がずれないようにする
//   - 引数・終了コード・stdout は委譲先のものがそのまま届く (exec で置き換わる)
//   - 委譲先を決められない時は、原因と対処を 1 行で stderr に出して exit 1。
//     委譲先を起動しない
//   - install-launcher は copy で置き、launcher 以外の物 (symlink を含む) を上書きしない
//
// launcher は `/bin/sh <path>` で走らせる。直接 exec すると、macOS は新しい inode の
// 初回 exec を Gatekeeper の評価で待たせる (packages/testkit/src/mock-bin.ts)。sh に
// データとして渡す形はその対象外で、Linux の /bin/sh (dash) で走ることも POSIX sh で
// 書かれていることの確認になる。
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { jsonText, parseWith } from "@ccmsg/protocol";
import * as v from "valibot";
import { writeMockBin } from "../../testkit/src/mock-bin.ts";

const LAUNCHER = fileURLToPath(new URL("../path-launcher.sh", import.meta.url));
const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const PLUGIN = "ccmsg-v1@ccmsg-v1";

/** The directory jq is in, for a PATH that has it and little else. */
function jqDir(): string {
  const jq = Bun.which("jq");
  if (jq === null) throw new Error("jq is not on PATH; the launcher needs it");
  return path.dirname(jq);
}

interface Fixture {
  base: string;
  home: string;
  /** A config dir with a `plugins/` dir and nothing recorded yet. */
  configDir: string;
  cleanup: () => void;
}

function makeFixture(): Fixture {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-path-launcher-"));
  const home = path.join(base, "home");
  const configDir = path.join(base, "config");
  fs.mkdirSync(home);
  fs.mkdirSync(path.join(configDir, "plugins"), { recursive: true });
  return {
    base,
    home,
    configDir,
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  };
}

/** A version directory in `configDir`'s plugin cache whose `bin/ccmsg` prints
 * which version it is, then its arguments one per line, and exits 7 — a code
 * the launcher itself never uses, so seeing it proves the exec happened. */
function cachedVersion(configDir: string, version: string): string {
  const root = path.join(configDir, "plugins", "cache", "ccmsg-v1", "ccmsg-v1", version);
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  writeMockBin(
    path.join(root, "bin", "ccmsg"),
    `#!/bin/sh\nprintf 'version=%s\\n' ${version}\nfor a in "$@"; do printf 'arg=%s\\n' "$a"; done\nexit 7\n`,
  );
  return root;
}

/** Write `configDir`'s plugin record with `entries` as the ccmsg-v1 installs. */
function record(configDir: string, entries: object[], others: Record<string, object[]> = {}): void {
  fs.writeFileSync(
    path.join(configDir, "plugins", "installed_plugins.json"),
    JSON.stringify({ version: 2, plugins: { ...others, [PLUGIN]: entries } }, null, 2),
  );
}

function userInstall(installPath: string, version: string): object {
  return {
    scope: "user",
    installPath,
    version,
    installedAt: "2026-10-28T00:00:00.000Z",
    lastUpdated: "2026-10-28T00:00:00.000Z",
  };
}

interface Run {
  code: number;
  out: string;
  err: string;
}

/** Run the launcher with exactly `env` (plus a PATH that has jq unless `env`
 * names one), HOME pointed into the fixture. */
function launch(f: Fixture, args: string[], env: Record<string, string> = {}): Run {
  const proc = Bun.spawnSync({
    cmd: ["/bin/sh", LAUNCHER, ...args],
    env: { HOME: f.home, PATH: `${jqDir()}:/usr/bin:/bin`, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: proc.exitCode ?? -1,
    out: proc.stdout.toString(),
    err: proc.stderr.toString(),
  };
}

describe("PATH launcher: 委譲先の版", () => {
  test("record の user scope の installPath の bin/ccmsg に exec し、引数・stdout・終了コードがそのまま届く", () => {
    // 空白を含む引数と空の引数も 1 つずつ届くこと: "$@" で渡しているかの境界。
    const f = makeFixture();
    try {
      const root = cachedVersion(f.configDir, "0.2.0");
      record(f.configDir, [userInstall(root, "0.2.0")]);
      const r = launch(f, ["agents", "a b", ""], { CLAUDE_CONFIG_DIR: f.configDir });
      expect(r).toEqual({
        code: 7,
        out: "version=0.2.0\narg=agents\narg=a b\narg=\n",
        err: "",
      });
    } finally {
      f.cleanup();
    }
  });

  test("cache に新しい版が並んでいても、record が指す版を選ぶ", () => {
    // update 前の版や downgrade で、cache の最大の版と install 中の版は一致しない。
    // 版を決めるのは Claude Code の record で、ディレクトリ名の比較ではない。
    const f = makeFixture();
    try {
      const old = cachedVersion(f.configDir, "0.1.9");
      cachedVersion(f.configDir, "0.10.0");
      record(f.configDir, [userInstall(old, "0.1.9")]);
      const r = launch(f, [], { CLAUDE_CONFIG_DIR: f.configDir });
      expect(r.out).toBe("version=0.1.9\n");
    } finally {
      f.cleanup();
    }
  });

  test("project scope の install は選ばない (PATH から呼ぶ launcher にはどの project の物かが無い)", () => {
    // project / local scope の install は特定の project の中の claude が使うもので、
    // launchd から呼ばれる launcher はどの project にも居ない。user scope だけを見る。
    const f = makeFixture();
    try {
      const projectRoot = cachedVersion(f.configDir, "0.3.0");
      const userRoot = cachedVersion(f.configDir, "0.2.0");
      record(f.configDir, [
        { scope: "project", projectPath: "/somewhere", installPath: projectRoot, version: "0.3.0" },
        userInstall(userRoot, "0.2.0"),
      ]);
      expect(launch(f, [], { CLAUDE_CONFIG_DIR: f.configDir }).out).toBe("version=0.2.0\n");
    } finally {
      f.cleanup();
    }
  });
});

describe("PATH launcher: config dir", () => {
  // CLI (`hello` の config_dir) と daemon (default-effort.ts の claudeConfigDir) は
  // CLAUDE_CONFIG_DIR、未設定か空なら ~/.claude を使う。launcher も同じ規則でないと、
  // launcher が選んだ版と、その CLI が自分の config dir と思う所がずれる。
  // ~/.claude* を探し回って別の config dir を選ぶことはしない。
  for (const [label, env] of [
    ["未設定", {}],
    ["空", { CLAUDE_CONFIG_DIR: "" }],
  ] as const) {
    test(`CLAUDE_CONFIG_DIR が${label}なら ~/.claude の record を読む`, () => {
      const f = makeFixture();
      try {
        const configDir = path.join(f.home, ".claude");
        fs.mkdirSync(path.join(configDir, "plugins"), { recursive: true });
        record(configDir, [userInstall(cachedVersion(configDir, "0.4.0"), "0.4.0")]);
        // 別の config dir に新しい版があっても、そちらへは行かない。
        const other = path.join(f.home, ".claude-other");
        fs.mkdirSync(path.join(other, "plugins"), { recursive: true });
        record(other, [userInstall(cachedVersion(other, "0.9.0"), "0.9.0")]);
        expect(launch(f, [], env).out).toBe("version=0.4.0\n");
      } finally {
        f.cleanup();
      }
    });
  }
});

describe("PATH launcher: 委譲先を決められない時", () => {
  // どの場合も exit 1 で、stderr は `ccmsg: ` で始まる 1 行 (原因: 対処)。stdout には
  // 何も出さない (launchd のスクリプトが stdout を読む前提で、壊れた出力を渡さない)。
  // exit 1 は委譲先 (このテストの偽物は 7) と区別できる。
  function expectRefusal(r: Run, ...parts: string[]): void {
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err.startsWith("ccmsg: ")).toBe(true);
    expect(r.err.endsWith("\n")).toBe(true);
    expect(r.err.trimEnd().includes("\n")).toBe(false);
    for (const part of parts) expect(r.err).toContain(part);
  }

  test("record が無い: CLAUDE_CONFIG_DIR を設定するよう言う", () => {
    // kawaz の環境のように ~/.claude が config dir でない (CLAUDE_CONFIG_DIR を常に
    // 指定する) 所で、環境変数を引き継がない launchd から呼ばれた時に踏む。
    const f = makeFixture();
    try {
      fs.writeFileSync(path.join(f.home, ".claude"), "");
      expectRefusal(
        launch(f, ["status"]),
        path.join(f.home, ".claude", "plugins", "installed_plugins.json"),
        "set CLAUDE_CONFIG_DIR",
      );
    } finally {
      f.cleanup();
    }
  });

  test("record に ccmsg-v1 の user scope の install が無い: install の command を示す", () => {
    const f = makeFixture();
    try {
      record(f.configDir, [], { "other@other": [userInstall("/x", "1.0.0")] });
      expectRefusal(
        launch(f, [], { CLAUDE_CONFIG_DIR: f.configDir }),
        `${PLUGIN} is not installed in ${f.configDir}`,
        `claude plugin install ${PLUGIN}`,
      );
    } finally {
      f.cleanup();
    }
  });

  test("installPath に bin/ccmsg が無い (cache が消えた): 再 install を示す", () => {
    const f = makeFixture();
    try {
      const gone = path.join(f.configDir, "plugins", "cache", "ccmsg-v1", "ccmsg-v1", "0.5.0");
      record(f.configDir, [userInstall(gone, "0.5.0")]);
      expectRefusal(
        launch(f, [], { CLAUDE_CONFIG_DIR: f.configDir }),
        `${gone}/bin/ccmsg not found`,
        `claude plugin install ${PLUGIN}`,
      );
    } finally {
      f.cleanup();
    }
  });

  test("record が JSON でない / record の形でない: ファイルを見るよう言う", () => {
    // 書きかけや壊れた record を「install されていない」と取り違えない。
    for (const text of ["{ not json", "[]", '{"plugins": {"ccmsg-v1@ccmsg-v1": [1]}}']) {
      const f = makeFixture();
      try {
        fs.writeFileSync(path.join(f.configDir, "plugins", "installed_plugins.json"), text);
        expectRefusal(
          launch(f, [], { CLAUDE_CONFIG_DIR: f.configDir }),
          "does not read as Claude Code's plugin record",
        );
      } finally {
        f.cleanup();
      }
    }
  });

  test("jq が PATH に無い: jq を入れるよう言う", () => {
    // record は jq で読む (POSIX sh だけで JSON を正しく読む手段が無いため)。macOS は
    // /usr/bin/jq を持つが、Linux では入っていないことがある。
    const f = makeFixture();
    try {
      record(f.configDir, [userInstall(cachedVersion(f.configDir, "0.2.0"), "0.2.0")]);
      const empty = path.join(f.base, "empty-path");
      fs.mkdirSync(empty);
      expectRefusal(launch(f, [], { CLAUDE_CONFIG_DIR: f.configDir, PATH: empty }), "jq not found");
    } finally {
      f.cleanup();
    }
  });
});

describe("PATH launcher: plugin の名前", () => {
  test("launcher が引く record の key は、この plugin の `<plugin.json の name>@<marketplace.json の name>`", () => {
    // launcher は PATH に copy されて repo から切り離されるので、key を埋め込んでいる。
    // plugin か marketplace を改名したらこの test が落ち、launcher の追従漏れを知らせる
    // (追従しないと、launcher は改名後の install を「install されていない」と言う)。
    const NamedSchema = jsonText(v.looseObject({ name: v.string() }));
    const nameIn = (file: string): string => {
      const read = parseWith(NamedSchema, fs.readFileSync(path.join(REPO, file), "utf8"));
      if (!read.ok) throw new Error(`${file}: ${read.failure.summary}`);
      return read.value.name;
    };
    const key = `${nameIn(".claude-plugin/plugin.json")}@${nameIn(".claude-plugin/marketplace.json")}`;
    expect(fs.readFileSync(LAUNCHER, "utf8")).toContain(`\nplugin=${key}\n`);
  });
});

describe("just install-launcher", () => {
  // dest に launcher を copy で置く。symlink にしないのは、launcher が版を毎回 record から
  // 引くので plugin cache を指す理由が無く、cache の版ディレクトリは update で消えるから。
  // dest に既にある物は、launcher の (古い) copy なら置き換え、それ以外は上書きせず止める。
  // launcher の copy かどうかは 2 行目の目印の行で見る。
  function install(dest: string): Run {
    const proc = Bun.spawnSync({
      cmd: ["just", "--justfile", path.join(REPO, "justfile"), "install-launcher", dest],
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      code: proc.exitCode ?? -1,
      out: proc.stdout.toString(),
      err: proc.stderr.toString(),
    };
  }
  const launcherText = (): string => fs.readFileSync(LAUNCHER, "utf8");

  test("無い dest には launcher と同じ中身の実行可能な通常ファイルを置き (dir も作る)、2 回目は何もしない", () => {
    const f = makeFixture();
    try {
      const dest = path.join(f.home, ".local", "bin", "ccmsg");
      expect(install(dest).code).toBe(0);
      const st = fs.lstatSync(dest);
      expect(st.isFile()).toBe(true);
      expect(st.mode & 0o777).toBe(0o755);
      expect(fs.readFileSync(dest, "utf8")).toBe(launcherText());
      const again = install(dest);
      expect(again.code).toBe(0);
      expect(again.out).toContain("up to date");
    } finally {
      f.cleanup();
    }
  });

  test("launcher の古い copy は置き換える", () => {
    const f = makeFixture();
    try {
      const dest = path.join(f.base, "ccmsg");
      const [shebang, marker] = launcherText().split("\n");
      fs.writeFileSync(dest, `${shebang}\n${marker}\necho old\n`);
      expect(install(dest).code).toBe(0);
      expect(fs.readFileSync(dest, "utf8")).toBe(launcherText());
    } finally {
      f.cleanup();
    }
  });

  test("launcher でない物は、通常ファイルも symlink も上書きせず exit 1", () => {
    // 利用者が自分で置いた wrapper や、plugin cache の bin/ccmsg への手張りの symlink を
    // 黙って壊さない。どかすのは利用者の判断。
    const f = makeFixture();
    try {
      const file = path.join(f.base, "file");
      fs.writeFileSync(file, "#!/bin/sh\necho mine\n");
      const r = install(file);
      expect(r.code).toBe(1);
      expect(r.err).toContain("is not the ccmsg launcher");
      expect(fs.readFileSync(file, "utf8")).toBe("#!/bin/sh\necho mine\n");

      // 指す先が launcher そのものでも symlink は置き換えない: 指す先が消えれば切れる。
      const link = path.join(f.base, "link");
      fs.symlinkSync(LAUNCHER, link);
      expect(install(link).code).toBe(1);
      expect(fs.readlinkSync(link)).toBe(LAUNCHER);
    } finally {
      f.cleanup();
    }
  });
});
