# webui markdown パーサ比較 (乗り換え候補調査)

現状: `@mizchi/markdown` 0.6.5 の `parse()` で mdast を得て、自前 JSX renderer
(`packages/webui/src/client/markdown-view.tsx`、DR-0010) が mdast を歩いて Preact VNode を作る。
renderer が mdast を前提にしているため、**mdast を返すパーサかどうか**が乗り換えコストの分水嶺。

## 判明した事実

1. **`@mizchi/markdown` には CommonMark の必須機能の欠落と、リスト解析のデータ欠落バグがある** (実測)。
   - **link reference definition 非対応**: `See [foo].\n\n[foo]: https://example.com` が
     `paragraph(text)` 1 個になる。`definition` / `linkReference` ノードを一切生成しない。
   - **リスト項目の消失**: `- a\n\n  cont\n- b\n` をパースすると listItem が **1 個**しか出ない
     (`- b` が消える)。mdast-util-from-markdown は 2 個。
   - **inline HTML を `link` ノードとして誤生成**: `a <b>bold</b> c` が
     `paragraph(text,link,text,link,text)` になる (正しくは `html` ノード)。
   - **tab インデント非対応**: `- foo\n\tbar\n` が list + 別 paragraph に割れる (正しくは
     listItem 内の継続行)。CommonMark spec のタブ関連例が軒並みずれる。
   - **GFM autolink literal 非対応**: 裸の `https://example.com` が `link` にならない。
   - CommonMark spec (655 examples) の AST スケルトン比較で **344 件が
     mdast-util-from-markdown と不一致** (text ノードの分割粒度違いのような無害な差も含むが、
     上記の実バグを含む)。クラッシュは 0 件。
2. **`@mizchi/markdown` の `position.offset` は仕様が壊れている** (実測)。
   - inline ノードの offset が **listItem 内で 0 にリセット**される (文書絶対値でない)。
   - block ノードの end offset は末尾改行を含む (`# Head\n` → end 7、mdast は 6)。
   - offset が **UTF-16 単位でなくコードポイント単位** (astral 文字で mdast と 1 ずれる)。
     `markdown-task-list.ts` の冒頭コメントが記録している既知の罠そのもの。
   - mdast-util-from-markdown は line/column/offset を文書絶対・UTF-16 単位で正しく持つので、
     **乗り換えるとこの制約が消える** (task list のチェックボックス編集を位置ベースにできる)。
