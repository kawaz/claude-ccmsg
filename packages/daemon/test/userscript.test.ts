// The person's userscript for the webui (DR-0057): the check and the build
// the daemon makes of a source before saving it (§1), where it keeps the
// source and the build (§2), the four ops and who may send them (§6).
//
// 何を保証するか:
//   - 検査はコードを実行せずに、構文エラー・`userscript` の export が無い・ブラウザで解決できない
//     import (https:// / http:// 以外) を断り、それぞれ何が悪いかを出力に書く
//   - TS の構文 (型注釈・interface・型だけの import) は通り、build した JS からは型が消える
//   - JS だけで書いたソースもそのまま通る
//   - https:// の import は bundle せず、build した JS にそのまま残る
//   - トップレベルで document / window に触るスクリプトも通る (daemon で実行しないので)
//   - 保存はソース (config dir の userscript.ts、書いたまま) と build (state dir の userscript.js) の両方。
//     断ったソースはどちらも保存されず、前に保存したものが残る
//   - ソースが symlink なら保存はその実体に届き、symlink は残る。保存は元のソースの mode を保つ
//   - read はソース (build ではない)、load は build。build が無いか、ソースより古ければ load が作り直す。
//     手で壊されたソースは load が userscript_invalid で断る
//   - 削除はソースと build を消し、以後 read / load は「無い」を返す。無い時の削除は not_found
//   - 4 つの op は user role だけ
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { checkUserscript, createUserscriptStore } from "../src/userscript.ts";
import {
  connect,
  type DaemonCtx,
  fixtureDir,
  sessionConn,
  startTestDaemon,
  stopTestDaemon,
  type TestClient,
  userConn,
} from "./helpers.ts";

const T = 15000;
const SID = "cccccccc-5757-4333-8444-555555555555";

const GOOD = `export async function userscript(util: { session(sid: string): Promise<unknown> }): Promise<void> {
  const label: string = "x";
  document.title = label;
}
`;

/** TypeScript-only syntax the check must take and the served JS must lose. */
const TYPED = `import type { Foo } from "https://example.invalid/types.ts";
interface Row { sid: string; n: number }
type Pick2 = Pick<Row, "sid">;
const rows: Row[] = [];
export async function userscript(util: Foo): Promise<void> {
  const first = rows[0] satisfies Row | undefined;
  const sid = (first as Pick2 | undefined)?.sid ?? "none";
  window.console.log(sid as string);
}
`;

describe("checkUserscript (DR-0057 §1)", () => {
  test("a correct script passes, and the JS it serves is the same code without types", () => {
    const check = checkUserscript(GOOD);
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.js).toContain("export async function userscript(util)");
    expect(check.js).toContain("document.title = label;");
    expect(check.js).not.toContain(": string");
  });

  test("JavaScript alone passes and is served as it is", () => {
    const js = 'export async function userscript(util) {\n  document.title = "x";\n}\n';
    const check = checkUserscript(js);
    expect(check).toEqual({ ok: true, js });
  });

  test("an https:// import is kept as it is, not bundled", () => {
    const check = checkUserscript(
      'import x from "https://esm.sh/x@1";\nexport async function userscript(util: unknown) { x(util); }\n',
    );
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.js).toContain('import x from "https://esm.sh/x@1";');
  });

  test("TypeScript syntax passes and its types are gone from the JS", () => {
    const check = checkUserscript(TYPED);
    expect(check).toMatchObject({ ok: true });
    if (!check.ok) return;
    expect(check.js).not.toMatch(/interface|satisfies|: Row|import type/u);
    expect(check.js).toContain("export async function userscript(util)");
  });

  test("a syntax error is refused with where it is and what the parser said", () => {
    const check = checkUserscript("export async function userscript(util) {\n  const = 1;\n}\n");
    expect(check.ok).toBe(false);
    if (check.ok) return;
    const out = check.problems.join("\n");
    expect(out).toContain('userscript.ts:2:9: Expected identifier but found "="');
    // The line and a caret under the column.
    expect(out).toContain("\n    const = 1;\n          ^");
  });

  test("a single parse failure (not an AggregateError) is said the same way", () => {
    const check = checkUserscript("export function userscript() {\n");
    expect(check).toEqual({
      ok: false,
      problems: [
        "userscript.ts:1:31: Unexpected end of file\n  export function userscript() {\n                                ^",
      ],
    });
  });

  test("no `userscript` export is refused", () => {
    for (const source of [
      "export async function other(util) {}\n",
      "export default async function userscript() {}\n",
      "export type userscript = number;\n",
      "",
    ]) {
      const check = checkUserscript(source);
      expect(check.ok).toBe(false);
      if (check.ok) continue;
      expect(check.problems).toHaveLength(1);
      expect(check.problems[0]).toContain("`userscript` が export されていない");
    }
  });

  test("the forms of export that name it pass", () => {
    for (const source of [
      "export const userscript = async (util: unknown) => {};\n",
      "async function run(): Promise<void> {}\nexport { run as userscript };\n",
      'export { userscript } from "https://example.invalid/u.js";\n',
    ]) {
      expect(checkUserscript(source)).toMatchObject({ ok: true });
    }
  });

  test("an import the browser cannot resolve from a blob: module is refused, each named", () => {
    const check = checkUserscript(
      [
        'import a from "lodash";',
        'import b from "./b.js";',
        'import c from "/c.js";',
        'import d from "https://esm.sh/d";',
        'import e from "http://localhost:1/e.js";',
        "export async function userscript(util) {",
        '  await import("left-pad");',
        "  a(); b(); c(); d(); e();",
        "}",
        "",
      ].join("\n"),
    );
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.problems).toEqual([
      'userscript.ts: import "lodash" はブラウザで読めない (https:// か http:// で始まる URL だけ import できる)',
      'userscript.ts: import "./b.js" はブラウザで読めない (https:// か http:// で始まる URL だけ import できる)',
      'userscript.ts: import "/c.js" はブラウザで読めない (https:// か http:// で始まる URL だけ import できる)',
      'userscript.ts: import "left-pad" はブラウザで読めない (https:// か http:// で始まる URL だけ import できる)',
    ]);
  });

  test("a missing export and a bad import are both said", () => {
    const check = checkUserscript('import a from "lodash";\nexport function other() { a(); }\n');
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.problems).toHaveLength(2);
  });
});

