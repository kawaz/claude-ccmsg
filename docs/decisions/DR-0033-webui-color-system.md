# DR-0033: webui カラーシステム (少数の入力から全色を導出する 3 層構造 + テーマエディタ)

Status: Proposed
Date: 2026-09-08
Sponsor: kawaz r280m1「色のハードコードが嫌い。テーマカラーと数個の色を選んだらあとは全色が自動算出されて欲しい」、r280m6「決めることは少なくしたい。選べる部分はカラーピッカーで調整し、テーマをガラッと入れ替えて見比べたい。動いている画面を見たまま触れるフローティングなツール」
関連: DR-0031 (トークンとカタログ。本 DR は §3 の色トークンを置換する)、`docs/design/design-tokens.md` (規約の正本、本 DR の Accepted で色の節を書き換える)、`docs/findings/2026-09-08-webui-color-inventory.md` (現状の棚卸し)、`docs/research/2026-09-08-color-theme-derivation.md` (手法調査)

## 1. 背景

棚卸し (findings) で分かった現状:

- app.css に hex 80 種。うちトークン定義ブロック外の生値が 15 種、`rgba()` の影 / overlay 9 箇所はトークンなし
- `--muted` / `--ok` / `--err` / `--fg-error` は定義が無く、`var(--ok, #4a8)` の fallback がテーマ非依存で常に効いている (8 箇所)。逆に定義済みトークンに死んだ fallback が 12 箇所あり両者を見分けられない
- 「成功」の役割トークンが無いため緑が 4 系統、琥珀 5 系統、赤 4 系統に分裂
- member 色の oklch 定数 (`0.96 0.03` 等) が 24 箇所にベタ書き、`.say` の色相 80 が 7 箇所に無名で散在
- avatar は `hsl()`、吹き出しは `oklch()` と、同じ seed から派生する色の色空間が割れている
- markdown 装飾 (11 トークン) だけは `--md-surface` からの距離で導出済みで、「入力から算出」の先行例

根本の問題は生値の多さではなく**役割 (semantic) の語彙表が無いこと**。語彙が無いのでコンポーネントごとに値を発明し、テーマ側もそれを追えない。

## 2. 決定

### 2.1 3 層構造

```
層 0  入力 (theme input)   brand h / neutral tint / 状態色 h ×4 / 固定スロット h ×2 / light|dark
         │  段表 (§4) × ガマット制約で機械的に展開
層 1  段 (scale)           --<hue>-1 … --<hue>-12   (hue = gray | brand | success | warn | error | info | self | user)
         │  役割ごとに段番号を固定 (§4 の表)
層 2  意味名 (semantic)    --bg / --bg-hover / --border / --fg-muted / --accent / --fg-error …
         │
コンポーネント CSS         意味名だけを参照する。層 1 を直接参照しない (§5)
```

- 層 1 は 1 色相につき 12 段。**段番号と役割の対応を全色相で共有する** (Radix Colors の考え方)。`--gray-9` と `--error-9` は同じ役割 (solid 背景) なので、「エラー時は gray を error に差し替える」が段番号を変えずにできる
- 層 2 の意味名は §5 の語彙で閉じる。新しい意味名は本 DR (または design-tokens.md) の語彙表に追加してから使う
- 「色を決める」作業は層 0 の入力を選ぶことだけ。段表 (L / C の設計値) はテーマエディタから触らせない (コントラスト保証を構造に閉じ込める)

### 2.2 算出は CSS ネイティブ (相対色構文) で行う

層 0 → 層 1 の展開は app.css 内の相対色構文で書く:

```css
--brand-3: oklch(from var(--brand) var(--l-3) calc(c * var(--c-3)) h);
```

