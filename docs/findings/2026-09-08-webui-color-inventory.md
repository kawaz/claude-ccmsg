# webui カラー全数棚卸し (2026-09-08)

対象: `packages/webui/src` 全体 (`public/app.css` 9381 行 + `client/**` の tsx/ts)。
目的は「色のハードコードを無くし、テーマカラー等いくつかの入力から全色を自動算出する」
方針のための現状把握。数値はすべて grep の実出力に基づく。

## 判明した事実

### 集計

| 指標 | 値 |
|---|---|
| app.css のユニーク hex リテラル | **80** (HTML 実体 `&#8635;` を除く) |
| うちトークン定義ブロック内 (`:root` / dark `:root` / `.stats-chart`) | 65 |
| うちトークン定義ブロック外 (= ハードコード) | 15 |
| トークン定義ブロック外の hex 出現行 | **28 行** (直接色 9 行 / `var(--x, #lit)` の fallback 19 行) |
| `rgba()` 出現 | 9 行 (すべて `0,0,0` か `255,255,255` の alpha。トークン化ゼロ) |
| `oklch()` 出現 | 34 (member-hue 24 / `.say` 琥珀 7 / md コード導出 3) |
| `color-mix()` 出現 | 34 |
| `:root` で定義される色系トークン | **32** (うち 2 つは色そのものでなく `--md-code-hue` / `--md-code-l-shift`) |
| dark で再定義される色系トークン | 29 (再定義しないのは `--splitter-grip` / `--md-surface` / `--md-code-hue` の 3 = いずれも導出 or 色相定数) |
| コンポーネント scope で導出宣言される md トークン | 11 (`--md-quote-bg` 等) |
| `.stats-chart` のグラフ系列トークン | 9 × 2 テーマ |
| tsx 側の色リテラル | `avatar.tsx` の `hsl()` 5 箇所、`terminal-gateway-store.ts` の `bg:%233b82f6` 1 箇所 |
| 定義が存在しないのに参照されている色変数 | **6** (`--muted` / `--ok` / `--err` / `--fg-error` / `--bg-secondary` / `--hover-bg`) |
| 定義済みだが参照ゼロのトークン | **1** (`--user-bg`、light/dark 両方に値あり) |

### トークン定義済みの色 (app.css `:root` / dark)

