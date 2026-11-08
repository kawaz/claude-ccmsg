// 許可依頼の project_permissions (DR-0040 §12) の daemon 側の書き込みと通知。
//
// 何を保証するか (各 test の doc comment 参照):
//   - 書き込みは `.claude/settings.local.json` の permissions.allow だけを変え、
//     無いディレクトリ / ファイルは作り、他のキーは位置ごと保つ
//   - add は重複なく足し、remove は消す。書き戻しは allow を文字列順に並べ、
//     2 スペースのインデントの JSON にする。変わらない時は書かない
//   - 読めない JSON・形の違う permissions は書かずに理由を返す
//   - 同じファイルへの適用は 1 つずつ (並んだ 2 つが互いを消さない)
//   - 通知は最後の適用から 5 秒後に 1 通、最初の適用前 → 最後の適用後の
//     unified diff。行って戻った (差の無い) 連打は通知しない
//
// wire の op (記録に無い変更を断る等) は permit-project-permissions.test.ts。
import { afterEach, describe, expect, jest, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { perTestTmpDir } from "../../testkit/src/tmp.ts";
import {
  applyProjectPermission,
  createKeyedQueue,
  createSettingsDiffNotifier,
  projectSettingsPath,
  SETTINGS_DIFF_NOTICE_DELAY_MS,
  unifiedDiff,
} from "../src/project-permissions.ts";

const tmpDir = perTestTmpDir();

/** A project directory with no `.claude` yet, and its settings file's path. */
function project(): { dir: string; file: string } {
  const dir = tmpDir("perm-project-");
  return { dir, file: projectSettingsPath(dir) };
}

describe("applyProjectPermission", () => {
  // 何を保証するか: .claude も設定ファイルも無いプロジェクトに add すると、
  // ディレクトリごと作り、allow だけを持つ設定を 2 スペースのインデントで書く。
  test("creates the directory and the file when there is none", async () => {
    const { file } = project();
    const applied = await applyProjectPermission(file, { add: "Bash(just deploy)" });
    const written = `{\n  "permissions": {\n    "allow": [\n      "Bash(just deploy)"\n    ]\n  }\n}\n`;
    expect(applied).toEqual({ kind: "applied", changed: true, before: null, after: written });
    expect(fs.readFileSync(file, "utf8")).toBe(written);
  });

  // 何を保証するか: 他のキー (permissions の外も中も) は値も並びも保つ。allow
  // は文字列順に並べ直す (押した順にファイルが左右されない)。
  test("keeps every other key in its place, and sorts the rules", async () => {
    const { file } = project();
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(
      file,
      JSON.stringify({
        env: { A: "1" },
        permissions: { deny: ["Bash(rm)"], allow: ["Edit(/w/b)", "Bash(z)"], ask: [] },
        hooks: {},
      }),
    );
    const applied = await applyProjectPermission(file, { add: "Bash(a)" });
    expect(applied.kind === "applied" && applied.changed).toBe(true);
    const text = fs.readFileSync(file, "utf8");
    expect(text).toBe(
      `${JSON.stringify(
        {
          env: { A: "1" },
          permissions: {
            deny: ["Bash(rm)"],
            allow: ["Bash(a)", "Bash(z)", "Edit(/w/b)"],
            ask: [],
          },
          hooks: {},
        },
        null,
        2,
      )}\n`,
    );
  });

  // 何を保証するか: permissions が無い設定には末尾に足し、allow が無い
  // permissions には allow を足す。
  test("adds permissions, or allow, where the settings have none", async () => {
    const { file } = project();
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify({ model: "x" }));
    await applyProjectPermission(file, { add: "Bash(a)" });
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({
      model: "x",
      permissions: { allow: ["Bash(a)"] },
    });
    fs.writeFileSync(file, JSON.stringify({ permissions: { deny: [] } }));
    await applyProjectPermission(file, { add: "Bash(a)" });
    expect(fs.readFileSync(file, "utf8")).toBe(
      `${JSON.stringify({ permissions: { deny: [], allow: ["Bash(a)"] } }, null, 2)}\n`,
    );
  });

  // 何を保証するか: 既にある rule の add、無い rule の remove は何も書かず、
  // changed=false を返す (ファイルの中身もタイムスタンプも変えない)。
  test("an add of a rule there, or a remove of one not there, writes nothing", async () => {
    const { file } = project();
    fs.mkdirSync(path.dirname(file));
    const original = `{"permissions":{"allow":["Bash(z)","Bash(a)"]}}`;
    fs.writeFileSync(file, original);
    for (const permission of [{ add: "Bash(a)" }, { remove: "Bash(b)" }]) {
      expect(await applyProjectPermission(file, permission)).toEqual({
        kind: "applied",
        changed: false,
        before: original,
        after: original,
      });
    }
    expect(fs.readFileSync(file, "utf8")).toBe(original);
    // A remove where there is no file makes none.
    const fresh = project();
    expect(await applyProjectPermission(fresh.file, { remove: "Bash(a)" })).toMatchObject({
      changed: false,
    });
    expect(fs.existsSync(fresh.file)).toBe(false);
  });

  // 何を保証するか: remove はその rule だけを消し、残りは並べて書く。
  test("a remove takes the rule out", async () => {
    const { file } = project();
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify({ permissions: { allow: ["Bash(b)", "Bash(a)"] } }));
    await applyProjectPermission(file, { remove: "Bash(b)" });
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({
      permissions: { allow: ["Bash(a)"] },
    });
  });

  // 何を保証するか: JSON でない・object でない・permissions.allow が文字列の
  // 配列でない設定は、書かずに unreadable で理由を返す (人の設定を壊さない)。
  test("settings that do not read are left as they are, with the reason", async () => {
    const { file } = project();
    fs.mkdirSync(path.dirname(file));
    for (const text of [
      "{ not json",
      "[]",
      `{"permissions":[]}`,
      `{"permissions":{"allow":"Bash(a)"}}`,
      `{"permissions":{"allow":[1]}}`,
    ]) {
      fs.writeFileSync(file, text);
      const applied = await applyProjectPermission(file, { add: "Bash(a)" });
      expect(applied.kind).toBe("unreadable");
      expect(fs.readFileSync(file, "utf8")).toBe(text);
    }
  });

  // 何を保証するか: 読み書きそのものの失敗 (設定ファイルの位置がディレクトリ)
  // は failed で返し、reject しない。
  test("a file that cannot be read is failed, not thrown", async () => {
    const { file } = project();
    fs.mkdirSync(file, { recursive: true });
    expect((await applyProjectPermission(file, { add: "Bash(a)" })).kind).toBe("failed");
  });

  // 何を保証するか: symlink の設定ファイルは辿った先を書き換え、symlink は残す
  // (dotfiles で管理された設定を実体ファイルに置き換えない)。
  test("a symlinked settings file is written through the link", async () => {
    const { file } = project();
    fs.mkdirSync(path.dirname(file));
    const real = path.join(tmpDir("perm-real-"), "settings.json");
    fs.writeFileSync(real, "{}");
    fs.symlinkSync(real, file);
    await applyProjectPermission(file, { add: "Bash(a)" });
    expect(fs.lstatSync(file).isSymbolicLink()).toBe(true);
    expect(JSON.parse(fs.readFileSync(real, "utf8"))).toEqual({
      permissions: { allow: ["Bash(a)"] },
    });
  });

  // 何を保証するか: 同じファイルへの適用をキューで 1 つずつにすると、同時に
  // 押した 2 件が両方残る (後の書き込みが先の書き込みを消さない)。
  test("applies queued on the file keep both rules", async () => {
    const { file } = project();
    const queue = createKeyedQueue();
    await Promise.all(
      ["Bash(a)", "Bash(b)", "Bash(c)"].map((rule) =>
        queue(file, () => applyProjectPermission(file, { add: rule })),
      ),
    );
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({
      permissions: { allow: ["Bash(a)", "Bash(b)", "Bash(c)"] },
    });
  });
});