- 入力 (`--brand` 等) を JS が `:root` に書き換えるだけで全段が再計算される。テーマエディタ (§7) の実装が「入力変数を書く」だけになる
- 相対色構文は本リポで既に運用実績がある (`--md-code-*` が `oklch(from var(--md-surface) …)` を使い、kawaz の主環境 iPad Safari / PC Chrome で表示できている)。`@property` も Safari 16.4+ 前提でフォールバックなし (app.css 8867 行目) と同じ線
- research は「ビルド時生成 (Bun + culori) を正本、CSS 導出は局所関係のみ」を第一候補にし、実行時編集が必須なら「ブラウザ上の同じ generator で検証してから適用」を候補に挙げている。本 DR がそれを採らないのは、テーマエディタ (§7) で実行時編集が要件であり、ビルド時生成は成立しないため。残る比較は「CSS 相対色」対「ブラウザ内 JS generator」で、後者の利点 (ガマットマッピングの制御、全組み合わせのコントラスト検査、条件を満たすまでの L/C 探索) のうち、検査は CSS 導出のままでも別途できる (下記)。生成物を `:root` に流し込む構成は app.css が値の列挙になり「CSS を読めばテーマが分かる」性質を失うので、探索が本当に必要になるまで採らない
- **ガマット**: CSS Color 4 の oklch → sRGB 変換は L と h を保って C を下げる方式で、research が推奨する方針と同じ。§4.3 の C 係数表は最初からこの範囲に収めることを狙い、濁る色相が実測で出た場合はその色相の上限係数を落とす
- **コントラスト検査**: OKLCH の L 差は階調設計の近似であってコントラスト保証ではない (WCAG 2 は最終 sRGB 色の相対輝度で決まる)。検査は CSS の式ではなく、カタログ / テーマエディタが `getComputedStyle` で解決済みの最終色を読んで WCAG 2 比を表示する形で行う (意味名の bg/fg の対 = §5 の表の組み合わせ)。閾値未満は警告として見せ、入力を直すのは人。playwright の visual 検証にも同じ読み取りを組み込む

### 2.3 light / dark

段表は light 用と dark 用の 2 組を持ち、番号と役割は同じ。切替は現行の `@media (prefers-color-scheme: dark)` を維持しつつ、テーマエディタで強制切替できるよう `:root[data-theme="light|dark"]` を優先させる (DR-0031 のカタログが light / dark を並べて見る用途にも使う)。

## 3. 層 0: 入力

