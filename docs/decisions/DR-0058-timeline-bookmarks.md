# DR-0058: TL の項目のブックマーク (☆ / ⭐、daemon がセッションごとに持つ uuid の列、ヘッダの ⭐ のフィルタ)、フィルタの項目のクリックで TL に移動

- Status: Accepted (2026-11-20、kawaz の依頼を元に統括が決定、細部はワーカーが §10 に起草) — ✅ 実装済み (protocol の `bookmarks.ts` (`bookmark_set` / `bookmark_rows` / `ev:"bookmarks"`)、`Paths.bookmarks`、`TimelineFilter` の `bookmark`、daemon の `bookmarks.ts` と `server.ts` の 2 つの op、webui の `StackedLabels` / `StarMark`、SESSIONS の並べ替えのボタン、`timeline/bookmark.tsx` の `BookmarkStar` / `MergedItem`、`ItemRawToggle` の ☆⭐、`listed-bookmarks.ts`、`useBookmarkRows`、`TOOLBAR_BADGE_KINDS`、Timeline の `itemBodies` / `jumpTo`、app.css の `.star-mark` / `.tl-item-star` / `.tl-lines[data-filter="bookmark"]`)
- Date: 2026-11-20

## Context

kawaz の依頼 (2026-11-20) の要点:

- TL の項目をブックマークしたい。保存は say や permit と同じく daemon がセッション単位で永続化する。中身はセッションごとの uuid の配列
- uuid を持つ項目に ☆ / ⭐ を出してトグルする。uuid を持たない項目にも ☆ は出すが、押しても何も起きない
- ☆ と ⭐ の大きさはフォントでずれないようにする (どこで使うものも)
- ⭐ の位置: 吹き出しでない項目は jsonl が出る位置の右側に常に出す。☆ は jsonl と同じ出る決まりでよい。kawaz 2026-11-20 の追加: jsonl は元の場所 (項目の右上) に戻し、全部の項目で右側に「jsonl ⭐」を並べる。右詰めのユーザの発言だけは、「jsonl ⭐」の組を吹き出しの右上の外側 (bottom = 吹き出しの top、right = 吹き出しの right) に置く
- TL のヘッダには 🔔 🔐 ⭐ が並ぶ。⭐ は件数に関わらず常に ⭐ で、1 件以上なら 🔔 と同じ赤い数を載せる。数が付いても幅が変わらない
- ヘッダの ⭐ で say / permit とほぼ同じフィルタがかかる。フィルタ中に項目をクリックすると「TL に移動」が働き、TL にその uuid が読み込まれていなければ読み込む (permit と同じ)
- say のフィルタにも項目のクリックで TL に移動を足す。permit の項目に個別に出ている「TL に移動」ボタンは無くし、項目のクリックの形に揃える

## Decision

### 1. 目的

TL の中で後から戻りたい項目に印を付け、どの端末・どのタブからでもその項目へ戻れるようにする。🔔 / 🔐 のフィルタと同じ入口・同じ見せ方・同じ戻り方 (項目のクリックで TL のその位置へ) にする。

増やしたくないもの:

- 印の正本と経路 (daemon が持ち、`ev:"bookmarks"` で全タブに配る。webui 側に別の印の状態を持たない。DR-0050 §1 と同じ)
- TL の描画の経路 (フィルタ用に TL を別に描かない。窓の外の項目も、窓がその行を描くのと同じ部品で描く)
- 項目の種類ごとの「TL に移動」の作り (say / 許可依頼 / ブックマークで 1 つのクリックの規則)

### 2. 何をブックマークできるか、TL の位置と seek

