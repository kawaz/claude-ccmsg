// 貼られた HTML を markdown に直す純関数 (DR-0065) の仕様。HTML を文書の外の木に
// するのは DOMParser なので、happy-dom の DOM の上で走らせる (fixture の出力は
// Chromium・WebKit の DOMParser の上と 1 文字も違わないことを実測で確かめた、
// DR-0065 §7)。
//
// fixtures/paste-html/ の出どころ:
// - github-dr.*.html / github-code.chromium.html: GitHub が描いたこのリポの DR を、
//   Playwright の Chromium・WebKit で範囲選択して ⌘C した時の text/html
//   (各ブラウザのクリップボードは OS のものと別)
// - webui-bubble.*.html: この webui の吹き出し (アシスタントの発言の markdown の
//   描画) を同じく ⌘C した text/html。元の markdown は webui-bubble の期待の
//   出力とほぼ同じ (表の区切りの行の書き方だけ違う)
// - monaco.*.html / monaco.txt: VS Code の editor (Monaco) で全体を選んで ⌘C
//   した text/html と text/plain (色付けの span と div だけ)
// - terminal-cocoa.html / .txt: ターミナル風の色・太字の文字を RTF にし、
//   Chromium が mac で RTF だけのクリップボードを HTML にする時と同じ Cocoa の
//   変換にかけたもの (1 行が 1 つの `<p>`、太字は `<b>`)
// - probe-sample.chrome.html / probe-sample.ios.html: 貼り付けの試験用のページの見本
//   (段落・入れ子のリスト・番号のリスト・表・コード) を Playwright の Chromium・
//   WebKit で ⌘C した text/html に、本物の Chrome (macOS) と iPhone の Safari の
//   実測の頭 (`<meta charset='utf-8'>` / `<!DOCTYPE html>`) を付けたもの。中身の形
//   (最上位の要素とセルの算出済みの style、WebKit の inline の要素の前後の空白の
//   `<span class="Apple-converted-space">`) は実測と同じ
// - docs-like.html / spreadsheet-like.html: ドキュメントの編集ソフトと表計算の
//   コピーの形を手で組んだもの (実物は OS のクリップボードを通さないと採れない)
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { htmlToMarkdown } from "../src/client/html-to-markdown.ts";
import { withDom } from "./dom.ts";

withDom();

const FIXTURES = path.join(import.meta.dir, "fixtures", "paste-html");
const fixture = (name: string): string => fs.readFileSync(path.join(FIXTURES, name), "utf8");
/** 期待の出力 (`.md`)。ファイルの末尾の改行は出力に無い。 */
const expected = (name: string): string => fixture(name).replace(/\n$/, "");

describe("real copies", () => {
  // Web のページ: 段落・引用・見出し・リスト・入れ子・表・リンク。Chromium と
  // WebKit でコピーの HTML の書き方は違う (WebKit は要素の境目の空白を U+00A0 で
  // 書く) が、出力は同じ。見出しのアンカー (アイコンだけのリンク) は出さない。
  test.each(["chromium", "webkit"])("a GitHub page copied in %s", (browser) => {
    expect(htmlToMarkdown(fixture(`github-dr.${browser}.html`))).toBe(expected("github-dr.md"));
  });

  // GitHub のコードの塊は `<div class="highlight highlight-source-ts"><pre>` で、
  // 言語はそこから取る。
  test("a GitHub code block keeps its language", () => {
    const out = htmlToMarkdown(fixture("github-code.chromium.html"));
    expect(out).toBe(expected("github-code.md"));
    expect(out).toContain("```ts\nconst AutoModeEntrySchema = v.pipe(\n  v.string(),");
  });

  // この webui の吹き出しのコピーは、元の markdown に戻る: 画像のリンク (🖼 alt) は
  // 画像に、コードの言語は `language-…` から、リストは tight のまま。
  test.each(["chromium", "webkit"])("this webui's bubble copied in %s", (browser) => {
    expect(htmlToMarkdown(fixture(`webui-bubble.${browser}.html`))).toBe(
      expected("webui-bubble.md"),
    );
  });

  // 色付けの span / div / 段落 / 太字だけの HTML は直さない (呼び手は text/plain を
  // そのまま入れる): 直すと字下げ・連続した空白・タブが崩れる。
  test.each(["monaco.chromium.html", "monaco.webkit.html", "terminal-cocoa.html"])(
    "an editor's or a terminal's copy (%s) is not converted",
    (name) => {
      expect(htmlToMarkdown(fixture(name))).toBeNull();
    },
  );

  // 本物の Chrome と iPhone の Safari の形。iPhone は inline の要素の前後の空白を
  // `<span class="Apple-converted-space">` で包むが、出力の空白は普通の空白 1 つ。
  test.each(["chrome", "ios"])("the paste probe's sample as %s copies it", (browser) => {
    const out = htmlToMarkdown(fixture(`probe-sample.${browser}.html`));
    expect(out).toBe(expected("probe-sample.md"));
    expect(out).not.toContain("\u00a0");
  });

  // 全体を包む `<b style="font-weight:normal">` は太字にしない。直下のリストの
  // 入れ子は前の項目の中へ。見出しの行の無い表は最初の行を見出しに。
  test("a document editor's shape", () => {
    expect(htmlToMarkdown(fixture("docs-like.html"))).toBe(expected("docs-like.md"));
  });

  test("a spreadsheet's shape", () => {
    expect(htmlToMarkdown(fixture("spreadsheet-like.html"))).toBe(expected("spreadsheet-like.md"));
  });
});