| トークン | light | dark | 役割 |
|---|---|---|---|
| `--bg` | `#ffffff` | `#16181d` | 地 |
| `--bg-alt` | `#f4f5f7` | `#1e2127` | 一段沈んだ地 |
| `--fg` | `#1a1d23` | `#e5e7eb` | 本文 |
| `--fg-muted` | `#6b7280` | `#9aa1ac` | 弱い文字 |
| `--fg-strong` | `#000000` | `#ffffff` | 本文より濃い文字 |
| `--border` | `#e2e4e9` | `#2b2f38` | 罫 |
| `--accent` | `#2563eb` | `#5b8dfd` | 押せる / リンク |
| `--accent-fg` | `#ffffff` | `#0b1020` | accent 上の文字 (24 箇所で参照) |
| `--danger` | `#dc2626` | `#f87171` | エラー |
| `--warn` | `#b45309` | `#fbbf24` | 警告 |
| `--user-bg` | `#eef2ff` | `#232a44` | **参照ゼロ (dead)** |
| `--user-bubble-bg` | `#dcf8c6` | `#1f4023` | ユーザ発話の吹き出し (緑) |
| `--peer-bubble-bg` | `#dbeafe` | `#1e3a5f` | 別セッション msg (青) |
| `--assistant-bubble-bg` | `#f3eefc` | `#2a2438` | 主セッションの応答 (紫) |
| `--assistant-bubble-border` | `#b79ae8` | `#6d55a3` | 同上の枠 (`.tl-direction-inbound` の色源も兼ねる) |
| `--agent-comm-bg` | `#f7f7fa` | `#202329` | エージェント間通信 |
| `--agent-comm-border` | `#a8acb8` | `#626875` | 同上の枠 |
| `--cache-ring` | `#22c55e` | `#4ade80` | prompt cache 残量の輪 (緑) |
| `--cache-keepalive-ring` | `#eab308` | `#facc15` | keepalive 延命中の輪 (黄) |
| `--splitter-grip` | `color-mix(in oklab, var(--border), var(--fg-muted) 45%)` | 同 (派生) | 掴む手掛かり |
| `--md-surface` | `var(--bg)` | 同 (派生) | md 装飾の基準面 |
| `--md-code-hue` | `55` | 同 | コードの色相 (数値) |
| `--md-code-l-shift` | `-0.09` | `0.1` | コードの明度差 (数値) |
| `--md-code-accent` | `#c2410c` | `#fdba74` | inline code の文字 |
| `--search-color-1` | `#ffea00` | `#fff200` | 検索語 1 |
| `--search-color-2` | `#57f287` | `#39ff14` | 検索語 2 |
| `--search-color-3` | `#00e5ff` | `#00e5ff` | 検索語 3 (**両テーマ同値**) |
| `--search-color-4` | `#ff5fd2` | `#ff4fd8` | 検索語 4 |
| `--search-color-5` | `#ff9f1c` | `#ff9f1c` | 検索語 5 (**両テーマ同値**) |
| `--search-color-6` | `#b97aff` | `#c77dff` | 検索語 6 |
| `--search-hl-fg` | `#000000` | `#000000` | ハイライト上の文字 (**両テーマ同値**) |
| `--search-current-color` | `#111827` | `#ffffff` | 現在ヒット |
| `--series-1`〜`-8`, `--series-other` | `#2a78d6` `#eb6834` `#1baf7a` `#eda100` `#e87ba4` `#008300` `#4a3aa7` `#e34948` `#898781` | `#3987e5` `#d95926` `#199e70` `#c98500` `#d55181` `#008300` `#9085e9` `#e66767` `#898781` | 使用量グラフの系列 (`.stats-chart` scope) |

導出トークン (component scope で宣言、`--md-surface` からの距離で持つ):
`--md-quote-bg` (4%) / `--md-quote-rule` (28%) / `--md-hr-rule` (22%) /
`--md-details-bg` (5%) / `--md-details-rule` (20%) / `--md-table-rule` (20%) /
`--md-table-head-bg` (8%) / `--md-inline-code-bg` / `--md-inline-code-rule` /
`--md-inline-code-fg` / `--md-block-code-bg`。前 7 つは `color-mix(in oklab, …)`、
code 系 3 つは `oklch(from var(--md-surface) …)` で色相を差し替える。

### 定義されていないのに参照されている変数 (= fallback リテラルが実効値)

`--muted` `--ok` `--err` `--fg-error` は app.css / client のどこにも定義がなく、
**fallback の生値が常に効いている = テーマ非依存**。

| 参照 | 実効値 | 箇所 |
|---|---|---|
| `var(--muted, #888)` | `#888` | `app.css:5476` `:5513` `:5518` `:5540` (`.tl-fold-trailing` / `.tl-agent-idle*`) |
| `var(--ok, #4a8)` | `#4a8` | `app.css:6937` (`.status-teammate-dot-active`) `:6999` (`.status-todo-icon-completed`) |
| `var(--err, #c55)` | `#c55` | `app.css:7105` (`.status-env-error`) |
| `var(--fg-error, #c33)` | `#c33` | `app.css:8016` (`.terminal-config-error`) |
| `var(--bg-secondary, var(--bg))` | `var(--bg)` | `app.css:1897` (色は正しく落ちる) |
| `var(--hover-bg, var(--border))` | `var(--border)` | `app.css:2120` `:2861` (同上) |

逆に、**定義済みトークンに付いた死んだ fallback** (到達しない生値) が 12 箇所ある:
`var(--danger, #c33)` ×3 (`:2815` `:2816` `:2856`)、`var(--warn, #ba5)` ×3
(`:6941` `:7002` `:7016`)、`var(--accent, #48a)` (`:6944`)、`var(--bg-alt, #eef)` /
`var(--border, #ccd)` (`:7037` `:7038`)、`var(--bg, #fff)` (`:7207`)、
`var(--fg-muted, #888)` (`:4600`)、`var(--accent, #4a9eff)` (`:7893`)。