- ブックマークは transcript の行の uuid。持てるのは **TL の位置 (`/s/<sid>/timeline/<uuid>`) になれる項目**、つまり uuid を持つ行の項目 (`ItemRawToggle` が `uuid` を渡されて `data-timeline-uuid` を持つ項目)。窓の境界の行 (ユーザの発言、assistant の応答、API エラー、`!` のコマンド、say、PushNotification、許可依頼、ユーザ発の ccmsg) と、fold の中の行 (thinking、tool の行、システム由来の行、attachment 等の行、peer 発の ccmsg) のどちらも (kawaz 2026-11-20)。ブックマークに戻る操作は「その位置へ移る」(§6) で、位置の文法 ([webui-url-grammar](../design/webui-url-grammar.md) の「`head` かレコード uuid」) はもとからどの行の uuid も指せるので、文法は変えない
- **fold の中の行への着地**: 位置の行が窓の中にあって要素が無い (囲む fold が閉じていて本文がまだ描かれていない) 時は、囲む fold を開き (`openFoldsAt`、検索の ↑ / ↓ と同じ)、本文が描かれてから着地する。着地する fold の中の行は、行の中の一番外側の fold (tool の中身、thinking 等の `<details>`) も開く。選んでいる fold の行は境界の吹き出しと同じ色の枠で示す。fold の本文の購読 (`useFoldOpen`) は layout effect で張る: 着地の effect が同じ commit で開いた時に取りこぼさないため
- **fold の中の行のクリック**: 境界の項目と同じく、フィルタの無い間は位置の選択と解除、フィルタの間は移動 (§6)。どの項目も位置とクリックを 1 つの context (`TimelinePositionContext`) から読み、memo した fold の行は位置が変わった時だけ描き直す
- **`seek=true`** (位置のページ固有 query、kawaz 2026-11-20): 位置の行が窓に無い時、その行が窓に入るまで過去分を 1 ページずつ読み (`loadOlderUntil`)、入ったら着地する。付いていない時は今のまま末尾 (`head`) に戻す: 打ち間違えた uuid で transcript を先頭まで読まないため。値は `true` だけ (他の値の無いオプション `sb.fork_session` と同じ)、`head` には付けない。フィルタの項目のクリックで移る URL (§6) はこれを付ける (再読み込みや別の窓で開いても同じ行へ戻れる)。先頭まで読んでも無ければ末尾に戻し、TL の上の既読の失敗の行 (`tl-say-error`) に「位置 <uuid> は、このセッションの transcript を先頭まで読んでも見つかりませんでした」を末尾にいる間だけ出す。読んだ過去分は窓に残る。位置を書き換える遷移 (選択、末尾での解除) は `seek` を引き継がない
- uuid を持たない項目は ☆ を押せない (disabled) で出す: 読めない行 (`broken`)、worker の say と、🔔 / 🔐 のフィルタが窓の外から合流させた say / 許可依頼 (行の uuid を持たない)。agent の TL では全部 (agent の TL は位置を URL で表せず、DR-0025 / usePositionPin.ts)
- 押せない ☆ は既存の押せないボタンと同じく薄く (hover の間 `opacity: 0.35`、タッチの端末では 0.25) し、カーソルを普通の矢印にする。title で「位置を持たないのでブックマークできない」と出す
- ⭐ のフィルタでは、fold の中の行のブックマークは fold が隠しているので、窓の外のブックマークと同じく行を別に描く (`listed-bookmarks.ts` の `bookmarkedFoldRows`、fold の行を描く `LineView` の `bare`)。daemon の `bookmark_rows` も、uuid を持つどの行 (attachment 等の行も) を返す

### 3. ☆ / ⭐ の部品と置き場

- **`StackedLabels`** (Preact の部品と `.stacked-labels`): 入れ替わるラベルの候補を全部 `display: inline-grid` の箱の同じ升目 (`grid-area: 1 / 1`、`place-items: center`) に重ね、見せない方を `visibility: hidden` で隠す。どれを見せるかは箱の `data-shown` (候補の番号) で CSS が切り替え、JS で大きさを測らない。箱は一番大きい候補の大きさのままなので、切り替えて周りが動かない。候補は 6 つまで (CSS の規則の数、`STACKED_LABELS_MAX`)。許可依頼の「許可する / 許可済み / コピーしました」(DR-0040 §7、`.permit-grant`) と同じ形。使う所:
  - `StarMark` (`.star-mark`): ☆ (文字) と ⭐ (絵文字)。フォントも字の送りも違うので、どちらか 1 つだと箱の大きさが変わる。項目の ☆⭐ と TL のヘッダの ⭐ の両方。ピン留めのボタン (SESSIONS のピン留めの行の ⭐ `.pinned-unpin-btn`、Session Search の結果の ☆⭐ `.session-search-hit-pin`、セッションのヘッダの右端の ☆⭐ `.session-pin-toggle`) も使う (kawaz 2026-11-20)。ピンでは `fit` を付け、⭐ を 0.7em に縮めて ☆ の箱に収める (⭐ の字の送りは ☆ より広く、11.2px の字で ☆ 11.2px に対し ⭐ は Chromium 14px / WebKit 16px。箱を ⭐ に合わせるとピンを付けた時にボタンが広がり、Chromium のヘッダのボタンは高さも 23.38px → 28.38px に伸びてヘッダが 32.98px → 34.77px になっていた)。ピンのボタンは箱を正方形にする: 行の 2 つは 1 行の高さ (`1lh`) の正方形、ヘッダのは前の高さ (`1lh` + 上下の余白 + 枠) と同じ幅。どれも高さは ☆ の時のままで、左右の余白を削る
  - SESSIONS の並べ替えのボタン (`#peers-sort`): prompt / name / created / recent。押すたびに字の幅でボタンの幅が変わっていた (kawaz 2026-11-20)。見た目と動きはそのままで、ボタンの名前 (`aria-label`) は今の並べ方のラベル。実測で 4 つの並べ方の幅が同じ (Chromium 49.48px、WebKit 52.80px、1280px と 390px)