3. **`@mizchi/markdown` は事実上のパーソナルプロジェクト**: 週次 DL **42**、上流 repo
   [mizchi/markdown.mbt](https://github.com/mizchi/markdown.mbt) は star 99。
   MoonBit 実装で依存 0、直近リリース 0.6.5 (2026-07-03) と開発自体は活発。
4. **micromark / mdast-util 系は GitHub Advisory の登録がゼロ件** (実測: `GET /advisories?affects=<pkg>`)。
   対して marked は 18 件 (ReDoS / content injection / 2026-04 の OOM DoS を含む)、
   markdown-it は 4 件。ただし marked / markdown-it の CVE は主に HTML 出力と正規表現に起因し、
   本 app は AST しか使わない (renderer は `dangerouslySetInnerHTML` を使わない、DR-0010) ので
   XSS 面の直接影響は薄い。残るのは ReDoS / DoS 面。
5. **mdast を返すのは mdast-util-from-markdown / remark 系だけ**。markdown-it はフラットな token
   ストリーム、marked は独自 token ツリー、commonmark.js は独自 Node クラス。
   いずれも renderer の全面書き直し (1475 行) が要る。
6. **バンドルサイズは mizchi が最小、mdast 系は +10.7KB gz**。renderer が使う機能に絞った実測
   (`bun build --minify --target=browser` + `gzip -9`、webui 本番と同じ minify 設定):

   | 候補 | minified | gzip |
   |---|---:|---:|
   | @mizchi/markdown | 82.9KB | **20.3KB** |
   | mdast-util-from-markdown + mdast-util-gfm + micromark-extension-gfm | 112.4KB | **31.0KB** |
   | remark-parse + remark-gfm + unified | 142.8KB | 40.4KB |
   | markdown-it 15 | 114.3KB | 48.1KB |
   | marked 18 (Lexer のみ) | 42.3KB | **12.8KB** |
   | commonmark.js | 153.3KB | 48.7KB |

   注: 単体エントリの gzip 単独計測。実バンドルでは共有コードとの gzip 辞書共有で差が縮む。
   DR-0010 が記録する「+40.7KB gz」は本計測と方法が違う (全体バンドル差分) ため直接比較しない。
7. **パース速度はどれも実用上十分** (spec.txt 先頭 200KB、10 回平均):
   commonmark.js 4.0ms / markdown-it 5.5ms / @mizchi/markdown 49.5ms /
   mdast-util-from-markdown+gfm 122.3ms / marked `Lexer.lex` 2828ms (marked のみ桁違いに遅い。
   200KB の spec 文書は marked にとって病的入力の可能性があり参考値)。
   ccmsg のメッセージは通常数 KB なので、mdast 系の 122ms/200KB でも 1 メッセージあたり数ms 未満。
8. **`ccmsgDetails` とタスクリストは乗り換え後も動く** (実測)。`<details>` ブロックは両者とも
   `html | paragraph | html` に分解する (mdast 側は `value` に末尾改行を含まない差のみ)。
   `- [ ]` / `- [x]` の `listItem.checked` は **mdast-util-gfm を入れれば同じ** (素の
   mdast-util-from-markdown だと `checked` が付かないので gfm 拡張は必須)。

## 実用的な示唆 / 推し案

**推し: `mdast-util-from-markdown` + `mdast-util-gfm` + `micromark-extension-gfm` へ乗り換える**
(= remark の中身を unified を通さず直接使う)。

理由 (優先順):

1. **正確さ**。現行パーサは link reference definition 非対応・リスト項目消失・inline HTML の
   ノード種別誤りという、仕様準拠以前の欠落がある (事実 1)。micromark は CommonMark 100% 準拠を
   公称し、spec テストが CI に入っている実装。
2. **renderer 無改修**。返るのが本物の mdast なので `markdown-view.tsx` は原則そのまま。
   必要な追随は「`html` ノードの `value` の末尾改行差」「inline HTML が `link` でなく `html` で
   来るようになる (= 現行の誤りが直る)」「autolink literal で `link` が増える」程度で、
   すべて renderer の既存 case でカバー済み。`ccmsgDetails` 合成ロジックは parser 非依存。
3. **position が正しくなる**。`markdown-task-list.ts` が offset を信用できず内容マッチに逃げている
   制約 (事実 2) が解ける。将来的に位置ベースの編集へ寄せられる。
4. **セキュリティ履歴が最良**。advisory 0 件 (事実 4)。依存は多い (micromark-util-* 系が十数個) が
   すべて同一 collective 管理で、AST しか使わない本 app には HTML 出力面の攻撃面もない。
5. コストは **gzip +10.7KB** (事実 6)。DR-0010 が既に +40.7KB を許容している文脈では小さい。
   代わりに MoonBit コンパイル済み 456KB の未 minify パーサが消えるので、
   `Bun.build` の遅さ・Linux での EBADF flaky (`packages/webui/src/index.ts` のコメント参照) も
   改善する可能性がある (未検証)。

**採らない候補と理由**:

- **`@mizchi/markdown` 継続**: サイズ最小・依存 0 は魅力だが、事実 1・2 の欠落を自前で
  ワークアラウンドし続けるコストが上回る。週次 DL 42 = 実質単独メンテで、
  バグ報告から修正までの経路も細い。
- **remark (unified 経由)**: 中身は同じ micromark/mdast だが unified の runner が
  +9.4KB gz 乗るだけ。plugin エコシステムを使わない本 app には不要。
  将来 plugin が要るなら後から unified を被せられる。
- **markdown-it / marked / commonmark.js**: mdast を返さないので renderer 1475 行の全面書き直しが
  必須 (事実 5)。marked は advisory 18 件かつ本計測で唯一の性能異常あり。
  markdown-it はフラット token を木に戻す層を自作することになり、DR-0010 の設計 (AST を歩く) と噛み合わない。

**移行時の確認項目** (乗り換えるなら):

- `micromark-extension-gfm` + `mdast-util-gfm` を必ずセットで入れる (無しだと table / strikethrough /
  task list / footnote が出ない)。
- `packages/webui/test/markdown-task-list.test.ts` / `markdown-view.test.ts` には
  「@mizchi/markdown が受け付けない形」を仕様として固定したケースがある (例: 52 行目付近、
  1556 行目付近の `protectEmptyTableHeaderCells`)。パーサが正しくなると **これらが green のまま
  意味を失う / red になる**ので、テスト側の期待値を CommonMark 準拠に更新する作業が要る。
  ここが移行作業の主コストで、パーサ差し替え自体は import 3 行。
- `html` ノードの `value` 末尾改行差が `ccmsgDetails` 合成のマッチに影響しないか確認。

## 検証の詳細

### 計測環境

- 一時ディレクトリ `/private/tmp/mdbench` (リポ外) に bun で各候補を install し計測。リポは無改変。
- サイズ: `bun build <entry>.ts --minify --target=browser` → `gzip -9 -c | wc -c`。
  エントリは各ライブラリの「AST を返す最小 API」だけを import (marked は `Lexer.lex`、
  markdown-it は `md.parse`、commonmark は `new Parser().parse`)。
- 速度: CommonMark spec.txt 先頭 200,000 文字、warmup 3 回 + 10 回平均。
- 準拠度: [commonmark-spec/spec.txt](https://raw.githubusercontent.com/commonmark/commonmark-spec/master/spec.txt)
  から 655 example を抽出し、`@mizchi/markdown` と `mdast-util-from-markdown`(+gfm) の
  AST 型スケルトン (`type(children...)`) を文字列比較。

### npm / GitHub 指標 (2026-08-13 時点)

| 候補 | 週次 DL | latest | 最終リリース | GitHub star | 最終 push | license | 直接依存数 |
|---|---:|---|---|---:|---|---|---:|
| @mizchi/markdown | 42 | 0.6.5 | 2026-07-03 | 99 | 2026-07-28 | MIT | 0 |
| micromark | 51.5M | 4.0.2 | 2025-02-27 | 2203 | 2025-05-10 | MIT | 17 |
| mdast-util-from-markdown | 50.1M | 2.0.3 | 2026-02-21 | 287 | 2026-06-03 | MIT | 12 |
| mdast-util-gfm | — | 3.1.0 | 2025-02-10 | — | — | MIT | 7 |
| remark-parse | 46.6M | 11.0.0 | 2023-09-18 | 8975 (remark) | 2026-07-01 | MIT | 4 |
| markdown-it | 27.9M | 15.0.0 | 2026-07-30 | 21805 | 2026-08-13 | MIT | 6 |
| marked | 63.4M | 18.0.9 | 2026-08-04 | 37053 | 2026-08-11 | MIT | 0 |
| commonmark.js | 0.83M | 0.31.2 | 2024-09-19 | 1565 | 2026-07-18 | BSD-2 | 3 |

出典: `https://api.npmjs.org/downloads/point/last-week/<pkg>` (2026-08-03〜08-09)、
`https://registry.npmjs.org/<pkg>`、`https://api.github.com/repos/<owner>/<repo>`。
micromark 本体のリリース間隔が空いているのは停滞でなく安定によるもの
([unified collective](https://unifiedjs.com/) は 478 パッケージを継続管理、
[micromark repo](https://github.com/micromark/micromark))。
派生の mdast-util-from-markdown は 2026-02 にリリースがあり、repo push は 2026-06。

### セキュリティ advisory 件数 (GitHub Advisory Database, npm ecosystem)

| 候補 | 件数 | 直近 |
|---|---:|---|
| micromark / mdast-util-from-markdown / remark-parse / commonmark | 0 | — |
| markdown-it | 4 | GHSA-6v5v-wf23-fmfq (2026-06-15, medium, smartquotes の二次関数的計算量 DoS) |
| marked | 18 | GHSA-6v9c-7cg6-27q7 (2026-04-29, high, 無限再帰による OOM DoS) |

`@mizchi/markdown` は advisory 登録なし (= 利用者数から見て「報告が無い」であって
「監査されて安全」ではない点に注意)。

### AST 差分の具体例 (mizchi vs mdast)

| 入力 | @mizchi/markdown | mdast-util-from-markdown |
|---|---|---|
| `See [foo].\n\n[foo]: https://example.com "T"` | `root(paragraph(text))` | `root(paragraph(text,linkReference(text),text),definition)` |
| `visit https://example.com now` | `root(paragraph(text))` | `root(paragraph(text,link(text),text))` |
| `a <b>bold</b> c` | `root(paragraph(text,link(text),text,link(text),text))` | `root(paragraph(text,html,text,html,text))` |
| `- foo\n\tbar` | `root(list(listItem(paragraph)),paragraph)` | `root(list(listItem(paragraph)))` |
| `- a\n\n  cont\n- b` | list 項目 **1 個** | list 項目 2 個 |
| `-\t\tfoo` | `root(list(listItem(paragraph(text))))` | `root(list(listItem(code)))` |

一致するもの (乗り換えで変化しない): setext heading、hard break (行末 2 スペース)、
ネスト blockquote、tight/loose list の基本形、`![alt](url "title")`、
`<details>` ブロックの html 分解、GFM table / footnote / strikethrough、
`- [ ]` / `- [x]` の `listItem.checked`。

### loose/tight (`spread`) の差

| 入力 | mizchi (list/items) | mdast (list/items) |
|---|---|---|
| `- a\n- b` | false / false,false | false / false,false |
| `- a\n\n- b` | true / **true,true** | true / false,false |
| `- a\n\n  cont\n- b` | false / false (**項目 1 個**) | false / true,false |

CommonMark では `listItem.spread` は「その項目内のブロックが空行で区切られているか」で、
リストが loose でも各項目の spread は false になりうる。mizchi は list の loose を
項目にも伝播させており、mdast の定義と異なる。

## 参考

- [micromark](https://github.com/micromark/micromark) / [mdast-util-from-markdown](https://github.com/syntax-tree/mdast-util-from-markdown)
- [commonmark.js](https://github.com/commonmark/commonmark.js/)
- [markdown-it](https://github.com/markdown-it/markdown-it) / [marked](https://github.com/markedjs/marked)
- [mizchi/markdown.mbt](https://github.com/mizchi/markdown.mbt)
- [Best Markdown Parsing Libraries for JavaScript in 2026 (PkgPulse)](https://www.pkgpulse.com/guides/best-markdown-parsing-libraries-2026) /
  [marked vs remark vs markdown-it 2026 (PkgPulse)](https://www.pkgpulse.com/guides/marked-vs-remark-vs-markdown-it-parsers-2026)
  — 2026 時点で新興の CommonMark パーサは見当たらず、選択肢は上記に収束している。
