# DR-0056: スクロールの動かし方は起こしたもので決める (ユーザの操作は短い smooth、機械的なものは一瞬)

- Status: Accepted (2026-11-17、kawaz 指示) — ✅ 実装済み (`scroll-motion.ts` の `ScrollCause` / `scrollBehaviorFor`、`useScrollHold.ts` の `ScrollHold` の `cause` 引数と `movingTo` / `centerTop`、`components/timeline/toolbar-offset.ts` の `nearestBelowToolbar`、`components/timeline/context.ts` の `TimelineScrollHoldContext`、呼び出し側は §4 の表)
- Date: 2026-11-17

## Context

TL の日付の帯の ↑ / ↓ (DR-0054 §9) は押すと一瞬で飛び先へ移るので、押した結果どこへどちら向きに動いたかが目で追えなかった。kawaz の指示 (2026-11-17) の要点:

> 機械的に行うスクロールは一瞬で。ボタンを押すなどユーザインタラクションをトリガーにスクロールするときは一瞬で良いのでスムーススクロールにしろって言ってるだろ。

> 日付横の矢印が押した瞬間にスクロールしてることがわかりにくい

「一瞬で良いので」は長く待たせないことを言っている。対象は日付の矢印に限らず、webui の中でスクロールを起こす全ての所。

## 目的

ユーザが押す・選ぶ・キーを打った結果として画面が別の位置へ動く時、どこへどちら向きに動いたかが目で追える。機械が位置を合わせる時 (末尾への追従、位置の復元、高さが変わった時の寄せ直し) は、今までどおり遅れずにその位置にいる。

増やしたくないもの: 待ち時間と、場所ごとの動かし方の判断。smooth は見せるためのもので、ユーザを待たせない。どちらで動かすかは呼び出し側が 1 語 (`"user"` / `"machine"`) で言うだけにし、`behavior: "smooth"` を場所ごとに書かない。

## Decision

### 1. 機械的なスクロールは一瞬

次のものは一瞬で動かし、smooth にしない。

- 末尾への追従: 行が足された時、開いた時、初回の読み込み、Timeline タブがまた見えた時、「更新」の後 (`useStickToBottom`)。room の末尾の保持 (`RoomView`)
- 位置の復元: URL の位置への読み込み直後の着地 (直リンク、戻る / 進む、開き直し。`usePositionLanding`)、room の直リンクの着地、Files のビューアのスクロール位置の復元
- 高さが変わった時に位置を保つ寄せ直し: 読み足し (「過去分を上に / 下に読み込む」、日付の帯の ↑ の読み足しの間も)、fold の開閉、画像・markdown・highlight・翻訳の後からの伸び (`useScrollHold` の書き直しは全部)
- フィルタの切り替えで位置を保つ寄せ直し (DR-0050 §6、`useFilterScroll`)
- 初期表示

追従が smooth だと、高頻度で届く行ごとに動きが重なって遅れ、追いつかない。

### 2. ユーザの操作が起点のスクロールは短い smooth

押す・選ぶ・キーを打つの結果として画面が別の位置へ動くものは、ブラウザ標準の smooth で動かす。§4 の表の「user」の行が全部。

- OS の「視差効果を減らす」設定 (`prefers-reduced-motion: reduce`) の時は、ユーザの操作でも一瞬で動かす。ブラウザは programmatic な smooth にこの設定を当てない (Chromium 143 / WebKit 27.2 で、設定を入れても smooth が同じ長さで動いた) ので、こちらで見る (`scrollBehaviorFor`)
- `scrollend` を持たないブラウザ (Safari 26.1 まで。Chrome は 114、Safari は 26.2 から持つ) では、動き終わりの着地を確かめられない (§3) ので一瞬で動かす

### 3. smooth の出し方と着地の確かめ方