- **項目の ☆⭐** (`BookmarkStar`、`.tl-item-star`): 項目の包み (`ItemRawToggle`、合流させた項目の `MergedItem`) の最後の子のボタン。`aria-pressed` が ⭐ かどうか。押すと `bookmark_set` を送る (非楽観、§4)。ボタンのクリックは項目の選択・移動に数えない (raw.tsx の `selectPositionOnClick` と同じく button は除く)
  - 置き場: どの項目も (吹き出しも) 項目の右上の角 (`top: 0; right: 0`) に置き、jsonl のトグルはその左に並ぶ (`right: calc(var(--tl-star-size) + var(--space-2))`)。「jsonl ⭐」の組 (kawaz 2026-11-20)
  - ユーザの発言 (`ItemRawToggle` の `controlsAbove`、`.tl-item-controls-above`) だけは、右詰めの吹き出しで項目の右上の角が本文の字なので、組を吹き出しの右上の外側に置く (組の下端 = 本文の枠の上端、右端 = 本文の枠の右端)。右詰めの吹き出しの本文の枠は項目の上端と右端にあるので、項目の上の外側 (`bottom: 100%`) に置けば足りる (anchor positioning は使わない)
  - 大きさ: 決まった正方形 (`--tl-star-size`) で、隣の jsonl のトグルと同じ高さ (字の大きさ 0.6rem + 上下の余白 + 枠) に、中の `StarMark` を字の大きさ 0.7rem で真ん中に置く。項目の先頭の行 (fold の summary など小さい字の行) より高い箱を置くと、項目の下へはみ出して次の項目との間が詰まって見える (kawaz 2026-11-20)。☆⭐ も jsonl も absolute なので項目の高さには入らない
  - 出る決まり: ⭐ は常に出す。☆ は jsonl と同じ (項目の hover / focus の間、タッチの端末では常に薄く `opacity: 0.45`)。閉じた fold の項目 (jsonl を出さない項目と同じ判定) には ☆ も出さない。jsonl を出している間 (吹き出しは隠れて元の行が出る) も jsonl と ☆⭐ は残る
  - z-index は付けない。ユーザの発言の上の組は前の項目の領域に重なるので項目の中身より上に描かれるが (位置指定の要素)、sticky な TL のツールバー (`z-index: 1`) より下になる
- 実測 (Chromium / WebKit、1280px / 390px、隔離 daemon と fixture): 項目の高さは jsonl と ☆⭐ を置いても置かなくても同じ (両方を `display: none` にして測り直して全部一致)。☆⭐ の箱の高さは jsonl のトグルと同じ (14.80px / 14.78px)。吹き出しでない項目と assistant の吹き出しの項目では ☆⭐ の右端・上端 = 項目の右端・上端、jsonl の右端 < ☆⭐ の左端。ユーザの発言では組の下端 = 本文の枠の上端、☆⭐ の右端 = 本文の枠の右端

### 4. 永続化と経路