## 実用的な示唆

1. **「入力から全色を算出する」の障害は生 hex ではなく、そもそも役割トークンが無い色**。
   直接ハードコードは 9 行しかない (下表) が、そのどれもが「success」「waiting」
   「overlay」「shadow」といった**トークンが存在しない役割**を埋めるために書かれている。
   算出方式に移す前に、まず役割の空欄 (`--success` / `--info` / `--overlay` /
   `--shadow-*`) を作る側の作業が要る。
2. **緑 4 種・琥珀 5 種・赤 4 種が別の場所で別の値で持たれている** (次節の重複)。
   状態色を 1 系統に寄せれば、テーマカラー + 状態色の hue 数点が入力になる。
3. **`--muted` / `--ok` / `--err` / `--fg-error` は定義が存在しない**ので、
   ダークテーマで `#888` `#4a8` `#c55` `#c33` がそのまま出ている。
   自動算出の前に、この 4 つは既存トークンへ寄せるか正式に定義するかの判断が要る。
4. **seed 由来の色が 2 つの色空間に分裂している**。`avatar.tsx` は
   `hsl(h 65% 45%)` / `hsl(h 55% 92%)` (S/L 固定 = テーマ非依存)、
   吹き出しは `oklch(0.96 0.03 h)` / dark `oklch(0.24 0.025 h)`。
   同じ `hueForSeed()` の出力を使いながら、明度の持ち方が別。
   算出方式に一本化するなら、この 2 つを同じ式から出すのが自然に見える。
5. **md 装飾だけは既に「面からの距離」で算出済み** (`--md-surface` + `color-mix` /
   `oklch(from …)`)。ここが方針のモデルケースで、`.say` / member-hue / 状態色は
   まだ絶対値。同じ考え方を広げる余地がそのまま残っている。

### トークン外の直接ハードコード (9 行)

| 場所 | 値 | 用途 | テーマ |
|---|---|---|---|
| `app.css:359` `.status-ok` | `#16a34a` | 成功の文字色 | 共通 (dark 上書きなし) |
| `app.css:1018` `.session-live-dot-waiting` | `#d29922` | 待機ドット | 共通 |
| `app.css:4132`-`4135` `.viewer-image` | `#ccc` ×4 | 透過確認の市松 | 共通 |
| `app.css:5681` `.tl-diff-add` | `#2da44e` (18% 混色) | diff 追加行の地 | 共通 |
| `app.css:6747` `.one-on-one-error` | `#d0324c` | エラー文言 | 共通 |
| `app.css:7497` `.image-lightbox-close` | `#fff` | overlay 上の × | 共通 |

### rgba() (9 行、すべてトークン化なし・テーマ非依存)

| 値 | 箇所 | 用途 |
|---|---|---|
| `rgba(0,0,0,0.2)` | `:4753` `.tl-msg-menu` / `:5125` `.md-sec-menu` / `:6509` `.room-composer-fab` / `:7364` `.tl-auto-open` | 影 |
| `rgba(0,0,0,0.25)` | `:6584` `.one-on-one-panel` / `:6634` `.room-composer-panel` | 影 (パネル) |
| `rgba(0,0,0,0.15)` | `:7268` `.tl-auto-open-handle` | 影 (小) |
| `rgba(0,0,0,0.85)` | `:7475` `.image-lightbox` | overlay の暗幕 |
| `rgba(255,255,255,0.15)` | `:7496` `.image-lightbox-close` | overlay 上のボタン地 |

### 気になった重複・不整合

