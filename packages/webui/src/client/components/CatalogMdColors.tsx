// /catalog の markdown 2 セクション — 「全装飾」と「色の内訳」。
//
// 2 つが同じファイルにあるのは、どちらも同じ 4 つの「面」(= markdown が載る
// 背景) の上に同じものを並べる画面だから。装飾の色は面からの距離で決まるので
// (docs/design/design-tokens.md「面の色」)、面を固定した見本でなければ「濃い /
// 薄い」の話ができない。
//
// 色の内訳は **式を書き写さない**。app.css 側で導出結果に名前を付けてあり
// (`--md-inline-code-bg` 等)、custom property の計算値は var() が解決された
// 後の導出式そのものなので、それを実行時に読めば式が手に入る。解決後の色は
// 同じ要素の描画済みプロパティ (background-color 等) から読む。どちらも実物
// 由来なので、app.css を変えれば表も一緒に変わる。
import type { ComponentChildren, RefObject } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { MarkdownView } from "../markdown-view.tsx";
import { hueForSeed } from "../avatar.tsx";

/** markdown が載る面。装飾の色はここからの距離で決まるので、見本は必ず面と
 * 対にして置く。並び順は「素の面 → 発話者別の吹き出し」。 */
interface FaceDef {
  id: string;
  /** その面を作っているクラス。gutter に出す名前でもある。 */
  name: string;
  note: string;
}

const MD_FACES: FaceDef[] = [
  { id: "preview", name: ".viewer-preview .md", note: "ファイルプレビュー。--bg の上" },
  { id: "user", name: ".tl-bubble-right .md", note: "ユーザ発話の吹き出し。緑系" },
  { id: "assistant", name: ".tl-bubble-assistant .md", note: "アシスタント応答。紫系" },
  { id: "peer", name: ".tl-bubble-peer .md", note: "別セッション発の msg。青系" },
];

/** renderer が出す装飾を 1 つずつ全部通す見本。組版の見本 (MARKDOWN_SAMPLE)
 * が「読み物としての縦のリズム」を測るものなのに対し、こちらは網羅が目的 —
 * 装飾を足したのにどの面でも確認できない、という状態を作らないための面。 */
export const MARKDOWN_ALL_SAMPLE = `# h1 見出し

段落。**bold**、*italic*、~~del~~、\`inline code\`、[リンク](https://example.com)、[パスへのリンク](docs/design/design-tokens.md) が 1 行に同居する。

## h2 見出し

パスの形をした inline code \`packages/webui/src/public/app.css\` と bold **packages/webui/src/public/app.css** は、どちらも同じ FileViewer へのリンクになる。行番号付き \`src/client/markdown-view.tsx:42\` も同じ。

### h3 見出し

#### h4 見出し

##### h5 見出し

###### h6 見出し

- 箇条書き
- **項目名** — 説明が続く形
  - 入れ子
    - さらに入れ子
- [x] 済みのタスク
- [ ] 未着手のタスク

1. 番号付き
2. 2 つ目
   1. 入れ子の番号付き

> 引用。中でも \`inline code\` は面を測り直す。
>
> > 入れ子の引用。地はもう一段沈む。

| 列 | 決めるもの | 効き方 |
| --- | --- | --- |
| 罫 | セルの範囲 | 表であること |
| 見出しセル | 列の名前 | 地と濃さ |

\`\`\`ts
// 言語付きのブロックコード (Shiki が着色する)
export function catalogHref(): string {
  return "/catalog";
}
\`\`\`

\`\`\`
言語なしのブロックコード。着色されずプレーンのまま出る。
\`\`\`

<details>
<summary>畳める区画 (details / summary)</summary>

中身は 1 段沈んだ面の上に載るので、\`inline code\` もそれに合わせて濃くなる。

</details>

![画像は取得せずリンクにする](docs/design/diagram.png)

---

区切り線の後の段落。`;

/** 色の内訳を測るための最小の見本。装飾を 1 つずつ 1 回だけ含む — 表の各行が
 * ここのどの要素を測ったものかが 1 対 1 で対応する。 */
const MD_PROBE_SAMPLE = `\`inline code\` と本文。

> 引用の帯。

| 見出し | 値 |
| --- | --- |
| 罫 | 地 |

\`\`\`
ブロックコード
\`\`\`

<details open>
<summary>details パネル</summary>

中身。

</details>

---
`;

/** カタログは daemon から何も読まないので、リンカも literal を渡す。inline
 * code / bold のリンク化は「daemon がファイルの実在を答えた token だけ」が
 * 本来の条件なので、ここでは見本に出てくる token だけを許して他は素の
 * `<code>` に落とす (= 全部リンクになる嘘の見本を作らない)。 */