| 入力 | 型 | 既定 | 備考 |
|---|---|---|---|
| `--brand` | oklch 色 | 現 `--accent` (#2563eb) 相当 | accent / focus / link / 選択の色相元 |
| `--neutral-tint` | 0〜0.03 | 0.01 | gray 段に brand の h を薄く乗せる C |
| `--hue-success` / `--hue-warn` / `--hue-error` / `--hue-info` | h (deg) | 145 / 80 / 27 / 250 | 慣習値。info は brand から独立した入力として持つ (brand は青に固定しない、kawaz r280m17。既定 brand が青のうちは info と近いが、brand を変えれば自然に分かれる) |
| `--hue-self` / `--hue-user` | h | 紫 (現 assistant-bubble 系) / 緑 (現 user-bubble 系) | 固定スロット (§6)。user は success と同 h・別段でよい (kawaz r280m9) |
| light / dark | 切替 | OS 設定 | §2.3 |

入力は 8 個。テーマ (プリセット) はこの 8 個の組を JSON で持つ。

## 4. 層 1: 段表

### 4.1 段番号と役割 (全色相共通)

| 段 | 役割 | 典型の用途 |
|---|---|---|
| 1 | アプリ背景 | ページの地 |
| 2 | 控えめな背景 | サイドバー、カード地、thinking の地 |
| 3 | 部品の背景 | 入力欄、通常の吹き出し |
| 4 | 部品の背景 (hover) | |
| 5 | 部品の背景 (active / selected) | |
| 6 | 控えめな境界 | 区切り線 |
| 7 | 部品の境界 | 入力欄の枠、吹き出しの枠 |
| 8 | 部品の境界 (hover / focus) | |
| 9 | solid 背景 | 塗りボタン、バッジ、say / エラーの吹き出し (§6.2)、`--cache-ring` |
| 10 | solid 背景 (hover) | |
| 11 | 控えめな文字 | 補助テキスト、状態表示の文字 (1〜5 の上に載せる) |
| 12 | 強い文字 | 本文、見出し |

### 4.2 L の設計値 (暫定、実装時に現行トークンを基準に実測調整)

| 段 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| light | .995 | .98 | .955 | .93 | .90 | .86 | .80 | .72 | .60 | .55 | .48 | .22 |
| dark | .18 | .21 | .25 | .29 | .33 | .38 | .45 | .55 | .62 | .67 | .78 | .95 |

- 1〜5 は背景同士なので差を小さく、5→6・8→9 で飛ぶ、11 / 12 は 1〜5 の上で文字コントラストを満たす L に置く (目安として 12 と 1〜3 の L 差 ≥ 0.7、11 と 1〜3 の差 ≥ 0.45。合否は §2.2 の最終色検査で見る)
- 現行の `--bg` #fff / `--fg` #1a1d23 / `--fg-muted` #6b7280 が段 1 / 12 / 11 に、dark の #16181d / #e5e7eb / #9aa1ac が同じく対応するよう、実装時に上表を寄せる

### 4.3 C の係数 (入力の C に掛ける)

段 9 を頂点にした山型。gray は `--neutral-tint` を全段に一定で掛ける。

| 段 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 係数 | .05 | .1 | .2 | .3 | .4 | .5 | .65 | .8 | 1 | 1 | .8 | .5 |

dark は全段に ×0.85 (鮮やかすぎると浮く)。黄〜琥珀 (h 70〜100) は暗い段で sRGB 外に出やすいので、実測で濁る場合は色相ごとの上限係数を design-tokens.md に記録して落とす。

## 5. 層 2: 意味名の語彙

命名は `<役割>[-<状態>]`、状態は `hover | active | selected | disabled` の 4 つに閉じる。色相付きは `<役割>-<色相名>`。

| 意味名 | 段 | 現行トークンとの対応 |
|---|---|---|
| `--bg` / `--bg-alt` | gray-1 / gray-2 | 同名 |
| `--surface` / `--surface-hover` / `--surface-active` | gray-3 / 4 / 5 | (新設、入力欄・行の hover) |
| `--border` / `--border-strong` / `--border-focus` | gray-6 / 7 / 8 | `--border` |
| `--fg` / `--fg-muted` / `--fg-strong` | gray-12 / 11 / (12 を L 側にさらに寄せた式) | 同名 |
| `--accent` / `--accent-hover` / `--accent-fg` | brand-9 / 10 / (9 の上の文字 = white or gray-1) | 同名 |
| `--accent-surface` / `--accent-border` / `--accent-fg-muted` | brand-3 / 7 / 11 | (新設、選択行・リンク) |
| `--<status>` / `--<status>-surface` / `--<status>-border` / `--fg-<status>` | `<status>`-9 / 3 / 7 / 11 | status = success / warn / error / info。`--danger` → `--error`、`--warn` は同名、`--ok` / `--err` / `--fg-error` の未定義参照はここで解消 |
| `--overlay` / `--shadow` | gray-12 の alpha (`oklch(from var(--gray-12) l c h / 25%)` 等) | (新設、`rgba(0,0,0,…)` 9 箇所を吸収) |
| `--md-surface` 系 | 変更なし (面からの距離で導出、design-tokens.md の既存節) | `--md-code-hue` は `--hue-warn` 近傍の別名にするか実装時に判断 |

吹き出しの色は §6 の関数で作るため、`--user-bubble-bg` / `--peer-bubble-bg` / `--assistant-bubble-*` / `--agent-comm-*` は §6 の出力に置換する。`--user-bg` (参照ゼロ) は削除。

## 6. member 色 (吹き出し・avatar)

### 6.1 identity = h、それ以外は共通の段表

member 色は「h を段表に通す関数」として持つ。avatar・吹き出し・左ボーダーは同じ h から段を変えて取る (avatar の `hsl()` 直書きはこれに置換):

```css
.bubble { --h: var(--member-hue);
  background: oklch(var(--l-3)  calc(var(--c-member) * .2) var(--h));
  border-color: oklch(var(--l-7)  calc(var(--c-member) * .65) var(--h)); }
```

`--c-member` は brand より高めに固定する (識別が目的なので彩度を保つ)。

### 6.2 固定スロットと増分割当 (webui 全体で 1 つ)

- 自分 (選択中セッションの main) = `--hue-self`、ユーザ = `--hue-user` の固定 2 スロット
- 他セッション / サブエージェントは、**除外帯** (状態色 4 h と固定 2 h の各 ±15°) の外から**増分割当**: 初出時に最大の空き区間の中央に置き、以後そのメンバーの h は固定する (参加者が増えても既存の色が動かない)。cwd を seed にした h を「希望値」として使い、既存と近すぎれば空き区間へ寄せる (世代交代したセッションが同系色になる)
- 割当は room ごとでなく webui 全体で 1 つ (選択セッションによって相手の色が変わると疲れる、kawaz r280m8)。割当ロジックは webui store の責務で、本 DR は色関数だけを規定する
- kind (main / サブエージェント / thinking) の区別は現行のスタイル (左ボーダー、破線) を温存し、色軸に混ぜない

### 6.3 emphasis = 段

同じ h のまま強弱を付ける軸。通常の吹き出しは段 3 + 文字 12、thinking は段 2、say とエラーメッセージは段 9 (solid) + その上の文字。`.say` が沈んで見える現状は h でなく段 (L / C) が薄い段相当に置かれているため。

## 7. テーマエディタ

- webui 内のフローティングパネル。層 0 の入力 8 個をカラーピッカー / スライダで編集し、`:root` の入力変数を書き換える (再計算は CSS 側)。DR-0031 のカタログと同じく daemon から何も読まない
- 組み込みテーマ: 入力 8 個の組を名前付き JSON でリポに複数同梱し、切替で見比べる。最初は現行配色を再現したもの 1 つから始める。ユーザが名前を付けて保存する機能は持たない (kawaz r280m24。必要になれば同じロード順・差分規則のまま足せる)
- 保存の階層 (kawaz 裁定 r280m18/m19)。テーマファイル = 層 0 の入力の組 (JSON):

  | 置き場 | 内容 | 書き手 |
  |---|---|---|
  | localStorage | いま適用中のテーマ。エディタで触ると即時保存 | エディタ |
  | daemon: 組み込みテーマ | リポ同梱の複数プリセット (読み取り専用) | リポ |
  | daemon: ユーザテーマ dir | **ユーザデフォルト** (1 ファイル) + **デバイス固有** (デバイスごとに 1 ファイル) | 保存ボタン |

  - **ロード順は常に localStorage → デバイス固有 → ユーザデフォルト → 組み込みデフォルト**。各層は任意で、無ければ親をそのまま使う (暗黙のコピーはしない)
  - エディタは適用中の値と **一つ親の層** (localStorage↔デバイス固有↔ユーザデフォルト↔組み込み) の差分を入力ごとに表示する (kawaz r280m23)。入力は 8 個なので差分は各入力の横に親の値を出す形で足りる。変えた覚えの無い差分は一つ親へのリセットで戻す
  - 操作: 「デバイスに保存」(デバイス固有へ) / 「ユーザデフォルトに保存」(デバイス固有とユーザデフォルトの両方へ) / 「テーマ選択」(組み込みテーマから選び localStorage に適用、保存はしない) / 「リセット」は 3 段階 (localStorage を消す / デバイス固有を消す / ユーザデフォルトを消す) で、いずれも消したあとロード順で再ロード
  - 典型フロー: ある端末で調整 → ユーザデフォルトに保存 → 他端末で「デバイス固有を消す」リセット → ユーザデフォルトが載る
  - デバイスの同定は localStorage に持つ device id ではなく、ユーザが付ける端末名 (例: "ipad") で行う。localStorage を消すリセットで id まで消えるとデバイス固有ファイルが孤児になるため。端末名未設定の端末はデバイス固有を持たず、ユーザデフォルトから始まる
  - 複数 instance (DR-0032 の mesh) 間ではユーザテーマ dir を丸ごとミラーする (選択なし、kawaz r280m21)。決着はファイル単位の last-write-wins。そのためテーマファイルは `updated_at` を最初から持つ (ミラー自体は v2 で実装、本 DR は形式だけ規定)
  - daemon 側の永続化はテーマ専用 op でなく **汎用 kv op** (protocol v2 の control 面、main ws と合意 r281m9)。組み込みテーマは webui バンドル内の JSON

### 7.1 kv op 案 (protocol v2 op 表の書式)

| v1 | v2 | plane | roles | hello | cap | loc | scope | errors |
|---|---|---|---|---|---|---|---|---|
| 新設 | `kv_read` | control | user | 要 | — | C | — | `not_found` |
| 新設 | `kv_write` | control | user | 要 | — | C | — | — |
| 新設 | `kv_delete` | control | user | 要 | — | C | — | — |

- payload: `kv_read {ns, key}` → `{value, updated_at}`、`kv_write {ns, key, value, updated_at?}`、`kv_delete {ns, key}`。`ns` は文字列、`value` は JSON、`updated_at` は ms 整数 (省略時は daemon が現在時刻)
- `ns` は topic 名に入るので識別子に限定 (`^[a-z][a-z0-9_]{0,63}$`)。`key` は 1〜256 文字・制御文字禁止のみ (`device:<端末名>` のような人が打つ文字列を許す)
- push topic `kv:<ns>` (snapshot + delta) で他端末の保存が即時に見える。delta の entry 型は snapshot と共有し、削除は `deleted: true` で表す
- 契約が約束するのは「ns 内で key が一意」だけ。instance 間ミラーは daemon の責務で、決着は `updated_at` の LWW
- テーマの使い方: `ns = "theme"`、`key = "default"` (ユーザデフォルト) / `key = "device:<端末名>"` (デバイス固有)。契約に device の概念は足さない
- v1 daemon に足す場合も同じ名前・同じ payload で足し、v2 契約を正本とする (旧系は DR-0032 §2.2 で凍結方針。v1 側は使い捨て)

## 8. 移行

1. app.css の `:root` に層 0 / 層 1 / 層 2 を追加し、既存トークン名は層 2 の別名として一旦残す (`--danger: var(--error)` 等)
2. カタログに段表 (12 段 × 全色相 × light/dark) の見本を追加し、現行配色との差を目視できるようにする
3. コンポーネント CSS を意味名へ置換: 未定義参照 8 箇所 → 死んだ fallback 12 箇所 → 生 hex 28 行 → `rgba()` 9 行 → member oklch 定数 24 箇所 → avatar `hsl()` の順 (findings の表を消し込みリストにする)
4. 旧トークン名の別名を削除、design-tokens.md の色の節を本 DR の語彙表で置換
5. テーマエディタ

各段階で `verify` skill の isolated daemon + playwright スクリーンショットで light / dark を確認する。

## 9. スコープ外

- Shiki のシンタックス色 (github-light/dark テーマ側が持つ)、ターミナルの ANSI パレット (hyoui の iframe 側)
- メッセージバブルの kind 表現の見直し (現行スタイルを温存、必要になれば別途)
