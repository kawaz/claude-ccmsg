# Timeline windowing / cross-line 差分化 の設計調査

issue `2026-07-29-timeline-virtual-scroll` (DOM 73,000 ノード / リスナ 12,000) と
`2026-08-12-timeline-crossline-incremental` (live-tail 1 行ごとの全行走査) を併せた設計調査。
コード変更なし。

## 判明した事実

### 1. 畳まれた fold の中身が全部 DOM にマウントされている

`ItemsSubFold` (Timeline.tsx:1932) は `useState(false)` の閉じた `<details>` だが、
body の `entries.map(LineView)` は open/closed に関わらず常に描画される。`FoldGroup`
(同 1789) も同じ。`<details>` が閉じているのは表示上だけで、DOM ノード・イベント
リスナ・ref はすべて実在する。

**pure model による実測** (`transcript-model.ts` を bun から直接叩き、個人リポの実
セッション 4 件を 3 プロジェクトから採取):

| 行数 | サイズ | boundary entry | fold entry | うち閉 ItemsSubFold 内 |
|---|---|---|---|---|
| 11,048 | 46.0 MB | 3.6% | 96.4% | **95.3%** |
| 11,749 | 35.0 MB | 3.0% | 97.0% | **96.1%** |
| 5,170 | 13.0 MB | 6.6% | 93.4% | **78.0%** |
| 5,775 | 11.6 MB | 15.6% | 84.4% | **72.7%** |

(閉 ItemsSubFold = 既定 closed の `<details>`。`entries.length === 1` の run は
ItemsSubFold が `<details>` を作らず中身を引き上げるため除外済み。)

**全 entry の 72.7〜96.1% が「初期状態で閉じている fold の中」にいて、しかも全部
マウントされている。** バイト量で見ると boundary 側は 0.9〜17.5% しかない。

つまり 73,000 ノードの大半は「ユーザに見えていないし、開くまで見えることもない」
ノードである。これは windowing (スクロール位置に応じた mount/unmount) を入れる前に、
**スクロール位置と無関係に落とせる分**。

### 2. live-tail の重さは CPU よりも Preact の全ツリー再 diff

Timeline.tsx:2995-3067 の依存連鎖はこうなっている:

```
store: [...prev.lines, ...action.lines]   ← O(N) コピー (store.ts applyTimelineTail)
  → perLine / byteLengths                  ← incremental-line-map で差分化済み ✅
  → pairQueuedTurns → resolveToolResults   ← 全行走査 + 全 ParsedLine 配列を新規確保
  → byteOffsetsFromLengths                 ← 全行走査
  → groupTimelineLines                     ← 全行走査 + 全 group / entries 配列を新規確保
  → boundaries / ccmsgTargets / userTurnKeys / searchUnits / chain  ← groups 依存で全再計算
  → groups.map(...) の render 本体          ← 全 FoldGroup に新しい entries 配列が渡る
```

per-line parse だけが差分化されていて、その後段が全部素通しになっている
(= crossline-incremental issue の指摘どおり)。ただし CPU の全行走査より効くのは
**最後の 1 行**: `groups` と各 `entries` の identity が毎回変わるため、Preact は
全 FoldGroup サブツリーを再 diff する。`FoldGroup` / `ItemsSubFold` は `memo()`
されていないので、props identity が同じでも親の再レンダーで必ず再帰する。

**1 行追記のたびに 73,000 ノードぶんの diff が走る。** windowing はこれを「窓の中
だけ」に減らすが、cross-line の差分化 + `memo()` は窓なしでも同じ効果を出せる。
両者は独立コストという issue の記述は正しいが、**再 diff の観点では代替関係**にある。

### 3. windowing と衝突する既存機構 (棚卸し)