describe("each element", () => {
  test("links", () => {
    expect(htmlToMarkdown('<p>see <a href="https://example.com/a">the doc</a></p>')).toBe(
      "see [the doc](https://example.com/a)",
    );
    expect(htmlToMarkdown('<a href="mailto:x@example.com">mail</a>')).toBe(
      "[mail](mailto:x@example.com)",
    );
  });

  // WebKit の空白の包み方 (中身が普通の空白でも、beforeinput の形の U+00A0 でも)
  // は、空白 1 つになる (消えず、2 重にならない)。
  test.each([" ", "&nbsp;"])("spaces WebKit wraps (%p) are one space", (space) => {
    const wrap = `<span class="Apple-converted-space">${space}</span>`;
    expect(
      htmlToMarkdown(
        `<p>これは${wrap}<a href="https://example.com/docs">リンク</a>${wrap}と${wrap}<strong>太字</strong>${wrap}と…</p>`,
      ),
    ).toBe("これは [リンク](https://example.com/docs) と **太字** と…");
  });

  test("unordered and ordered lists, nested, with a start", () => {
    const html =
      "<ul><li>a<ul><li>a1</li><li>a2<ol><li>x</li><li>y</li></ol></li></ul></li><li>b</li></ul>" +
      '<ol start="3"><li>three</li><li>four</li></ol>';
    expect(htmlToMarkdown(html)).toBe(
      "- a\n  - a1\n  - a2\n    1. x\n    2. y\n- b\n\n3. three\n4. four",
    );
  });

  // 段落が 2 つ以上ある項目のリストは loose (項目の間を空行で分ける)。
  test("a list item with paragraphs makes the list loose", () => {
    expect(htmlToMarkdown("<ul><li><p>one</p><p>more</p></li><li><p>two</p></li></ul>")).toBe(
      "- one\n\n  more\n\n- two",
    );
  });

  test("tables: head, alignment, a line break in a cell, a pipe", () => {
    const html =
      "<table><thead><tr><th>name</th><th align=right>n</th><th align=center>c</th></tr></thead>" +
      "<tbody><tr><td>a<br>b</td><td>1</td><td><code>x|y</code> | z</td></tr>" +
      "<tr><td>only</td></tr></tbody></table>";
    expect(htmlToMarkdown(html)).toBe(
      "| name | n | c |\n| --- | --: | :-: |\n| a<br>b | 1 | `x\\|y` \\| z |\n| only | | |",
    );
  });

  test("headings", () => {
    expect(htmlToMarkdown("<h1>One</h1><h2>Two</h2><h6>Six</h6>")).toBe(
      "# One\n\n## Two\n\n###### Six",
    );
  });

  test("bold, italic, strikethrough and inline code", () => {
    expect(
      htmlToMarkdown(
        "<p><strong>b</strong> <b>b2</b> <em>i</em> <i>i2</i> <del>d</del> <s>s</s> <code>c</code></p>",
      ),
    ).toBe("**b** **b2** *i* *i2* ~~d~~ ~~s~~ `c`");
  });

  test("code blocks, with the language from `language-…` on the code or the pre", () => {
    expect(
      htmlToMarkdown('<pre><code class="language-ts">const a = 1;\n  b();\n</code></pre>'),
    ).toBe("```ts\nconst a = 1;\n  b();\n```");
    expect(htmlToMarkdown('<pre class="language-sh">ls  -la</pre>')).toBe("```sh\nls  -la\n```");
    expect(htmlToMarkdown("<pre>plain\n\tindent</pre>")).toBe("```\nplain\n\tindent\n```");
  });

  test("quotes", () => {
    expect(htmlToMarkdown("<blockquote><p>q <b>b</b></p><ul><li>x</li></ul></blockquote>")).toBe(
      "> q **b**\n>\n> - x",
    );
  });

  test("line breaks and paragraphs", () => {
    expect(htmlToMarkdown("<p>one<br>two</p><p>three</p><ul><li>x</li></ul>")).toBe(
      "one\\\ntwo\n\nthree\n\n- x",
    );
  });

  test("images", () => {
    expect(htmlToMarkdown('<p><img src="https://example.com/a.png" alt="the figure"></p>')).toBe(
      "![the figure](https://example.com/a.png)",
    );
  });

  test("horizontal rules", () => {
    expect(htmlToMarkdown("<p>a</p><hr><p>b</p>")).toBe("a\n\n---\n\nb");
  });

  // markdown の記号に読まれる文字は escape する。
  test("text that reads as markdown is escaped", () => {
    expect(htmlToMarkdown("<p>* not a list [x] # not a heading</p><hr>")).toBe(
      "\\* not a list \\[x] # not a heading\n\n---",
    );
  });
});