- daemon が `<stateDir>/bookmarks.json` に `{ "<sid>": ["<uuid>", ...] }` (付けた順) で持つ。say-read.json / permit-state.json と同じく、書く時は一時ファイルに書いて rename し、書き込みは順に並べる。読めないファイルは空から始めてログに出す
- say / permit の状態と違い、走っていないセッションの分を起動時に落とさない (`pruneNotificationState` の対象にしない)。未読は走っていないセッションでは意味が無くなるが、ブックマークはセッションが終わった後に戻るための印なので
- op (protocol の `bookmarks.ts`、user role だけ。session role は断る):
  - `bookmark_set { sid, uuid, on }` → `{ ok: true }`。ファイルに書いてから答え、変わった時だけ `ev:"bookmarks"` を user role の購読者全部に送る。同じ状態への設定は何も変えず送らない
  - `bookmark_rows { sid }` → `{ ok, sid, rows: [{ uuid, lines }] }` (§5)
- push: `ev:"bookmarks" { sessions: [{ session_id, uuids }] }`。購読の時に空でも送り (再起動した daemon が別のファイルを読んだ時に古い印を残さない)、変わるたびに全部を送る。webui の store の `bookmarks` (sid → uuid の列) を丸ごと置き換える
- PROTOCOL_VERSION は動かさない: 読むのは webui だけで、webui の bundle は daemon が配る。hooks の bundle は変わらない (`bun hooks/bundle.ts --check` で確認)
- `TimelineFilter` (webui-url.ts) に `bookmark` を足す。URL は `/s/<sid>/timeline/<position>?filter=bookmark` ([webui-url-grammar](../design/webui-url-grammar.md))
- 非楽観: ☆ を押しても daemon の push が来るまで ⭐ にならない。失敗した理由は TL の既読の失敗の 1 行 (`tl-say-error`) に出し、次に成功するまで残す

### 5. ⭐ のフィルタ

- TL のヘッダ (`tl-toolbar` の左端、DR-0050 §3) に 🔔 🔐 ⭐ の順に並べる (`TOOLBAR_BADGE_KINDS`)。⭐ の数はそのセッションのブックマークの数で、🔔🔐 と同じ数を重ねる部品 `CountBadge` と同じ決まり (1 から数字、100 以上は `99+`、0 は数字なし。数の枠は absolute なので数の有無で幅が変わらない)。中身は件数に関わらず常に ⭐ の字 (🔔🔐 と同じく絵文字 1 字。項目の ☆⭐ の `StarMark` は使わない)。Sessions の行には出さない (行のバッジは「今呼ばれているのはどれか」を見つけるもの、DR-0050 §7)。agent の TL では出さない (🔔🔐 と同じ)
  - 数の枠は 🔔🔐 と同じ赤 (`--danger`)。「同じ部品・同じ決まり」に従ったもので、未読の意味は持たない
  - 実測: ⭐ のバッジの幅は 0 / 1 桁 / 2 桁 (0・3・10 件) で変わらない (Chromium 26.38px、WebKit 29.38px、1280px と 390px)
- フィルタの見せ方は 🔔 / 🔐 と同じ (DR-0050 §4・§5): `.tl-lines[data-filter="bookmark"]` で、`data-bookmarked` を持たない子と、そのフィルタの日付の帯 (`data-tl-views~="bookmark"`) でない子を CSS で隠す。末尾の「TL に戻る」、選択中のバッジでの解除、解除の位置合わせ (DR-0050 §6)、`filter` の replace の扱いも同じ。「全て既読」は出さない (既読を持たない)。該当が 0 件の時は「ブックマークはありません」を、daemon の答えが届いてから出す
- 窓の外のブックマーク (permit のフィルタの `notification_list` を手本にした形): フィルタに入るたびと、フィルタの間にそのセッションのブックマークが変わった時に `bookmark_rows` を聞き、窓に行の無いもの (かつブックマークのままのもの) を時刻の位置に合流させる (`slotsByTime`)。過去分は読まない (DR-0050 §9 U8 と同じ)
  - 窓の外の項目は、窓がその行を描くのと同じ部品で描く。そのために daemon は行に加えて、その行を描くのに要る行を返す: 行の次の行 (`!` のコマンドの出力は次の行、transcript-model.ts の `resolveBashCommands`) と、その行の tool の呼び出しの結果の行 (許可依頼は結果があって初めて依頼になる、DR-0040 §4)。webui はこれを窓と同じ parse と cross-line の処理に通し (`listed-bookmarks.ts`)、窓と同じ境界の分類で描く
  - daemon は行と付随の行が全部揃ったものを覚え、次からは読まない (transcript の行は変わらない)。全部が揃わずにファイルが終わった行 (今の turn の結果待ち) は、あるところまで返して次に読み直す。transcript に無い uuid は返さない
  - 窓の外の項目は位置 (`data-timeline-uuid`) も jsonl も持たず、`data-filter-only="bookmark"` を持つ。☆⭐ は持つ (uuid は分かっている) ので、フィルタの中でブックマークを外せる (外すとその場で消える)