| # | 内容 |
|---|---|
| 1 | **緑が 4 系統**: `--cache-ring` `#22c55e`、`.status-ok` `#16a34a`、`.tl-diff-add` `#2da44e`、`--search-color-2` `#57f287`。`--success` トークンが無いため、成功系が 3 箇所で別々に決まっている |
| 2 | **琥珀/黄が 5 系統**: `--warn` `#b45309`、`--cache-keepalive-ring` `#eab308`、`.session-live-dot-waiting` `#d29922`、`.say` の `oklch(… 80)` 7 箇所、`--series-4` `#eda100` |
| 3 | **赤が 4 系統**: `--danger` `#dc2626`、`.one-on-one-error` `#d0324c`、fallback `#c33` / `#c55`、`--series-8` `#e34948` |
| 4 | **member-hue の oklch 4 値 (`0.96 0.03` / `0.24 0.025` / `0.65 0.15` / `0.65 0.12`) が 4 セレクタ × light/dark = 24 箇所にベタ書き**。1 箇所値を変えると他 3 箇所が置き去りになる形 |
| 5 | **`.say` の琥珀が `oklch(… 80)` で 7 箇所ベタ書き** (`:2602` `:2603` `:2607` `:2612` `:2613` `:2616` `:2649`)。色相 80 に名前が無い |
| 6 | **`--user-bg` は light/dark 両方に値があるのに参照ゼロ** (dead token) |
| 7 | **fallback 付き `var()` が 2 種類混在**: 実効値になる fallback (定義なし変数、6 箇所) と、絶対に到達しない死んだ fallback (12 箇所) が見分けなく並んでいる |

## 検証の詳細

### 抽出コマンド

```
grep -nEi '#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|oklch\(|oklab\(|color-mix\(|\b(white|black|transparent|currentColor)\b' \
  packages/webui/src/public/app.css packages/webui/src/client -r
```

`white-space` / HTML 実体 (`&#8635;` 等) / コメント中の言及は除外して数えた。
`var(--x` の全参照と `--x:` の全定義を突き合わせて未定義変数を割り出した。

### color-mix() の全 34 箇所

| 行 | セレクタ / トークン | 式 |
|---|---|---|
| 39 | `--splitter-grip` | `oklab, --border, --fg-muted 45%` |
| 1556 | `.session-search-hit.active .session-search-hit-main` | `srgb, --accent 12%, --bg-alt` |
| 3833 | keyframe 55% | `srgb, --danger 28%, transparent` |
| 3914 | `.md-toc a:hover` | `srgb, --accent 10%, transparent` |
| 4165 | `.viewer-line-selected` | `srgb, --accent 18%, transparent` |
| 4612 | `.tl-bubble-user-nav-selected .tl-bubble-body` | `srgb, --accent 70%, transparent` |
| 4618 | 同 (box-shadow) | `srgb, --accent 35%, transparent` |
| 4647 | `.tl-api-error` | `srgb, --danger 10%, transparent` |
| 4884 | `.viewer-preview .md h1` | `srgb, --fg 45%, --border` |
| 4996 / 4997 | `--md-quote-bg` / `--md-quote-rule` | `oklab, --md-surface, --fg 4% / 28%` |
| 5019 | `--md-hr-rule` | `oklab, --md-surface, --fg 22%` |
| 5144 | `.md-sec-menu > button:hover` | `oklab, --bg-alt, --fg 10%` |
| 5187 / 5188 | `--md-details-bg` / `--md-details-rule` | `oklab, --md-surface, --fg 5% / 20%` |
| 5256 | `--md-inline-code-fg` | `oklab, --fg-strong, --md-code-accent 30%` |
| 5315 / 5323 | `--md-table-rule` / `--md-table-head-bg` | `oklab, --md-surface, --fg 20% / 8%` |
| 5404 | `.viewer-preview` の quote 罫 | `srgb, --accent 45%, --border` |
| 5559-5561 | `.tl-direction-outbound` | `srgb, --accent 80%/16%/65%` |
| 5565-5567 | `.tl-direction-inbound` | `srgb, --assistant-bubble-border 75%/18%/70%` |
| 5676 | `.tl-diff-delete` | `srgb, --danger 16%, transparent` |
| 5681 | `.tl-diff-add` | `srgb, **#2da44e** 18%, transparent` |
| 5737 / 6150 | `.tl-bash-output.is-error` / `.tl-bashrun-out.is-error` | `srgb, --danger 10%, transparent` |
| 5903 | `.tl-ccmsg-*` の focus outline | `srgb, --accent 70%, transparent` |
| 7261 | `.tl-auto-open-handle` | `srgb, --fg 18%, --bg-alt` |
| 7600 / 7602 | `.search-bar-chip` | `srgb, --chip-color(inline) 45%/25%, --border/--bg-alt` |
| 7893 | `.agent-tree-row-current` | `srgb, --accent(fallback #4a9eff) 14%, transparent` |