describe("unifiedDiff", () => {
  // 何を保証するか: 変わった行の前後 3 行を文脈に、--- / +++ / @@ の見出しを
  // 付ける。無かったファイルは /dev/null から。同じなら空。
  test("shows the change with its context, from /dev/null for a new file", () => {
    const before = `{\n  "permissions": {\n    "allow": [\n      "Bash(b)"\n    ]\n  }\n}\n`;
    const after = `{\n  "permissions": {\n    "allow": [\n      "Bash(a)",\n      "Bash(b)"\n    ]\n  }\n}\n`;
    expect(unifiedDiff("/p/.claude/settings.local.json", before, after)).toBe(
      [
        "--- /p/.claude/settings.local.json",
        "+++ /p/.claude/settings.local.json",
        "@@ -1,6 +1,7 @@",
        " {",
        '   "permissions": {',
        '     "allow": [',
        '+      "Bash(a)",',
        '       "Bash(b)"',
        "     ]",
        "   }",
        "",
      ].join("\n"),
    );
    expect(unifiedDiff("/f", null, "{}\n")).toBe("--- /dev/null\n+++ /f\n@@ -0,0 +1,1 @@\n+{}\n");
    expect(unifiedDiff("/f", "{}\n", "{}\n")).toBe("");
  });

  // 何を保証するか: 離れた変更は別の hunk になり、行番号はそれぞれの位置を指す。
  test("changes far apart are hunks of their own", () => {
    const before = Array.from({ length: 20 }, (_, i) => `l${String(i + 1)}`).join("\n");
    const after = before.replace("l2\n", "L2\n").replace("l19\n", "L19\n");
    const diff = unifiedDiff("/f", `${before}\n`, `${after}\n`);
    expect(diff.split("\n").filter((line) => line.startsWith("@@"))).toEqual([
      "@@ -1,5 +1,5 @@",
      "@@ -16,5 +16,5 @@",
    ]);
  });
});