- 動き自体はブラウザ標準の smooth (`scrollTo({ behavior: "smooth" })`) に任せる。requestAnimationFrame で scrollTop を刻む自前のアニメーションは作らない。一瞬は `behavior: "instant"` と明示する (`"auto"` は要素の CSS の `scroll-behavior` に従ってしまう)
- TL と room のスクロールは `useScrollHold` を通る (読み込みや描画で高さが変わっても狙った位置を保つ仕組み)。smooth の移動と着地の確かめも `useScrollHold` が持ち、呼び出し側ごとに別の仕組みを作らない。呼び出し側は位置の決め方 (狙う scrollTop を返す関数) と cause を渡す
- 位置を覚えた最初の 1 回だけ、cause が `"user"` なら smooth で動き始める。行き先が今の位置なら smooth にしない (動かない smooth には `scrollend` が来ない)
- smooth で動いている間は、高さが変わっても書き直さない (書き直すと動きが途切れる)。動き終わり (`scrollend`) に、その時の配置で狙う位置を計算し直し、ずれていたら一瞬で直す。その後は一瞬の書き直しで保つ
- `scrollend` は動いている途中にも来る: Chromium は直前の一瞬のスクロール (前の smooth を止めたもの、ブラウザ自身が要素を見せたもの) の分の `scrollend` を smooth を始めた後に出し、その時 smooth はまだ 1 frame も動いていない。WebKit は scroll anchoring の調整の分を、Chromium は wheel の分を動いている途中に出した。動き始めの位置から scroll が離れるまでの `scrollend` は数えない (実ブラウザの TL で、これを数えて日付の帯の ↑ が一瞬の移動に打ち切られた)。離れた後で行き先に着いていない `scrollend` では、次の frame で位置が動いたかを見て、まだ動いていれば終わりとしない
- 動き出す前に内容が縮んで行き先が今の位置になった時は、もう動かず `scrollend` も来ないので、大きさの変化の時に動きを終わりにする
- 動いている途中で scroller が隠れると (タブの切り替え)、ブラウザは動きをやめ `scrollend` を出さない (両エンジンで確認)。大きさの変化 (ResizeObserver) で隠れたことを知って動きは終わったとし、また見えた時の大きさの変化で一瞬で置き直す
- Scroll method の Promise (`await scrollTo(...)`) は Chrome 150 からで Safari に無いので使わない

### 4. どこが操作起点で、どこが機械か

呼び出し側が cause を渡す。既定 (渡し忘れ) は害の小さい方の一瞬 (`"machine"`)。

| 場所 | 何が起こすか | cause |
|---|---|---|
| TL のツールバーの ⤒ ⤓ (`Timeline.tsx`) | 押す | user |
| TL の日付の帯の ↑ ↓ の着地と、端の ⤒ ⤓ 相当 (`useDayJump.ts`) | 押す | user |
| 日付の帯の ↑ で前の帯を探して読み足す間の位置の保持 (`scrollAnchor.ts`) | 読み込み | machine |
| TL の画面内検索の前へ・次へ (閉じた fold を開いてからの寄せも) (`useInViewSearch.ts`) | 押す / キー | user |
| 🔐 のフィルタの「TL に移動」の着地 (`usePositionPin.ts` の `landOn` → `usePositionLanding`) | 押す | user |
| URL の位置への着地 (直リンク、戻る / 進む、開き直し) (`usePositionLanding`) | 復元 | machine |
| Bash の command / result の間のリンク (`tools.tsx`) | 押す | user |
| fold の左端の縦線で閉じた時の summary への寄せ (`folds.tsx`) | 押す | user |
| 末尾追従・開いた時・初回の読み込み・タブの再表示・「更新」の後 (`useStickToBottom.ts`) | 機械 | machine |
| 「過去分を上に / 下に読み込む」の位置の保持 (`Timeline.tsx`、`scrollAnchor.ts`) | 読み込み | machine |
| フィルタに入る / 外す時の寄せ (`useFilterScroll.ts`) | 位置を保つ | machine |
| room の末尾の保持、開いた時の末尾 (`RoomView.tsx`) | 機械 | machine |
| room の直リンクの着地 (ログが届いて room を描き終えるまで) (`RoomView.tsx`) | 復元 | machine |
| 描き終えた room の中で別のメッセージを指した時 (メッセージのリンク、戻る / 進む) (`RoomView.tsx`) | 押す | user |
| markdown の目次・文書内リンクで見出しへ (`markdown-view.tsx`) | 押す | user |
| 狭い幅のサイドバーと本文の行き来 (☰、`App.tsx`) | 押す | user |
| 狭い幅の開いた時の横位置 (`App.tsx`) | 初期表示 | machine |
| Files のビューアの位置の復元 (`FileViewer.tsx`) | 復元 | machine (instant を明示) |
| Files のビューアの検索の前後 (`FileViewer.tsx`) | 押す | user (preview では CSS の `scroll-behavior: smooth`。視差効果を減らす設定では一瞬) |
| Files のビューアの行番号と本文のスクロールの同期 (`FileViewer.tsx`、`CodeEditor.tsx`) | 機械 | machine |

agent の TL へのリンク (`/timeline/agent/...`) は別の TL を開く遷移で、その TL の初期表示 (末尾) は機械的。

### 5. smooth の途中での割り込み