### oklch() の全 34 箇所

| 用途 | 行 | 値 |
|---|---|---|
| member-hue の吹き出し / msg 行 (light) | 2506-2509, 5863-5864, 5919-5922, 6011-6012 | 地 `0.96 0.03 h`、罫 `0.65 0.15 h` |
| 同 (dark) | 2513-2516, 5868-5869, 5926-5929, 6016-6017 | 地 `0.24 0.025 h`、罫 `0.65 0.12 h` |
| `.say` 琥珀 (light) | 2602, 2603, 2607, 2649 | `0.96 0.03 80` / `0.75 0.05 80` / `0.7 0.16 80` |
| `.say` 琥珀 (dark) | 2612, 2613, 2616 | `0.24 0.025 80` / `0.45 0.05 80` / `0.72 0.14 80` |
| md コード導出 | 5250, 5253, 5271 | `oklch(from var(--md-surface) calc(l + --md-code-l-shift × 1 / 2.4 / 0.4) 0.06 / 0.12 / 0.025 var(--md-code-hue))` |

`--member-hue` を注入している箇所: `TimelineItem.tsx:126`、`Timeline.tsx:906` `:2676`、
`CatalogView.tsx:646` `:663`、`CatalogMdColors.tsx:168`。値は `hueForSeed()`
(`avatar.tsx:51`、FNV-1a → mulberry32 → 0-359) の出力。

### tsx / ts 側の色

| 場所 | 値 | 用途 | テーマ |
|---|---|---|---|
| `client/avatar.tsx:73` | `hsl(${hue} 65% 45%)` | identicon の前景 | **非依存** |
| `client/avatar.tsx:74` | `hsl(${hue} 55% 92%)` | identicon の地 | **非依存** (dark でも明度 92%) |
| `client/avatar.tsx:122` | `hsl(210 20% 88%)` | UserAvatar の地 | 非依存 |
| `client/avatar.tsx:123` `:124` | `hsl(210 25% 45%)` ×2 | UserAvatar の人型 | 非依存 |
| `client/terminal-gateway-store.ts:41` | `bg:%233b82f6` (= `#3b82f6`) | hyoui embed の fab 色を URL query で渡す。ccmsg の `--accent` と同系青を**手で合わせた**値 | 非依存 |
| `client/components/CatalogMdColors.tsx:271` `:273` | `#010203` | canvas が色解決可能かのプローブ用センチネル (UI 色ではない) | — |
| `client/components/FileIcon.tsx:74` | `currentColor` | アイコン stroke (行の文字色に追従) | 追従 |
| `client/markdown-view.tsx:560`, `SessionSearchPanel.tsx:150` | `--hl-color: var(--search-color-N)` | 検索ハイライトの色選択 (トークン参照のみ) | 追従 |
| `client/components/SearchBar.tsx:241` | `--chip-color: var(--search-color-N)` | 検索チップ (トークン参照のみ) | 追従 |

### シンタックスハイライト (Shiki)

`client/highlight.ts` が `github-light` / `github-dark` の 2 テーマを読み、トークンごとに
`--shiki-light` / `--shiki-dark` (+ `-font-style` / `-font-weight` /
`-text-decoration`) をインライン style で吐く。`app.css:4186-4196` の `.shiki-tok` が
`prefers-color-scheme` で light/dark を切り替える。**色数は Shiki テーマ側が持つ**ため
webui のソースには 1 つも現れず、テーマカラーからの算出対象にもならない (外部依存)。