- 日付の帯 (DR-0054) は ⭐ の見え方の項目の並びで決めたものを出す (`useDayMarks` の `bookmark`)

### 6. フィルタの項目のクリックで TL に移動 (🔔 / 🔐 / ⭐ 共通)

- フィルタの間に項目 (の、ボタン・リンク・入力・summary 以外の所) をクリックすると、フィルタを外してその項目の行の位置 (`/s/<sid>/timeline/<uuid>`、`filter` なし) へ replace で移り、その項目を TL 表示領域の一番上に着地させる (`usePositionPin` の `landOn`)。外からその位置へ来た時と同じで、押した操作なので短い smooth (DR-0056)。DR-0050 §6 の「TL に移動」の着地の規則をそのまま使う
- 窓の中の項目は読み込まずにすぐ移る。窓の外の項目 (🔔 / 🔐 / ⭐ が合流させたもの) は、その行が窓に入るまで過去分を 1 ページずつ読み (`loadOlderUntil`、次のページは前のページが入ってから)、入ったら移る。say / 許可依頼は tool_use の id で行を探し (`toolUseRowUuid`)、ブックマークは uuid で探す (`rowUuidIn`)。読み込みの間は行の列を `aria-busy` にして、どの項目のクリックも受けない (カーソルは `progress`)。読み終えた時に同じセッションの同じフィルタを見ていなければ移らない (読み込みの間に人が移った先から引き戻さない)。読み込みを途中で止める手段は持たない (DR-0050 §4 と同じ)
- worker の say は親セッションの transcript に行が無いので、クリックしても何もしない
- フィルタの無い間の項目のクリックは今のまま位置の選択と解除 (kawaz r76 m71)。フィルタの間は選択の代わりに移動になり、フィルタの間に位置を選ぶ手段は無くなる。フィルタに入る前に選んでいた位置は今のまま残り、選択中のバッジや「TL に戻る」で外した時はその位置を保つ (DR-0050 §6)
- 許可依頼のバブルの本文の最後の行の「TL に移動」(DR-0050 §4、`.permit-jump`) は無くす。行には「既読」と「許可する」だけが残る
- フィルタの間は項目の包みに `cursor: pointer` を出す (`.tl-lines[data-filter] > .tl-item[data-activatable]`)
- フィルタの間は、項目の本文を 5〜6 行分の高さに抑える (kawaz 2026-11-20)。対象は AI の応答・ユーザの発言の吹き出しの本文 (`.tl-bubble-body`)、許可依頼の中身 (`.permit-content`: 止められた行動・添付・許可してほしいこと・settings の節)、say の本文 (`.say-body`) (say は大きくなりにくいが仕組みは揃える)。ccmsg の吹き出し、`!` のコマンド、API エラーは抑えない
  - 未読か既読かを見せる所は抑えずに常に見せる (kawaz 2026-11-21: 省いた許可依頼が並ぶと、どれが既読か分からなかった)。許可依頼の帯 (🔐 / 🔓。未読は帯と枠が赤い、DR-0040 §7) と本文の最後の行 (「既読」/「既読済み」、「許可する」/「許可済み」と写せなかった理由)、say の足元の行 (時刻と「既読」のボタン / 「既読」の字) は省略の外にある
  - 高さは `max-height: 8lh` (`lh` は本文の字の normal の行の高さ。ユーザの発言の字の行でおよそ 6 行、markdown の箇条書きでおよそ 5 行。実測で 144px、WebKit のユーザの発言は行の送りが詰まって約 7 行)。`overflow: hidden`
  - 収まらない分がある項目 (`data-clamped`) は、本文の下の 2 行分を `mask-image: linear-gradient(to bottom, #000 calc(100% - 2lh), transparent)` で透明へ向けて薄くし、省いていると分かるようにする
  - 収まるかどうかは描かれた高さで決まる (markdown・highlight・画像は後から伸びる) ので、`useFilterClamp` が本文の要素とその子を ResizeObserver で見て、`scrollHeight > clientHeight` で決める。ブラウザの layout という外の仕組みとの同期なので Effect に置く。測るのはフィルタの中でその項目が見えている間 (その種類の項目、⭐ ならブックマークした項目) だけで、TL の全部の項目には observer を付けない
  - 省いている項目のクリックは、その項目を広げる (`data-expanded`、抑えない) だけで TL に移動しない。省いていない項目 (元から収まる項目と、広げた後の項目) のクリックで TL に移動する。項目の中のボタン (「既読」「許可する」等) のクリックはボタンのもの。広げた状態はフィルタの中の一時の状態で、フィルタを外したり替えたりすると戻る。戻す (抑え直す) 操作は持たない
  - 許可依頼の中身は節の見出しと中身で 8lh を超えることが多く、その依頼は省かれて、TL に移動するには 1 回広げてからもう 1 回押す (最後の行のボタンはそのまま押せる)