- ユーザが自分でスクロールした (wheel、touch、キー、スクロールバーの pointerdown): 保持を手放し、smooth を今の位置で止める。ブラウザは wheel が来ても programmatic な smooth を止めなかった (headless の Chromium 143 で、wheel の後も元の行き先まで動き続け、途中に `scrollend` を 1 つ出した。WebKit 27.2 でも wheel とキーの後に元の行き先まで動いた。WebKit は動きが約 0.2 秒と短く、操作がその途中のどこで届いたかまでは測れていない。キーの矢印は Chromium では動きを止めた)。止めないと、手放した後に古い smooth が位置を引き戻す。止めるのは今の位置への一瞬のスクロール (両エンジンでその場で止まった)
- 別のボタンを押した・行が足されて追従が働いた・セッションを切り替えた: 新しい位置を覚える時に古い smooth を止め、新しい移動に替える。古い行き先へは戻らない
- タブを切り替えた: §3 の隠れた時の扱い
- 末尾追従の判定 (`useStickToBottom`): smooth の途中の位置は読み手が選んだ位置ではない。途中は今の位置でなく行き先 (`movingTo()`) で最下部付近かを測り、追記にも追従しない。末尾から日付の帯の ↑ で上へ動き始めた直後はまだ最下部付近に見え、そこで追従すると押した移動を打ち消す。⤓ で末尾へ動いている途中に行が足されても、動き終わりに保持が伸びた末尾へ置き直すので、最後は末尾に着く。room の末尾の判定も途中の位置では測らない

## Alternatives Considered

| 案 | 採らない理由 |
|---|---|
| scroller に CSS の `scroll-behavior: smooth` を付ける | behavior を言わない全てのスクロールが smooth になり、末尾追従や位置の保持が遅れる。結局呼び出しごとに `instant` を言う必要があり、途中の割り込みと着地の直しは CSS では書けない |
| requestAnimationFrame で自前に動かし、長さを決める | ブラウザが持っている振る舞いを JS で作り直すことになり、エンジンごとの差を自分で抱える (kawaz「基本自分で制御する系はゴミ」) |
| 遠い移動は飛び先の手前まで一瞬で動き、最後の 1 画面ほどだけ smooth にする | 標準の機能だけで Chromium の長い smooth を短くできる (§Consequences の実測で 800px なら 0.48 秒)が、ブラウザの標準の動きをそのまま受け入れ、標準に無い長さの制御を作り込まない (kawaz 2026-11-17「別にブラウザの仕様ならそれで良いよ」)。Chromium で遠い移動が約 1.5 秒かかるのは標準の振る舞いとして受け入れる |
| smooth の途中も高さの変化のたびに smooth で行き先を差し替える | 差し替えるたびに Chromium は動きを始め直し、長くなる (2 度目の smooth は続けて約 0.87 秒動いた)。動き終わりに一瞬で直す方が短い |

## Consequences

- 標準の smooth の長さ (headless、静的な HTML で、動き始めから `scrollend` まで。各 3 回でぶれは 10ms 以内):

| 距離 | Chromium 143 | WebKit 27.2 |
|---|---|---|
| 200px | 250ms | 216ms |
| 800px | 483ms | 216ms |
| 2,000px | 758ms | 216ms |
| 5,000px | 1,192ms | 216ms |
| 20,000px | 1,509ms | 216ms |
| 60,000px / 150,000px | 1,517ms | 216ms |

- WebKit は距離に依らず約 0.2 秒。Chromium は距離の平方根に比例して伸び (約 17ms × √距離)、1.5 秒で頭打ちになる。約 3,500px を超える移動 (TL の日付の帯の間、⤒ ⤓) は Chromium で 1 秒を超える。smooth の長さを決める標準の機能 (CSS のプロパティも `scrollTo` の引数も) は無い。短くする標準の範囲の手段は Alternatives の 3 行目 (手前まで一瞬 + 最後だけ smooth) だけ
- 実際の TL (822 行の fixture、headless、1280×900) での所要 (押してから `scrollend` まで): 日付の帯の ↑ / ↓ で隣の帯へ (約 1,200〜1,600px) は Chromium 630〜700ms、WebKit 約 260ms。⤒ / ⤓ (約 22,000px) は Chromium 約 1,530ms、WebKit 約 250〜280ms。画面内検索の次へ (約 14,000px) は Chromium 約 1,560ms、WebKit 約 270ms。着地は帯がツールバーの直下 (差 0〜1px)
- 同じ確認で、⤒ の途中の wheel では動きがその場で止まって一番上へ引き戻されず、⤓ の途中と ↑ の途中に行を足しても、⤓ は伸びた末尾に、↑ は飛び先の帯に着いた。↑ の動いている途中にもう 1 度押すと、次の帯へ smooth で動き直して着いた。視差効果を減らす設定では ↑ が 1 回のスクロールで着いた
- 動いている間の位置は読み手が選んだ位置ではないので、読書位置の記録 (`rememberTimelinePosition`) は行き先に着いた後のスクロールで書き直される
- headed のブラウザ・実機の iOS / macOS Safari での長さは測っていない

## 関連

- [DR-0054](./DR-0054-timeline-day-bands.md) §9 — 日付の帯の ↑ / ↓
- [DR-0050](./DR-0050-timeline-notification-badges.md) §6 — フィルタの切り替えの位置合わせと「TL に移動」
- [DR-0022](./DR-0022-in-view-search.md) §2.2 — 画面内検索の前へ・次へ
- [DR-0004](./DR-0004-webui-architecture.md) §5 — room の直リンクの着地