### ターミナル

ターミナルは hyoui gateway への iframe embed で、ANSI パレットは webui 側に存在しない
(`grep -i '\bansi\b' client` のヒットは `transcript-model.ts` の ANSI エスケープ
**除去**正規表現のみ)。webui が渡す色は上表の `bg:%233b82f6` 1 つだけ。

### 意味役割での再グルーピング (所見)

| 役割 | 現状の持ち主 | 何から導けそうか (所見) |
|---|---|---|
| 地 / 一段沈んだ地 / 罫 / 本文 / 弱い文字 / 濃い文字 | `--bg` `--bg-alt` `--border` `--fg` `--fg-muted` `--fg-strong` | 中性色 1 本 (地の明度) + テーマ極性。既に md 装飾が `color-mix(面, --fg N%)` で同じことをしている |
| アクセント (押せる / リンク / 選択) | `--accent` `--accent-fg` + `color-mix(--accent N%)` 10 箇所 | テーマカラー 1 色。混色比 (10/12/14/16/18/35/45/70/80%) は既に相対で持てている |
| 状態: エラー | `--danger`、`#d0324c`、`#c33` / `#c55` | 状態色 (赤) 1 本に寄せられそう |
| 状態: 警告 | `--warn`、`#d29922`、`#ba5` | 状態色 (琥珀) 1 本 |
| 状態: 成功 | **トークン無し** — `#16a34a` `#2da44e` `#4a8` `--cache-ring` | 状態色 (緑) 1 本を新設すれば 4 箇所が畳める |
| 状態: 情報 | **トークン無し** — `#48a` (`--accent` fallback) | アクセントで代用可能に見える |
| 資源メーター | `--cache-ring` (緑) / `--cache-keepalive-ring` (黄) | 状態色の緑/琥珀と同源にできるか、意味が別 (残量 vs 警告) として分けるかは設計判断 |
| 発話者の面 (吹き出し) | `--user-bubble-bg` (緑) / `--peer-bubble-bg` (青) / `--assistant-bubble-bg` `--assistant-bubble-border` (紫) / `--agent-comm-*` (無彩色) / `.say` (琥珀 hue 80) | 「発話者カテゴリ → hue、テーマ → L/C」の 2 入力で全部書けそう。member-hue の oklch が既にその形 (L/C 固定 + hue 可変) |
| seed 由来の識別色 (avatar / member-hue) | `hueForSeed()` → `hsl()` (avatar) と `oklch()` (吹き出し) の 2 系統 | hue 1 入力 + テーマ別 L/C。現状は色空間が割れているので統一が前提 |
| 検索ハイライト 6 色 | `--search-color-1`〜`6` + `--search-hl-fg` `--search-current-color` | 高彩度が要件なので中性色からは導けない。hue を 6 等分 + テーマ別 L/C なら算出可能に見える |
| グラフ系列 9 色 | `--series-1`〜`8` `--series-other` | dataviz パレットとして light/dark 個別に選定済み (自動反転を明示的に避けたとコメントあり)。算出の対象外に置くのが素直 |
| 影 / overlay | `rgba(0,0,0,α)` ×7、`rgba(0,0,0,0.85)`、`rgba(255,255,255,0.15)` | テーマの地の明度から導出可能。現状トークンが 1 つも無い |
| md 装飾 | `--md-surface` からの距離 (11 トークン) | **既に算出済み**。テーマ入力の追加は不要 |
| シンタックスハイライト | Shiki の 2 テーマ | 外部依存。算出対象外 |

## jj status

```
Working copy changes:
A docs/findings/2026-09-08-webui-color-inventory.md
Working copy  (@) : tpzwluwu 850bc18b (no description set)
Parent commit (@-): vuqxzqnl 6bc0722a main | docs(findings): Claude Code の cross-session messaging socket の静的解析 (ccmsg の配送経路候補、実機送信は未確認)
```