describe("the userscript store (DR-0057 §2)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function store() {
    const dir = fixtureDir("userscript");
    dirs.push(dir);
    const files = {
      source: path.join(dir, "config", "userscript.ts"),
      built: path.join(dir, "state", "userscript.js"),
    };
    return { files, store: createUserscriptStore(files) };
  }

  test("nothing until saved; a save keeps the source as written and its build", async () => {
    const { files, store: s } = store();
    expect(await s.read()).toBeNull();
    expect(await s.load()).toEqual({ ok: true });
    expect(await s.write(GOOD)).toEqual({ ok: true });
    expect(fs.readFileSync(files.source, "utf8")).toBe(GOOD);
    const built = fs.readFileSync(files.built, "utf8");
    expect(built).toContain("export async function userscript(util)");
    expect(built).not.toContain(": string");
    // The edit dialog gets the source; the browser gets the build.
    expect(await s.read()).toBe(GOOD);
    expect(await s.load()).toEqual({ ok: true, js: built });
  });

  test("a refused source is not saved and what was saved stays", async () => {
    const { files, store: s } = store();
    const refusedFirst = await s.write("export function other() {}\n");
    expect(refusedFirst.ok).toBe(false);
    expect(fs.existsSync(files.source)).toBe(false);
    expect(fs.existsSync(files.built)).toBe(false);
    await s.write(GOOD);
    const built = fs.readFileSync(files.built, "utf8");
    const refused = await s.write("export async function userscript() {\n");
    expect(refused.ok).toBe(false);
    expect(fs.readFileSync(files.source, "utf8")).toBe(GOOD);
    expect(fs.readFileSync(files.built, "utf8")).toBe(built);
  });

  test("load serves the saved build without building again", async () => {
    const { files, store: s } = store();
    await s.write(GOOD);
    // A build the daemon did not make from this source would only be served
    // as it stands if load does not build again.
    fs.writeFileSync(files.built, "export async function userscript() { /* kept */ }\n");
    expect(await s.load()).toEqual({
      ok: true,
      js: "export async function userscript() { /* kept */ }\n",
    });
  });

  test("a build that is missing, or older than a source edited by hand, is made again", async () => {
    const { files, store: s } = store();
    await s.write(GOOD);
    fs.rmSync(files.built);
    const rebuilt = await s.load();
    expect(rebuilt).toMatchObject({ ok: true });
    expect(fs.readFileSync(files.built, "utf8")).toContain("document.title = label;");

    fs.writeFileSync(
      files.source,
      "export async function userscript(util) { document.title = 'hand'; }\n",
    );
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(files.built, past, past);
    const loaded = await s.load();
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.js).toContain('document.title = "hand"');
  });

  test("delete removes the source and its build; with none saved it says so", async () => {
    const { files, store: s } = store();
    expect(await s.delete()).toBe(false);
    await s.write(GOOD);
    expect(await s.delete()).toBe(true);
    expect(fs.existsSync(files.source)).toBe(false);
    expect(fs.existsSync(files.built)).toBe(false);
    expect(await s.read()).toBeNull();
    expect(await s.load()).toEqual({ ok: true });
    expect(await s.delete()).toBe(false);
  });

  test("a source broken by hand after the save is refused by load", async () => {
    const { files, store: s } = store();
    await s.write(GOOD);
    fs.writeFileSync(files.source, "export async function userscript( {\n");
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(files.built, past, past);
    const loaded = await s.load();
    expect(loaded.ok).toBe(false);
  });

  // The person may keep the source in their dotfiles and link it in: a save
  // writes through to the file the link names, and keeps its mode.
  test("a source that is a symlink: a save writes the link's target, keeps the link and the target's mode", async () => {
    const { files, store: s } = store();
    const target = path.join(path.dirname(path.dirname(files.source)), "dotfiles", "userscript.ts");
    fs.mkdirSync(path.dirname(target));
    fs.writeFileSync(target, "export async function userscript() {}\n", { mode: 0o640 });
    fs.chmodSync(target, 0o640);
    fs.mkdirSync(path.dirname(files.source));
    fs.symlinkSync(target, files.source);
    expect(await s.write(GOOD)).toEqual({ ok: true });
    expect(fs.lstatSync(files.source).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe(GOOD);
    expect(fs.statSync(target).mode & 0o777).toBe(0o640);
    expect(fs.readdirSync(path.dirname(files.source))).toEqual(["userscript.ts"]);
    expect(fs.readdirSync(path.dirname(target))).toEqual(["userscript.ts"]);
  });

  test("a save keeps the mode of the source it replaces", async () => {
    const { files, store: s } = store();
    fs.mkdirSync(path.dirname(files.source));
    fs.writeFileSync(files.source, "export async function userscript() {}\n", { mode: 0o640 });
    fs.chmodSync(files.source, 0o640);
    expect(await s.write(GOOD)).toEqual({ ok: true });
    expect(fs.readFileSync(files.source, "utf8")).toBe(GOOD);
    expect(fs.statSync(files.source).mode & 0o777).toBe(0o640);
  });
});