| 機構 | 実装 | windowing との衝突 |
|---|---|---|
| in-view search の `[N/M]` | Timeline.tsx:3264 の effect が `searchUnitRefs` (マウント済み DOM) を引いて `highlightRenderedText` で数える | **致命的**。M が「マウント済みの数」なので、窓外を unmount した瞬間 M が窓のサイズまで縮む |
| 検索ナビ ↑↓ | `matchingUnitKeys` → ref → `revealAndScroll` | 対象が未マウントだとジャンプ不能 |
| 👤 user nav | keys はモデル側 (`userNavTargets`) で正しい。ジャンプは `userTurnRefs` + `topBelowToolbar` (getBoundingClientRect) | M は無事。ジャンプ先が未マウントだと不可。index → 推定スクロール位置 → マウント後に補正、が必要 |
| uuid 位置 pin | `scrollRef.current.querySelector('[data-timeline-uuid=...]')` (3620 付近) | 見つからないと head にリセットする分岐があり、「ロード済みだが未マウント」を「範囲外」と誤判定する |
| `checkNearBottom` の位置記録 | `el.querySelectorAll("[data-timeline-uuid]")` を **scroll の rAF ごとに全走査** | windowing で逆に改善する (今が O(N)/frame) |
| fold の開閉状態 | `FoldGroup` / `ItemsSubFold` の `useState` | unmount で消える。開いた fold が窓外に出て戻ると閉じる。開閉状態を offset キーの Map に持ち上げる必要がある |
| 高さの非決定性 | markdown 描画 / thinking の ja 翻訳差し替え / highlight 注入 / 画像 | 高さ推定が当たらない。`settledScroll` の多段書きが今それを吸収している |
| fork 区切り線 | `groups` の index に splice | 影響なし |

`searchClosedFolds` (📁) トグルは `highlightRenderedText` に渡り、閉じた fold の中も
数えられる仕様になっている。**これは「閉じた fold の中身が DOM にある」ことに完全に
依存している**ため、事実 1 の対処 (閉 fold の遅延マウント) と真正面からぶつかる。

## 実用的な示唆

検索マッチ判定が DOM ベースであることが、windowing・遅延マウントの**両方**に共通の
最大の障害。これは windowing の是非以前に、現状でも「M がマウント状況に依存する」
という設計上の歪みになっている。モデル側 (`segmentSearchText` に対する純関数マッチ)
へ移すのは、どの案を採っても前提条件になる。

## 案の比較

| | A. 自作 windowing | B. content-visibility | C. 閉 fold の遅延マウント |
|---|---|---|---|
| ノード数削減 | 窓サイズまで (最大) | **0** (レイアウト/ペイントのみ) | 73〜96% (実測、初期状態) |
| リスナ削減 | 同上 | **0** | 同上 |
| 高さ推定・スクロールアンカ | **必要** (ResizeObserver + 実測キャッシュ) | 不要 | **不要** (閉 fold は body の有無で高さが変わらない) |
| 検索 `[N/M]` | モデル側マッチへ全面移行が必須 | 影響なし | 📁 on の時だけモデル側マッチが必要 |
| 👤 nav / uuid pin | 未マウント対応が必要 | 影響なし | **影響なし** (boundary は常時マウント) |
| fold 開閉状態 | 持ち上げ必須 | 影響なし | 持ち上げ必須 (ただし C の実装そのもの) |
| live-tail の再 diff | 窓の中だけに縮む | 変わらない | 閉 fold ぶん縮む |
| 工数感 | 大 (数日〜、Timeline.tsx の広範囲改造 + 回帰リスク高) | 極小 (CSS 数行 + 実測) | 中 (fold 開閉の持ち上げ + 検索モデル化) |
| 主なリスク | スクロール位置のドリフト、既存の settled scroll 群との相互作用 | 効果が出ない可能性 / `getBoundingClientRect` が intrinsic-size を返しジャンプ精度が落ちる | 📁 on の検索仕様を壊す |

これらは排他ではないが、**「両方の良いとこ取り」で 1 案に統合できる関係でもない**。
A は高さ推定という固有の重い制約を背負い、C はその制約を回避できることが価値なので、
C の上に A を無条件に重ねると C の「高さ推定不要」という長所が消える。順に効果を測って
段階を進める形にする。

## 推し案: D0 → D1 → D2 の段階実施、A は測定結果で判断

### D0. cross-line 差分化 + `memo()` (crossline-incremental issue 本体)