// この webui の描画が作るリンク (markdown-view.tsx) は元の markdown に戻す。
describe("this webui's own links", () => {
  test("a link the renderer added (a file path in code) is its text again", () => {
    expect(
      htmlToMarkdown(
        '<p>see <a class="md-inline-code-file-link" href="http://127.0.0.1:1/s/x/files/a.ts"><code>src/a.ts</code></a></p>',
      ),
    ).toBe("see `src/a.ts`");
  });

  test("an image drawn as a link is an image again; one of a path is its alt", () => {
    expect(
      htmlToMarkdown(
        '<ul><li><a class="md-image-link" href="https://example.com/a.png">🖼 図</a></li>' +
          '<li><a class="md-image-link md-path-link" href="http://127.0.0.1:1/s/x/files/b.png" title="docs/b.png">🖼 図 2</a></li></ul>',
      ),
    ).toBe("- ![図](https://example.com/a.png)\n- 図 2");
  });
});

describe("no conversion", () => {
  test.each([
    ["no HTML", ""],
    ["spans and divs", '<div style="white-space: pre"><span style="color:red">a  b</span></div>'],
    ["paragraphs, line breaks and bold", "<p><b>bold</b></p><p>a<br>b</p>"],
    ["a link with a javascript: URL", '<p><a href="javascript:alert(1)">x</a></p>'],
    ["a relative link", '<p><a href="docs/a.md">x</a></p>'],
    ["an image with a data: URL", '<img src="data:image/png;base64,AAAA" alt="x">'],
    ["an anchor in an SVG", '<svg><a href="https://example.com/">x</a></svg>'],
  ])("%s", (_, html) => {
    expect(htmlToMarkdown(html)).toBeNull();
  });
});

describe("safety", () => {
  // 出力は markdown の文字だけ: script・style・コメント・イベントの属性は出さず、
  // http(s)・mailto 以外の URL は文言 (画像は alt) だけ。
  const HOSTILE =
    '<ul><li><a href="javascript:alert(1)">js</a></li>' +
    '<li><a href=" JaVa\tScRiPt:alert(1)">split</a></li>' +
    '<li><a href="data:text/html,x">data</a></li>' +
    '<li><a href="/relative">rel</a></li>' +
    '<li><img src="javascript:alert(1)" alt="js-img" onerror="alert(1)"></li>' +
    '<li><img src="data:image/png;base64,AAAA" alt=""></li>' +
    '<li onclick="alert(1)"><a href="https://example.com/ok" onclick="alert(1)">ok</a></li></ul>' +
    "<script>alert('s')</script><style>p{color:red}</style><!-- a comment -->" +
    '<template><a href="https://example.com/t">t</a></template>' +
    "<button>コピー</button>";

  test("only http(s) and mailto URLs stay; script, style, comments and events do not come out", () => {
    expect(htmlToMarkdown(HOSTILE)).toBe(
      "- js\n- split\n- data\n- rel\n- js-img\n-\n- [ok](https://example.com/ok)",
    );
  });

  test("no HTML tag comes out but a <br> in a table cell", () => {
    const out = htmlToMarkdown(
      `${HOSTILE}<table><tr><th>a<br>b</th></tr></table><p>x<br>y &lt;b&gt;</p>`,
    );
    // `\<` は escape された文字の `<` (タグではない)。
    const tags = Array.from(out?.matchAll(/(\\?)<[^>]*>/g) ?? [])
      .filter((m) => m[1] === "")
      .map((m) => m[0]);
    expect(tags).toEqual(["<br>"]);
    expect(out).toContain("x\\\ny \\<b>");
  });
});
