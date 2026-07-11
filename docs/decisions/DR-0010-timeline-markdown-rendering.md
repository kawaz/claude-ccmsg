# DR-0010: Timeline アシスタント発言の Markdown レンダリング

- **Status**: Accepted (team-lead セッションからの委譲プロンプトで確定方針として提示、実装完了)
- **Date**: 2026-07-11
- **Author**: AI agent (worker session、team-lead セッションの委譲プロンプトに基づく)
- **一次資料**: team-lead セッションからの委譲メッセージ (2026-07-11、下記 Context に要旨転記)
- **前提 DR**: DR-0005 (frontend architecture、preact/JSX 方針)・DR-0008 §6 follow-up (syntax highlighting の bundle-size 評価と `@speed-highlight/core` 採用)・DR-0009 (Timeline の transcript レンダリング基盤)

## 記述規約 (attribution)

DR-0001 と同じ: **[kawaz 経由]** = team-lead セッションの委譲プロンプトに確定方針として記載 / **[提案]** = 本セッションでの実装時判断 / **[保留]** = 意図的に未決。

## Context

Timeline (DR-0009) のアシスタント発言は現在プレーンテキストで表示されている。team-lead セッションが以下を調査済みの確定方針として委譲した [kawaz 経由]:

- ライブラリは `@mizchi/markdown` (npm v0.6.5、MIT、exact pin)。`parse(src): mdast.Root` を使う
- `toHtml`/`toHtmlLiteral` は XSS 素通し実測済みのため使用禁止 (javascript: URL をそのまま HTML 文字列に埋め込む)
- mdast → preact JSX walker で描画、innerHTML/dangerouslySetInnerHTML は全面禁止 (DR-0005 の既存方針)
- URL スキーム許可リスト (http/https/mailto/相対パスのみ)、mdast の `type:"html"` ノードはエスケープ済みテキストとして表示 (実行しない)
- コードフェンスは既存の `@speed-highlight/core` パイプライン (highlight.ts、DR-0008 §6 follow-up) を流用
- 画像は外部フェッチせず alt + URL のリンク表示に留める (情報漏洩ベクタ回避)

## Decision

### 1. mdast walker を独立モジュールとして実装、`toHtml` 系 API は一切呼ばない [kawaz 経由]

`packages/webui/src/client/markdown-view.tsx` に `renderMarkdownAst(root: Root): VNode` (純粋な mdast → VNode 変換) と `MarkdownView({ source })` (parse + render の薄いラッパー) を実装。カバーする mdast node type は heading/paragraph/list/listItem/code/inlineCode/blockquote/table 系 (table/tableRow/tableCell)/link/image/strong/emphasis/delete/break/thematicBreak/html/text。未知の node type は `children` があれば再帰して情報を落とさず、無ければ何も描画しない安全フォールバック (DR-0009 の「jsonl フォーマット非固定を前提にした forward-compat フォールバック」と同型の設計)。

### 2. URL 許可リストは制御文字除去 + スキーム抽出で判定 [提案]

`isSafeUrl(url): boolean` を export。`http:`/`https:`/`mailto:` のみ許可、スキームなし (相対パス・`#fragment`) は許可、それ以外 (`javascript:`/`data:`/`vbscript:`/`file:` 等) は拒否。判定前に ASCII 制御文字 (制御文字全般、空白含む) を除去してからスキームを正規表現抽出する — ブラウザの URL パーサーがスキーム判定時に制御文字を無視する挙動に合わせたもので、`"java\tscript:alert(1)"` のような制御文字分割によるスキーム偽装 (=「スキームなし」への誤判定) を防ぐ。`//host/path` (protocol-relative) はスキームを明示しないが現在ページのスキームを継承するため、相対パスと同列の「安全」扱いにはせず拒否する。

安全でない URL を持つ `link`/`image` ノードは `<a href>`/画像リンクを一切生成せず、リンクテキスト (または alt) のみを表示する — 情報は落とさず実行可能な参照だけを外す。

### 3. `type:"html"` ノードは常にプレーンテキスト表示、パース・実行しない [kawaz 経由]

raw HTML の source テキストをそのまま JSX テキスト子要素として描画する。Preact の JSX テキストノードは自動エスケープされるため、`<script>` 等が DOM に注入されることはない。

### 4. コードフェンスは `CodeBlock` コンポーネントに委譲、fence の info-string を拡張子とみなして既存の `detectLanguage` テーブルへ通す [提案]

`packages/webui/src/client/components/CodeBlock.tsx` を新規実装。FileViewer.tsx と同じ「非同期 tokenize、完了まではプレーン表示」パターンを再利用する。fence の `lang` (例: `ts`, `py`) を検出済み拡張子マップにそのまま通す (`detectLanguage("_.${lang}")`) ことで、`EXTENSION_LANGUAGE_MAP` (highlight.ts) を二重管理せずに済む。未対応言語は plain フォールバック。

