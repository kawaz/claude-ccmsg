# 翻訳文の英数字と和文の間に CSS `text-autospace` が効くか

- Date: 2026-11-06
- 動機: PLaMo の訳文は英数字と和文の間に空白が入らず詰まって読みにくい。JS の後処理でなく CSS で解決できるかを実機で確かめる
- 方法: 1 文「これはTypeScriptで書かれた2026年のAPIです」を `white-space: nowrap` の `span` で描き、プロパティありとなしで `getBoundingClientRect().width` を測った (playwright-core から起動、フォントは既定の sans-serif)。`text-spacing-trim` は「（括弧）「かぎ」、。」の幅で見た

## 実機の結果 (観測)

| ブラウザ | 版 | `text-autospace: normal` の幅 (なし → あり) | `text-spacing-trim` の幅 (`space-all` / `normal` / `trim-start`) |
|---|---|---|---|
| Chromium (Chrome for Testing) | 153 | 411.2 → 426.2 px (+15 px、英数と和文の境界 6 か所) | 200 / 170 / 160 px (実装あり。初期値 `normal` で既に詰めている) |
| WebKit (playwright) | Safari 26.6 相当 | 411.2 → 426.2 px (+15 px) | 未対応 (`CSS.supports` が false) |
| Firefox | 手元の playwright 同梱版は 131 | 未計測 | 未計測 |

- `display: contents` の `span` に `text-autospace: normal` を当てても、中の要素に継承されて同じ +15 px になる (Chromium / WebKit で確認)。訳文を包む要素を layout に影響させずに使える
- Firefox: 手元の Firefox は playwright-core の現行版と protocol が合わず (`Browser.setDefaultViewport` で失敗)、計測できなかった。MDN の `text-autospace` ページは「Baseline 2025 Newly available (2025-11 から主要ブラウザの最新版で動く)」と記す。ここでは実機で確認していない

## 公式の対応状況 (MDN、2026-11-06 に 1 回読んだ)

- `text-autospace`: Baseline 2025 Newly available。ブラウザごとの版の表は動的描画で取れなかった
- `text-spacing-trim`: Baseline ではない (Limited availability)。実装は Chromium のみ、`normal` / `space-all` / `space-first` / `trim-start` の 4 値。フォントに `halt` か `chws` が要る

## 判断

- 訳文の要素に `text-autospace: normal` を当てる。Chrome と Safari の最新で効くことを実機で確認した (対象ブラウザは最新の Chrome と Safari)
- `text-spacing-trim` は当てない。初期値の `normal` が Chromium で既に約物を詰めており、Safari は未対応で、当てても何も変わらない
- 効かないブラウザでは詰まったまま許容する。JS で空白を差し込む後処理は採らない