### 7. タッチの端末

jsonl のトグルはタッチの端末 (`@media (hover: none)`) では常に薄く (`opacity: 0.45`) 出ている (吹き出しの足元のツールバーも同じ)。☆ も同じ決まりにし (押せない ☆ は 0.25)、⭐ は常に `opacity: 1`。閉じた fold の項目には出さない (右端をスクロールのために触った指で押すため、jsonl と同じ)。

### 8. 組を上に置く項目

`ItemRawToggle` の `controlsAbove` を渡すのはユーザの発言 (`UserPromptBubble`、窓の外のブックマークも) だけ。他の項目 (assistant の応答、許可依頼、ccmsg、say、PushNotification、`!` のコマンド、API エラー、fold の中の行、worker の say) は項目の右上の角に組を置く。

### 9. テストの観点

- protocol: `bookmark_set` / `bookmark_rows` の要求と答え、`ev:"bookmarks"` の見本
- daemon: 付けた順に持つ、ファイルに書いてから答える、変わった時だけ全タブに送る、同じ状態への設定は送らない、session role を断る、購読の時に空でも送る、ファイルの読み戻しと読めないファイル。`bookmark_rows` は行・次の行・結果の行を file の順で返し、transcript に無い uuid は返さず、揃った行は読み直さず、結果待ちの行は次に読み直す
- webui: 項目の ☆⭐ が中身の後にあり、押すと `bookmark_set`、push の後に `aria-pressed` / `StarMark` の `data-shown` / `data-bookmarked` が立つ。押しても項目は選ばれない。どの項目も jsonl のトグルの後に ☆⭐、ユーザの発言だけ組を上に置く印 (`tl-item-controls-above`)、☆⭐ と jsonl は absolute で jsonl のトグルと同じ高さ。uuid の無い項目と agent の TL の ☆ は disabled。⭐ のフィルタは `data-bookmarked` を残し (CSS)、`bookmark_rows` を聞き、窓の外の行を窓と同じ部品で時刻の位置に出し、0 件の時は 1 行。窓の外の行は許可依頼の結果・`!` の出力を付随の行から取る (`listed-bookmarks.ts`)。ヘッダの ⭐ は 🔔🔐 の後、0 で ☆ と数なし、1 以上で ⭐ と数、同じ `StarMark` の要素のまま、filter の link
- クリックで移動: 🔔 / 🔐 / ⭐ の窓の中の項目はすぐ、窓の外の項目は過去分を読んでから移る、読み込みの間は `aria-busy` で次のクリックを受けない、フィルタを離れたら移らない、ボタンのクリックはボタンのもの、worker の say は何もしない、フィルタの無い間は位置の選択のまま。許可依頼の最後の行に「TL に移動」が無い
- フィルタの中の省略: 収まらない本文だけが `data-clamped`、フィルタの外では抑えない、省いている項目のクリックは広げるだけで移らず、次のクリックで移る、収まる項目はすぐ移る、後から伸びた本文も (ResizeObserver で) 省く、項目の中のボタンはボタンのもの、フィルタを外して入り直すと広げた状態が戻る、CSS がフィルタの中でだけ `8lh` で抑え、省いた項目だけ薄くする
- 実ブラウザ (Chromium / WebKit、1280px / 390px): §3 と §5 の実測、§6 の省略の高さと、長い応答・長い許可依頼の省略と広げた後