describe("the userscript ops (DR-0057 §6)", () => {
  const cleanups: (() => void | Promise<void>)[] = [];
  afterEach(async () => {
    for (const f of cleanups.splice(0).reverse()) await f();
  });

  async function daemon(): Promise<DaemonCtx> {
    const ctx = await startTestDaemon();
    cleanups.push(() => stopTestDaemon(ctx));
    return ctx;
  }

  async function user(ctx: DaemonCtx): Promise<TestClient> {
    const c = await userConn(ctx);
    cleanups.push(() => c.close());
    return c;
  }

  test(
    "save, read and load through the daemon: the source in its config dir, the build in its state dir",
    async () => {
      const ctx = await daemon();
      const c = await user(ctx);
      expect(await c.requestOk({ op: "userscript_read" })).toEqual({ ok: true });
      expect(await c.requestOk({ op: "userscript_load" })).toEqual({ ok: true });

      const refused = await c.requestError({
        op: "userscript_write",
        source: "export const x = ;\n",
      });
      expect(refused.error.code).toBe("userscript_invalid");
      expect(refused.error.msg).toContain("userscript.ts:1:");
      expect(fs.existsSync(path.join(ctx.configDir, "userscript.ts"))).toBe(false);

      expect(await c.requestOk({ op: "userscript_write", source: GOOD })).toEqual({ ok: true });
      expect(fs.readFileSync(path.join(ctx.configDir, "userscript.ts"), "utf8")).toBe(GOOD);
      const built = fs.readFileSync(path.join(ctx.stateDir, "userscript.js"), "utf8");
      expect(await c.requestOk({ op: "userscript_read" })).toEqual({ ok: true, source: GOOD });
      expect(await c.requestOk({ op: "userscript_load" })).toEqual({ ok: true, js: built });
      expect(built).toContain("document.title = label;");

      expect(await c.requestOk({ op: "userscript_delete" })).toEqual({ ok: true });
      expect(fs.existsSync(path.join(ctx.configDir, "userscript.ts"))).toBe(false);
      expect(fs.existsSync(path.join(ctx.stateDir, "userscript.js"))).toBe(false);
      expect(await c.requestOk({ op: "userscript_read" })).toEqual({ ok: true });
      expect(await c.requestOk({ op: "userscript_load" })).toEqual({ ok: true });
      expect((await c.requestError({ op: "userscript_delete" })).error.code).toBe("not_found");
    },
    T,
  );

  test(
    "a session and a connection without hello are refused every op",
    async () => {
      const ctx = await daemon();
      const session = await sessionConn(ctx, SID);
      cleanups.push(() => session.close());
      const anonymous = await connect(ctx.sock);
      cleanups.push(() => anonymous.close());
      const ops = [
        { op: "userscript_read" },
        { op: "userscript_write", source: GOOD },
        { op: "userscript_load" },
        { op: "userscript_delete" },
      ] as const;
      for (const body of ops) {
        expect((await session.requestError(body)).error).toEqual({
          code: "bad_request",
          msg: `op '${body.op}' requires user role`,
        });
        expect((await anonymous.requestError(body)).error.code).toBe("hello_required");
      }
      expect(fs.existsSync(path.join(ctx.configDir, "userscript.ts"))).toBe(false);
    },
    T,
  );
});
