# 入力欄に貼られる HTML: クリップボードの中身・undo・変換の部品 (2026-11-25)

[DR-0065](../decisions/DR-0065-paste-html-as-markdown.md) の判断の元になった実測。ブラウザは Playwright 1.65.1 の Chromium 159 (headless shell)・WebKit 27.2 と、手元の Google Chrome 158 (headless、Playwright の channel chrome)。どのブラウザのクリップボードも OS のものと別であることを、何もコピーしていない状態の ⌘V で OS のクリップボードの中身 (hash で比べた) が届かないことで先に確かめ、コピーの前後で OS のクリップボードが変わらないことも確かめた。

## 判明した事実

### ⌘V と ⌘⇧V で paste イベントに届くもの

ページの copy イベントで text/plain と text/html を置いてから貼った。⌘⇧V は、Chrome の編集メニューの「ペーストしてスタイルを合わせる」と同じ編集コマンド `pasteAndMatchStyle` を、⇧⌘V のキーのイベントに付けて送った (Playwright は ⇧⌘V に編集コマンドを割り当てないので、検証用に複製した Playwright に足した)。

| ブラウザ | ⌘V の `types` | ⌘⇧V の `types` | beforeinput の inputType |
|---|---|---|---|
| Chromium 159 | text/plain, text/html | text/plain | どちらも insertFromPaste |
| Google Chrome 158 | text/plain, text/html | text/plain | どちらも insertFromPaste |
| WebKit 27.2 | text/html, text/plain | text/plain | どちらも insertFromPaste |

- 「スタイルを合わせて貼り付け」は、paste イベントの時点で text/html を外して届く。inputType では見分けられない

### 本物のブラウザ (kawaz の実測、貼り付けの試験用のページ)

段落・入れ子のリスト・番号のリスト・表・コードの見本をコピーして、textarea・input・contenteditable・contenteditable="plaintext-only" に貼った。

| ブラウザ | 貼り方 | `types` | keydown |
|---|---|---|---|
| Chrome 159 (macOS) | ⌘V | text/plain, text/html | ⌘ + V |
| Chrome 159 (macOS) | ⌘⇧V | text/plain | ⌘ + Shift + V (貼り付けの 6〜8ms 前) |
| Safari 26.6.3 (iOS 18.7) | 長押しのメニュー | text/html, text/plain | 来ない |

- Chrome は、同じクリップボードのまま ⌘⇧V と ⌘V を交互にすると、⌘V の時だけ text/html が届く
- beforeinput の inputType はどれも insertFromPaste。textarea・input では `data` に text/plain と同じ文字が入る
- Chrome の text/html は頭に `<meta charset='utf-8'>` が付く (`navigator.clipboard.read()` の text/html には付かない)。iPhone は `<!DOCTYPE html><head><meta charset="UTF-8"></head>` で、body 無しで要素が並ぶ
- どちらも、選択範囲の最上位の要素 (`p` / `ul` / `ol` / `table` / `pre`) と表のセルに算出済みの長い inline の style が付き、`a` / `strong` / `em` / `code` / `li` / 入れ子の `ul` には付かない。style の有無は意味の手掛かりにならない
- iPhone は inline の要素の前後の空白を `<span class="Apple-converted-space"> </span>` で包む (paste の getData では中身が普通の空白、contenteditable の beforeinput の dataTransfer では `&nbsp;`)。Playwright の WebKit のコピーも同じ形だった
- text/plain は、リストの印が落ち、表はタブ区切り、リンクは文言だけ

### textarea に文字を入れた時の ⌘Z / ⌘⇧Z

paste の handler で `preventDefault` してから、"ab" の a と b の間に文字を入れた。

| 入れ方 | Chromium の ⌘Z | WebKit の ⌘Z | ⌘⇧Z |
|---|---|---|---|
| ブラウザ自身の貼り付け | ab に戻る | 空に戻る (直前の入力とひとまとめ) | 貼った後に戻る |
| `execCommand("insertText")` (同期) | ab に戻る | 空に戻る | 貼った後に戻る |
| `execCommand("insertText")` (await の後) | ab に戻る | 空に戻る | 貼った後に戻る |
| `setRangeText` + input | 戻らない | 戻らない | WebKit で文字が重なって壊れる |
| `value` の書き換え | 戻らない | 戻らない | WebKit で文字が重なって壊れる |