### 10. 細部の裁定と未決

| # | 論点 | 裁定 |
|---|---|---|
| B1 | 「uuid を持つ項目」とは | uuid を持つ行の項目。境界の行も fold の中の行も TL の位置になれる (§2、kawaz 2026-11-20) |
| B2 | 窓の外のブックマークの中身 | daemon が行と付随の行を返し、webui が窓と同じ処理で描く (§5)。過去分は読まない |
| B3 | 置き場 | `<stateDir>/bookmarks.json` (say-read.json / permit-state.json と同じ層)。走っていないセッションの分も落とさない (§4) |
| B4 | ヘッダの ⭐ の数の色 | 🔔🔐 と同じ赤 (同じ部品・同じ決まり、§5) |
| B5 | フィルタの中での位置の選択 | できなくなる (クリックは移動、§6) |
| B6 | worker の say のクリック | 何もしない (§6) |
| B7 | 組を上に置く項目 | ユーザの発言だけ (§8) |

未決 (kawaz の判断を待つ):

- **U2: ユーザの発言の上の組が前の項目に重なることがある**。組を吹き出しの上の外側に置くので、項目の間の空き (約 5px) より組 (約 15px) が高く、前の項目の右上の端に字があると重なる (前が右詰めのユーザの発言の時刻の行など)。assistant の吹き出しの ⭐ が直前のユーザの発言の時刻に重なっていたのは、組を項目の右上の角に置いたことで無くなった (390px と 1280px で確認)
- **U3: ブックマークの増え方**。transcript が消えたセッションの分もファイルに残り続ける。消す時機 (transcript が見つからなくなった時、手で消す UI) は決めていない
- **U4: ブックマークの一覧の横断**。セッションをまたいだブックマークの一覧は作っていない (🔔🔐 と同じく、セッションの TL の中で見つける)

## Alternatives Considered

| 案 | 採らない理由 |
|---|---|
| ⭐ のフィルタに入る時に、ブックマークの行が全部窓に入るまで過去分を読む | 🔔 / 🔐 のフィルタは過去分を読まない (DR-0050 §9 U8、kawaz 2026-11-08)。フィルタを外した後の窓も変わる |
| 窓の外のブックマークを、daemon が返した行だけで (付随の行なしで) 描く | 許可依頼は結果の行が無いと依頼にならず、`!` のコマンドは出力が無いと出力無しで出る。窓と同じ項目にならない |
| ☆ と ⭐ を同じフォント・同じ字の大きさに揃えて切り替える (`font-variant-emoji` 等) | 字の形も送りもフォントとブラウザで違い、揃わない時に周りが動く。2 つを重ねて大きい方に箱を合わせるのが定番の形で、このリポにもある (`.permit-grant`) |
| 許可依頼の「TL に移動」ボタンを残し、say / ブックマークにも同じボタンを足す | kawaz の依頼 (項目のクリックに揃える)。ボタンは項目ごとに置き場を探す必要があり、say の足元には既読の操作しか置けない |

## Consequences

- daemon が webui のために持つディスクの状態が 3 つになる (say-read.json、permit-state.json、bookmarks.json)
- フィルタの間は項目のクリックで位置を選べない
- `bookmark_rows` は、まだ読んでいないブックマークがある時にそのセッションの transcript を頭から 1 回読む (chunk ごとに event loop を明け渡す、DR-0029)。読んだ行は daemon が止まるまで覚える
- 項目ごとに ☆⭐ のボタンが 1 つ増える (DOM の要素が項目の数だけ増える)

## 関連

- [DR-0050](./DR-0050-timeline-notification-badges.md) — 🔔🔐 のバッジとフィルタ、解除の位置合わせ、窓の外の項目の合流
- [DR-0040](./DR-0040-permit-request-tool.md) §7 — 許可依頼のバブルの最後の行
- [DR-0049](./DR-0049-webui-plamo-translation-tab.md) §8 — 吹き出しの足元の行
- [DR-0054](./DR-0054-timeline-day-bands.md) — 日付の帯の見え方ごとの決め方
- [DR-0056](./DR-0056-scroll-motion-by-cause.md) — 押した移動は短い smooth
- [webui-url-grammar](../design/webui-url-grammar.md) — `filter` の値