describe("createSettingsDiffNotifier", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  // 何を保証するか: 連続した適用は最後の適用から 5 秒後に 1 通にまとまり、
  // diff は最初の適用前 → 最後の適用後。5 秒経つ前には何も送らない。知らせは
  // ```diff のコードブロックで、ファイルは文でも diff の見出しでもプロジェクト
  // からの相対 (絶対パスを繰り返さず、スマホの幅で読める)。
  test("tells once, 5 s after the last apply, the diff of the whole burst", () => {
    jest.useFakeTimers();
    const told: { sid: string; text: string }[] = [];
    const notifier = createSettingsDiffNotifier((sid, text) => told.push({ sid, text }));
    const file = "/p/.claude/settings.local.json";
    notifier.applied("s1", file, null, `{\n  "a": 1\n}\n`);
    jest.advanceTimersByTime(SETTINGS_DIFF_NOTICE_DELAY_MS - 1);
    notifier.applied("s1", file, `{\n  "a": 1\n}\n`, `{\n  "a": 1,\n  "b": 2\n}\n`);
    jest.advanceTimersByTime(SETTINGS_DIFF_NOTICE_DELAY_MS - 1);
    expect(told).toEqual([]);
    jest.advanceTimersByTime(1);
    expect(told).toHaveLength(1);
    expect(told[0]?.sid).toBe("s1");
    expect(told[0]?.text).toBe(
      [
        ".claude/settings.local.json was updated; it takes effect immediately.",
        "",
        "```diff",
        "--- /dev/null",
        "+++ .claude/settings.local.json",
        "@@ -0,0 +1,4 @@",
        "+{",
        '+  "a": 1,',
        '+  "b": 2',
        "+}",
        "```",
      ].join("\n"),
    );
    jest.advanceTimersByTime(SETTINGS_DIFF_NOTICE_DELAY_MS * 2);
    expect(told).toHaveLength(1);
  });

  // 何を保証するか: 足して消した (最初と最後が同じ) 連打は何も送らない。
  // セッションごとに別々に数える。
  test("a burst that ends where it began tells nothing, and sessions count apart", () => {
    jest.useFakeTimers();
    const told: string[] = [];
    const notifier = createSettingsDiffNotifier((sid) => told.push(sid));
    notifier.applied("s1", "/p/f", "{}\n", `{"a":1}\n`);
    notifier.applied("s2", "/q/f", "{}\n", `{"b":1}\n`);
    notifier.applied("s1", "/p/f", `{"a":1}\n`, "{}\n");
    jest.advanceTimersByTime(SETTINGS_DIFF_NOTICE_DELAY_MS);
    expect(told).toEqual(["s2"]);
  });

  // 何を保証するか: stop の後は待っていた通知も送らない (daemon の停止)。
  test("stop drops what was waiting", () => {
    jest.useFakeTimers();
    const told: string[] = [];
    const notifier = createSettingsDiffNotifier((sid) => told.push(sid));
    notifier.applied("s1", "/p/f", "{}\n", `{"a":1}\n`);
    notifier.stop();
    jest.advanceTimersByTime(SETTINGS_DIFF_NOTICE_DELAY_MS);
    expect(told).toEqual([]);
  });
});