### 5. 画像は URL を自動フェッチせず、alt + リンク表示に留める [kawaz 経由]

`<img src=...>` を一切生成しない。安全な URL であれば alt テキストとその URL への `<a>` リンクとして表示し、ユーザが明示的にクリックした場合のみ画像へ到達する。理由: markdown 本文にリモート画像 URL を埋め込むだけで、レンダリングした瞬間に閲覧者の IP/UA が任意の第三者サーバへ到達する情報漏洩ベクタになり、この webui の CSP 制御範囲外の挙動になる。

### 6. Markdown レンダリングはアシスタント発言のみ、ユーザ発言はプレーンテキストのまま [提案]

Timeline.tsx の `SegmentView` で `segment.role === "assistant"` の場合のみ `MarkdownView` を通す。ユーザ発言は人間が実際にタイプした生テキストであり、markdown 構文として解釈すべき対象ではない (かつ既存のチャットバブルスタイル `tl-text-user` は維持する)。

## Bundle size (実測、DR-0004 のビルドレス方針への影響評価)

`GET /assets/app.js` (createWebuiApp 経由、serve-time bundle) を導入前後で実測 [提案]:

| | raw (bytes) | gzip (bytes) |
|---|---:|---:|
| 導入前 | 124,060 | 32,913 |
| 導入後 | 453,389 | 74,630 |
| 差分 | +329,329 | +41,717 (**+40.7 KB gz**) |

委譲時点の見積もり「+22KB gz」に対し、実測は **約 1.85 倍の +40.7KB gz** だった [提案、確定事実として記録]。差分の主因は `@mizchi/markdown` の `js/api.js` が import する MoonBit コンパイル済みパーサー本体 (`_build/js/release/build/api/api.js`、未 minify で 456KB) で、シンタックスハイライト用の言語別サブモジュール (`highlight_typescript.js` 等、`./highlight/*` サブパス) は `markdown-view.tsx`/`CodeBlock.tsx` のどちらからも import していないため tree-shaking で含まれていないことを確認済み。gzip 後で +40.7KB という実測値は、DR-0008 §6 follow-up が評価した prismjs (+8.8KB gz) / highlight.js (+18.6KB gz) の代替候補と比べても大きいが、markdown パースという別種の機能を追加している比較なので単純比較はできない。次点候補 (`marked`) や不採用候補 (`micromark`/`snarkdown`) は mdast 標準 AST を返さないか XSS 対策が別途必要になるため、サイズ差だけで再検討する判断はしていない。

## Alternatives considered

- **`toHtml()`/`toHtmlLiteral()` を使い、結果を `dangerouslySetInnerHTML` で描画**: 不採用。`javascript:` URL を含む link/image がエスケープされずそのまま HTML 文字列に出力されることを実測確認済み ([kawaz 経由])。XSS を作り込むことになる
- **`marked` (次点候補)**: 不採用 [kawaz 経由]。標準 mdast を返さず、この walker 実装の「mdast → JSX」という設計方針にそのまま乗せられない
- **`micromark`/`snarkdown` (不採用候補)**: 不採用 [kawaz 経由]。`micromark` は低レベル tokenizer で mdast への変換を別途組む必要があり実装コストが高い。`snarkdown` は HTML 文字列を返す薄い実装で、`toHtml()` 系と同じ XSS リスクを抱える
- **画像を `<img src>` で自動表示**: 不採用 (DR-0008 §2 の「webui から到達できる = kawaz 本人」という trust boundary と同種の判断)。画像 URL のレンダリング即座フェッチは、閲覧者側 (kawaz) の IP/UA を任意の第三者へ漏らす経路になる

## Consequences

- assistant 発言が見出し・リスト・コードブロック・テーブル・リンク等を伴う読みやすい形で表示される
- bundle サイズが gzip で約 +40.7KB 増加する (webui は DR-0004 §4 の「ビルドレス方針」を維持しつつ、serve-time bundle 自体のサイズは増える)。将来 bundle サイズが問題になった場合、markdown レンダリングを遅延 import (dynamic `import()`) にする余地がある (本 DR ではスコープ外、Next steps に記載)
- `type:"html"` ノード・安全でない URL は情報を残したまま無害化されるため、悪意のある transcript 内容 (例: hook 経由で注入された markdown) が閲覧者のブラウザ上でコードを実行することはない

## Next steps

1. dogfood: 実際の assistant transcript (コードブロック・テーブル・リンクを含むもの) で表示を確認 (kawaz)
2. bundle サイズが実運用上問題になった場合、markdown レンダリングパスの dynamic import 化を検討 (未着手、DR 化は問題が顕在化してから)