const CATALOG_SAMPLE_PATHS = new Set([
  "packages/webui/src/public/app.css",
  "src/client/markdown-view.tsx:42",
]);
const catalogFilePathLinker = (token: string): string | null =>
  CATALOG_SAMPLE_PATHS.has(token) ? "#" : null;
const catalogPathLinker = (): string => "#";

/** 面の上に markdown を置く。`ref` は `--md-surface` を宣言している要素 (=
 * 面そのもの) に付く — 色の内訳がその要素から面の色を読むため。 */
function MdFaceStage({
  face,
  source,
  stageRef,
}: {
  face: FaceDef;
  source: string;
  stageRef?: RefObject<HTMLDivElement>;
}) {
  const body = (
    <MarkdownView
      source={source}
      filePathLinker={catalogFilePathLinker}
      pathLinker={catalogPathLinker}
    />
  );
  if (face.id === "preview") {
    return (
      <div class="viewer-preview catalog-md-stage" ref={stageRef}>
        {body}
      </div>
    );
  }
  const bubbleClass =
    face.id === "user"
      ? "tl-bubble tl-bubble-right"
      : face.id === "assistant"
        ? "tl-bubble tl-bubble-left tl-bubble-assistant"
        : "tl-bubble tl-bubble-left tl-bubble-peer";
  // peer の吹き出しは送信者ごとの hue を inline style で受け取る側なので、
  // 見本でも実画面と同じ形 (= 固定の seed から起こした hue) で渡す。
  const style =
    face.id === "peer"
      ? { "--member-hue": String(hueForSeed("a3f1c204-0000-4000-8000-000000000001")) }
      : undefined;
  return (
    <div class={bubbleClass} style={style}>
      <div class="tl-bubble-body" ref={stageRef}>
        {body}
      </div>
    </div>
  );
}

/** 内訳の 1 行 = 装飾 1 つ。`prop` が app.css で導出結果に付けた名前、
 * `selector` がそれを宣言している要素、`paint` がその値が実際に塗られている
 * プロパティ。3 つが揃って初めて「式」と「解決値」が同じ 1 つの色を指す。 */
interface ProbeDef {
  label: string;
  prop: string;
  selector: string;
  paint: (cs: CSSStyleDeclaration) => string;
}

const MD_COLOR_PROBES: ProbeDef[] = [
  {
    label: "inline code の地",
    prop: "--md-inline-code-bg",
    selector: ".md-inline-code",
    paint: (cs) => cs.backgroundColor,
  },
  {
    label: "inline code の罫",
    prop: "--md-inline-code-rule",
    selector: ".md-inline-code",
    paint: (cs) => cs.borderTopColor,
  },
  {
    label: "inline code の文字",
    prop: "--md-inline-code-fg",
    selector: ".md-inline-code",
    paint: (cs) => cs.color,
  },
  {
    label: "ブロックコードの地",
    prop: "--md-block-code-bg",
    selector: ".md-code",
    paint: (cs) => cs.backgroundColor,
  },
  {
    label: "引用の地",
    prop: "--md-quote-bg",
    selector: "blockquote",
    paint: (cs) => cs.backgroundColor,
  },
  {
    label: "引用の左罫",
    prop: "--md-quote-rule",
    selector: "blockquote",
    paint: (cs) => cs.borderLeftColor,
  },
  { label: "表の罫", prop: "--md-table-rule", selector: "td", paint: (cs) => cs.borderTopColor },
  {
    label: "表の見出しセルの地",
    prop: "--md-table-head-bg",
    selector: "th",
    paint: (cs) => cs.backgroundColor,
  },
  { label: "区切り線", prop: "--md-hr-rule", selector: "hr", paint: (cs) => cs.borderTopColor },
  {
    label: "details の地",
    prop: "--md-details-bg",
    selector: ".md-details",
    paint: (cs) => cs.backgroundColor,
  },
  {
    label: "details の罫",
    prop: "--md-details-rule",
    selector: ".md-details",
    paint: (cs) => cs.borderTopColor,
  },
];

interface ProbeRow {
  label: string;
  prop: string;
  /** var() が解決された後の導出式。app.css の宣言そのもの。 */
  formula: string;
  /** ブラウザが実際に塗った色。導出結果は計算した色空間のまま出てくる。 */
  resolved: string;
  /** 上を sRGB に落とした 16 進。面ごとの濃さを見比べるのは実質こちら。 */
  hex: string;
}

