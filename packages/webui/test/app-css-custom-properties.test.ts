// app.css の custom property 宣言に対する検査。
//
// CSS の `var()` は「その宣言を書いた要素」の上で解決されるので、
// `--x: color-mix(..., var(--x), ...)` は宣言先を親にしても子にしても自己
// 参照 = 循環参照になり、その要素で `--x` は guaranteed-invalid になる。
// 無効な custom property を参照した宣言は invalid at computed-value time で
// 丸ごと捨てられるため、`border: 1px solid var(--md-table-rule)` は
// border-style: none (罫線が消える)、`background: var(--md-table-head-bg)` は
// transparent に落ちる。`.md-details > *` がこの形で `--md-surface` を
// 積み直していたため、`<details>` の中の表だけ罫線と見出し地が消えていた。
//
// 面を一段深くしたい時は、器が既に導出済みの地色 (`--md-quote-bg` /
// `--md-details-bg` / `--md-table-head-bg`) を子へ名前で渡す。
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const CSS_PATH = path.join(import.meta.dir, "..", "src", "public", "app.css");

/** コメントを除いた app.css。値の中の `/* ... *​/` を宣言の一部と誤読しない
 * ためで、除去後も宣言の区切り (`;` / `{` / `}`) は保たれる。 */
function cssWithoutComments(): string {
  return fs.readFileSync(CSS_PATH, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
}

/** `--name: value;` の宣言を全部拾う。値に `;` `{` `}` は現れないので、
 * 複数行にまたがる `oklch(from var(--md-surface) ...)` もそのまま 1 件に
 * なる。 */
function customPropertyDeclarations(): { name: string; value: string; line: number }[] {
  const css = cssWithoutComments();
  const out: { name: string; value: string; line: number }[] = [];
  const re = /(--[\w-]+)\s*:\s*([^;{}]*);/g;
  for (let m = re.exec(css); m !== null; m = re.exec(css)) {
    out.push({
      name: m[1]!,
      value: m[2]!,
      line: css.slice(0, m.index).split("\n").length,
    });
  }
  return out;
}

describe("app.css custom properties", () => {
  test("no custom property is derived from itself", () => {
    const cycles = customPropertyDeclarations()
      .filter((d) => new RegExp(`var\\(\\s*${d.name}\\b`).test(d.value))
      .map((d) => `line ${d.line}: ${d.name}: ${d.value.trim()}`);
    expect(cycles).toEqual([]);
  });

  // 逆向き (self-written-rule-blind-spots): 上の検査が「宣言が 1 件も取れて
  // いないので空」で通ってしまわないよう、実データが載っていることを確かめる。
  test("the scan actually sees app.css's declarations", () => {
    const names = new Set(customPropertyDeclarations().map((d) => d.name));
    expect(names.has("--md-surface")).toBe(true);
    expect(names.has("--md-details-bg")).toBe(true);
    expect(names.has("--md-table-head-bg")).toBe(true);
  });

  // 面を一段深くする 3 箇所は、器が導出済みの地色を子へ渡す形であること。
  // (循環参照検査だけだと「色を混ぜるのをやめた」退行を拾えない)
  test("nested surfaces take the container's derived background by name", () => {
    const css = cssWithoutComments();
    for (const [selector, source] of [
      [".md blockquote > *", "--md-quote-bg"],
      [".md-details > *", "--md-details-bg"],
      [".md th > *", "--md-table-head-bg"],
    ] as const) {
      const block = new RegExp(
        `${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`,
      ).exec(css);
      expect(block, `${selector} block not found`).not.toBeNull();
      expect(block![1]).toContain(`--md-surface: var(${source})`);
    }
  });
});