- `execCommand("insertText")` は、await を挟んでもブラウザ自身の貼り付けと同じ undo になる
- Playwright の WebKit では、文字を打った後の ⌘Z は caret を動かしても打った分までまとめて戻る (挿入の方法に依らない)

### HTML を markdown にする部品

同じ fixture にかけ、minify した大きさを測った。

| 部品 | minify | gzip | 出力 |
|---|---|---|---|
| DOMParser + hast-util-from-dom + hast-util-to-mdast + mdast-util-to-markdown (+ gfm の toMarkdown) | 91KB | 30KB | GitHub の描画のコピーが元の markdown とほぼ同じ |
| rehype-parse (parse5) + rehype-remark + remark-gfm + remark-stringify | 317KB | 92KB | 上と 1 文字も違わない |
| turndown + @joplin/turndown-plugin-gfm | 18KB | 6.5KB | 既定では script と style の中身が出力に出る。`soft\_deny`・`\+` 等の escape が多く、強制改行は行末の空白 2 つ |

- 本家の turndown-plugin-gfm は 2018 年の 1.0.2 で止まっていて、更新があるのは fork
- 採った部品の出力は、happy-dom の DOMParser の上でも、Chromium・WebKit の上と 1 文字も違わなかった (fixture 10 個)

### コピー元ごとの text/html

- Chrome は mac で、クリップボードに RTF しか無い時 (Terminal 等) は、Cocoa の NSAttributedString の HTML 出力で text/html を作る (Chromium の `ui/base/clipboard/clipboard_mac.mm` の `ReadHTML`)。同じ変換で作った HTML は、1 行が 1 つの `<p>`、太字が `<b>`、連続した空白が `<span class="Apple-converted-space">`、タブが `<span class="Apple-tab-span">` だった
- VS Code の editor (Monaco) のコピーは、色付けの `span` と行ごとの `div` だけで、空の行は `<div><br></div>`。タブは HTML では空白に展開され、text/plain ではタブのまま
- WebKit のコピーは、要素の境目の空白を U+00A0 で書く。Chromium は普通の空白
- この webui の吹き出しのコピーは、リストの項目を tight でも `<p>` で包み、画像は `🖼 alt` のリンク (DR-0010 §5)、表の見出しの行は `tbody` の中の `th`

### entry の大きさ (minify、変更前 → 変更後)

webui の client を daemon と同じ設定 (minify・splitting) で build して測った。

| | v0.403.0 の上 | | v0.404.0 の上 | |
|---|---|---|---|---|
| | minify | gzip | minify | gzip |
| entry (変更前) | 862,751 | 275,643 | 864,763 | 276,085 |
| entry (変更後) | 865,564 (+2,813) | 277,361 (+1,718) | 867,565 (+2,802) | 277,952 (+1,867) |
| 変換の chunk (遅れて読む) | 58,137 | 18,867 | 58,137 | 18,867 |
| gfm の toMarkdown を拡張の package から使った時の entry | 882,343 (+19,592) | 282,467 (+6,824) | 測っていない | |

- entry の増え方の内訳 (v0.403.0 の上): 変換の chunk を空の stub にした時の entry は 864,215 (+1,464、貼り付けの handler・判定・CodeBlock の class)。残りの +1,349 は、chunk が entry と分け合う module を entry から export する分
- gfm の拡張の package (mdast-util-gfm-table / -strikethrough) は、最初の画面の markdown の読みが使う module と同じなので、toMarkdown 側を chunk から使うと mdast-util-to-markdown の handler 一式ごと entry に置かれた

## 実用的な示唆

- 「スタイルを合わせて貼り付け」を区別するのに、キーの修飾を覚えておく必要は無い (text/html が無いことで分かる)
- 段落・改行・太字の有無は、ターミナル (Cocoa 経由) やエディタのコピーと Web のコピーを分けられない。分けられるのはリンク・リスト・表・見出し・引用・コード・水平線・画像
- 最初の画面の bundle と同じ module を遅れて読む chunk から別の用途で使うと、その用途の依存まで entry に入る