- `pairQueuedTurns` / `resolveToolResults` / `byteOffsetsFromLengths` /
  `groupTimelineLines` を**構造共有**にする。tail 追記で変わるのは末尾グループだけ
  なので、前方のグループと `entries` 配列の identity を持ち越す。
  `incremental-line-map.ts` の prefix/suffix マッチと同じ発想を group 層に適用する。
- `FoldGroup` / `ItemsSubFold` を `memo()` する。D0 の構造共有と組み合わせて初めて
  効く (identity が保たれないと memo は素通り)。
- `store.ts` の `[...prev.lines, ...action.lines]` は O(N) コピーだが、上記に比べれば
  桁が小さい。**先に上を直してから測って、必要なら chunk 配列化**する。ここを先に
  凝ると効果の小さい複雑化になる。

**理由**: 独立して価値があり (live-tail の CPU と再 diff が両方直る)、他案の前提を
壊さず、windowing を入れるとしても必要になる。リスクが最も低い。

### D1. 検索マッチをモデル側へ

`searchUnits` を「マッチしたかどうか」まで純関数で決める。DOM 側の
`highlightRenderedText` は**マウント済み unit の装飾専用**に降格し、`[N/M]` と
`matchingUnitKeys` はモデルから引く。副次的に、現状の「M がマウント状況に依存する」
歪みが消える。

### D2. 閉 fold の遅延マウント (案 C)

fold の open 状態を Timeline 側の `Map<offset, boolean>` に持ち上げ、閉じている間は
body を描画しない。一度開いたら (窓の概念がないので) 閉じても再マウントは不要。

**理由**: 実測で 72.7〜96.1% のノードが落ちるうえ、**windowing 特有の難所 (高さ推定・
スクロールアンカ・未マウント要素へのジャンプ) を一つも踏まない**。閉じた `<details>`
の高さは body の有無で変わらないので、スクロール位置が動かない。boundary バブル
(user / assistant / ccmsg) は常時マウントのままなので、👤 nav・uuid pin・位置記録は
無改修で動く。D1 を先に済ませてあれば 📁 on の検索も壊れない。

### A (自作 windowing) は D2 の実測後に判断

D2 適用後のノード数を webui-memory-probe で再測し、それでもなお重ければ着手する。
実測 73,000 に対し D2 で 1 桁減るなら、A の工数と回帰リスクに見合わない可能性が高い。
**この判断を実測前に先取りしない。**

### B (content-visibility) の位置づけ

issue が「先行する安価な緩和」と書いているとおり、D0〜D2 と直交する。入れて損はないが
DOM/リスナ数は 1 個も減らないので、issue が挙げた実測値 (73,000 ノード / 5 万リスナ)
への回答にはならない。D2 の後に、残ったノードのペイントコスト対策として測るのが順当。

## 未検証

- D0 の構造共有で live-tail の再 diff がどれだけ減るかは未実測 (実装しないと測れない)。
- D2 適用後の実 DOM ノード数は未実測。上表はモデル側の entry 数比であり、
  entry あたりのノード数が boundary と fold で同程度という仮定を置いている
  (バイト量比では fold 側が 82.5〜99.1% なので、ノード比はむしろ表より大きい可能性が高い)。
- 案 B の効果は issue 記載のとおり未実測のまま。

## 検証の詳細

### 閉 fold 内 entry 比率の測り方

`transcript-model.ts` は外部 import を持たない pure module なので、bun から直接
import して実セッションの JSONL に適用した (ブラウザ不要)。
`parseTranscriptLine` → `pairQueuedTurns` → `resolveToolResults` →
`groupTimelineLines` → `splitFoldSubgroups` まで Timeline.tsx と同じ順で通し、
`kind === "fold"` グループの entry を `foldGroupNeedsOuterFold` と
`splitFoldSubgroups` の `items` run (長さ 2 以上) で分類した。

サンプルは 3 プロジェクト・4 セッション (11.6〜46.0 MB)。行数の少ない側で fold 比率が
下がるのは、対話主体のセッションほど boundary (ユーザ発言 / AI 応答) の割合が高いため。
それでも最小で 72.7% が閉 fold 内にいる。