/** 計算値は導出に使った色空間のまま (`oklab(0.9 0.03 0.02)`) 返ってくる。桁の並び
 * では濃さを見比べられないので、ブラウザ自身に sRGB へ落とさせる — 1px の
 * canvas に塗って読み返すのが、パーサを持たずに同じ変換を得る唯一の道。
 * 解釈できない値ではそのまま空を返し、呼び出し側が生の文字列だけを出す。 */
function toSrgbHex(color: string): string {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return "";
  // 読めない値を渡すと fillStyle は据え置かれる。目印を先に入れておけば、
  // 据え置かれたこと自体が「解釈できなかった」の合図になる。
  ctx.fillStyle = "#010203";
  ctx.fillStyle = color;
  if (ctx.fillStyle === "#010203") return "";
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** 面の色は容器の `background` が持つので、`--md-surface` を宣言している要素
 * 自身が透明なこともある (プレビューの容器は台が塗っている)。実際に塗られて
 * いる色を出すために、透明でない最初の祖先まで遡る — ここで面の色と
 * `--md-surface` が食い違えば「容器が background の隣で宣言する」規約
 * (docs/design/design-tokens.md) が破れているということ。 */
function paintedBackground(el: HTMLElement): string {
  for (let node: HTMLElement | null = el; node; node = node.parentElement) {
    const bg = getComputedStyle(node).backgroundColor;
    if (bg && bg !== "transparent" && !bg.startsWith("rgba(0, 0, 0, 0)")) return bg;
  }
  return "transparent";
}

function row(label: string, prop: string, formula: string, resolved: string): ProbeRow {
  return { label, prop, formula, resolved, hex: toSrgbHex(resolved) };
}

function probeFace(root: HTMLElement): ProbeRow[] {
  const rootStyle = getComputedStyle(root);
  const rows: ProbeRow[] = [
    row(
      "面",
      "--md-surface",
      rootStyle.getPropertyValue("--md-surface").trim(),
      paintedBackground(root),
    ),
  ];
  for (const probe of MD_COLOR_PROBES) {
    const el = root.querySelector<HTMLElement>(probe.selector);
    if (!el) continue;
    const cs = getComputedStyle(el);
    rows.push(
      row(probe.label, probe.prop, cs.getPropertyValue(probe.prop).trim(), probe.paint(cs)),
    );
  }
  return rows;
}

/** 見本 1 面分 — 実物と、その実物から読んだ色の表。表が見本の隣にあるのは、
 * 数字がどの絵から出たものかを読者が確かめられるようにするため。 */
function MdColorFace({ face }: { face: FaceDef }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [rows, setRows] = useState<ProbeRow[]>([]);
  useEffect(() => {
    const read = () => {
      if (stageRef.current) setRows(probeFace(stageRef.current));
    };
    read();
    // テーマが変わればトークンごと入れ替わるので、読み直さないと表だけが
    // 前のテーマの値のまま残る。
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", read);
    return () => mq.removeEventListener("change", read);
  }, []);
  return (
    <div class="catalog-specimen">
      <div class="catalog-specimen-head">
        <code class="catalog-specimen-name">{face.name}</code>
        <span class="catalog-specimen-note">{face.note}</span>
      </div>
      <div class="catalog-specimen-stage catalog-md-colors">
        <MdFaceStage face={face} source={MD_PROBE_SAMPLE} stageRef={stageRef} />
        <table class="catalog-color-table">
          <thead>
            <tr>
              <th>装飾</th>
              <th>名前</th>
              <th>導出式 (var() 解決後)</th>
              <th>解決値</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.prop}>
                <td>{row.label}</td>
                <td>
                  <code class="catalog-color-prop">{row.prop}</code>
                </td>
                <td>
                  <code class="catalog-color-formula">{row.formula}</code>
                </td>
                <td>
                  <span class="catalog-color-resolved">
                    <span class="catalog-swatch-chip" style={{ background: row.resolved }} />
                    <span class="catalog-color-values">
                      {row.hex !== "" ? <code class="catalog-color-value">{row.hex}</code> : null}
                      <code class="catalog-color-computed">{row.resolved}</code>
                    </span>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function MdAllSection(): ComponentChildren {
  return (
    <>
      {MD_FACES.map((face) => (
        <div class="catalog-specimen" key={face.id}>
          <div class="catalog-specimen-head">
            <code class="catalog-specimen-name">{face.name}</code>
            <span class="catalog-specimen-note">{face.note}</span>
          </div>
          <div class="catalog-specimen-stage">
            <MdFaceStage face={face} source={MARKDOWN_ALL_SAMPLE} />
          </div>
        </div>
      ))}
    </>
  );
}

export function MdColorSection(): ComponentChildren {
  return (
    <>
      {MD_FACES.map((face) => (
        <MdColorFace face={face} key={face.id} />
      ))}
    </>
  );
}
