# DR-0058: TL の項目のブックマーク (☆ / ⭐、daemon がセッションごとに持つ uuid の列、ヘッダの ⭐ のフィルタ)、フィルタの項目のクリックで TL に移動

- Status: Accepted (2026-11-20、kawaz の依頼を元に統括が決定、細部はワーカーが §10 に起草) — ✅ 実装済み (protocol の `bookmarks.ts` (`bookmark_set` / `bookmark_rows` / `ev:"bookmarks"`)、`Paths.bookmarks`、`TimelineFilter` の `bookmark`、daemon の `bookmarks.ts` と `server.ts` の 2 つの op、webui の `StackedLabels` / `StarMark`、SESSIONS の並べ替えのボタン、`timeline/bookmark.tsx` の `BookmarkStar` / `MergedItem`、`ItemRawToggle` の ☆⭐、`listed-bookmarks.ts`、`useBookmarkRows`、`TOOLBAR_BADGE_KINDS`、Timeline の `itemBodies` / `jumpTo`、app.css の `.star-mark` / `.tl-item-star` / `.tl-lines[data-filter="bookmark"]`)
- Date: 2026-11-20

## Context

kawaz の依頼 (2026-11-20) の要点:

- TL の項目をブックマークしたい。保存は say や permit と同じく daemon がセッション単位で永続化する。中身はセッションごとの uuid の配列
- uuid を持つ項目に ☆ / ⭐ を出してトグルする。uuid を持たない項目にも ☆ は出すが、押しても何も起きない
- ☆ と ⭐ の大きさはフォントでずれないようにする (どこで使うものも)
- ⭐ の位置: 吹き出しの形の項目は anchor positioning で吹き出しの右上の外側 (☆⭐ の bottom = 吹き出しの top、right = 吹き出しの right) に常に出す。吹き出しでない項目は jsonl が出る位置の右側に常に出す。☆ は jsonl と同じ出る決まりでよい
- TL のヘッダには 🔔 🔐 ⭐ が並ぶ。⭐ には常に数を付け、0 なら ☆。数が付いても幅が変わらない
- ヘッダの ⭐ で say / permit とほぼ同じフィルタがかかる。フィルタ中に項目をクリックすると「TL に移動」が働き、TL にその uuid が読み込まれていなければ読み込む (permit と同じ)
- say のフィルタにも項目のクリックで TL に移動を足す。permit の項目に個別に出ている「TL に移動」ボタンは無くし、項目のクリックの形に揃える

## Decision

### 1. 目的

TL の中で後から戻りたい項目に印を付け、どの端末・どのタブからでもその項目へ戻れるようにする。🔔 / 🔐 のフィルタと同じ入口・同じ見せ方・同じ戻り方 (項目のクリックで TL のその位置へ) にする。

増やしたくないもの:

- 印の正本と経路 (daemon が持ち、`ev:"bookmarks"` で全タブに配る。webui 側に別の印の状態を持たない。DR-0050 §1 と同じ)
- TL の描画の経路 (フィルタ用に TL を別に描かない。窓の外の項目も、窓がその行を描くのと同じ部品で描く)
- 項目の種類ごとの「TL に移動」の作り (say / 許可依頼 / ブックマークで 1 つのクリックの規則)

### 2. 何をブックマークできるか

- ブックマークは transcript の行の uuid。持てるのは **TL の位置 (`/s/<sid>/timeline/<uuid>`) になれる項目**、つまり `ItemRawToggle` が `uuid` を渡されて `data-timeline-uuid` を持つ項目 (窓の境界の行: ユーザの発言、assistant の応答、API エラー、`!` のコマンド、say、PushNotification、許可依頼、ユーザ発の ccmsg)。ブックマークに戻る操作は「その位置へ移る」(§6) なので、位置になれない項目に付けても戻れない
- uuid を持たない項目 (位置になれない項目) は ☆ を押せない (disabled) で出す: fold の中の行 (thinking、tool の行、システム由来の行、peer 発の ccmsg)、worker の say と、🔔 / 🔐 のフィルタが窓の外から合流させた say / 許可依頼 (行の uuid を持たない)。agent の TL では全部 (agent の TL は位置を URL で表せず、DR-0025 / usePositionPin.ts)
- 押せない ☆ は既存の押せないボタンと同じく薄く (hover の間 `opacity: 0.35`、タッチの端末では 0.25) し、カーソルを普通の矢印にする。title で「位置を持たないのでブックマークできない」と出す

### 3. ☆ / ⭐ の部品と置き場

- **`StackedLabels`** (Preact の部品と `.stacked-labels`): 入れ替わるラベルの候補を全部 `display: inline-grid` の箱の同じ升目 (`grid-area: 1 / 1`、`place-items: center`) に重ね、見せない方を `visibility: hidden` で隠す。どれを見せるかは箱の `data-shown` (候補の番号) で CSS が切り替え、JS で大きさを測らない。箱は一番大きい候補の大きさのままなので、切り替えて周りが動かない。候補は 6 つまで (CSS の規則の数、`STACKED_LABELS_MAX`)。許可依頼の「許可する / 許可済み / コピーしました」(DR-0040 §7、`.permit-grant`) と同じ形。使う所:
  - `StarMark` (`.star-mark`): ☆ (文字) と ⭐ (絵文字)。フォントも字の送りも違うので、どちらか 1 つだと箱の大きさが変わる。項目の ☆⭐ と TL のヘッダの ⭐ の両方
  - SESSIONS の並べ替えのボタン (`#peers-sort`): prompt / name / created / recent。押すたびに字の幅でボタンの幅が変わっていた (kawaz 2026-11-20)。見た目と動きはそのままで、ボタンの名前 (`aria-label`) は今の並べ方のラベル。実測で 4 つの並べ方の幅が同じ (Chromium 49.48px、WebKit 52.80px、1280px と 390px)
- **項目の ☆⭐** (`BookmarkStar`、`.tl-item-star`): 項目の包み (`ItemRawToggle`、合流させた項目の `MergedItem`) の最後の子のボタン。大きさは決まった正方形 (`--tl-star-size`) で、中の `StarMark` を真ん中に置く。吹き出しの項目では 1.5rem。吹き出しでない項目では隣の jsonl のトグルと同じ高さ (字の大きさ 0.6rem + 上下の余白 + 枠) に字の大きさ 0.7rem で収める: 項目の先頭の行 (fold の summary など小さい字の行) より高い箱を置くと、項目の下へはみ出して次の項目との間が詰まって見える (kawaz 2026-11-20)。箱は absolute なので項目の高さには入らない。`aria-pressed` が ⭐ かどうか。押すと `bookmark_set` を送る (非楽観、§4)。ボタンのクリックは項目の選択・移動に数えない (raw.tsx の `selectPositionOnClick` と同じく button は除く)
  - 出る決まり: ⭐ は常に出す。☆ は jsonl と同じ (項目の hover / focus の間、タッチの端末では常に薄く `opacity: 0.45`)。閉じた fold の項目 (jsonl を出さない項目と同じ判定) には ☆ も出さない
  - 吹き出しでない項目: 項目の右上の角 (`top: 0; right: 0`)。jsonl のトグルはその左に並ぶ (`right: calc(var(--tl-star-size) + var(--space-2))`)
  - 吹き出しの形の項目 (`.tl-item-bubble`、DR-0049 §8 の jsonl を足元に置く項目): 吹き出しの本文の枠 (`.tl-bubble-body`) の右上の外側。`anchor-name` を本文の枠に、`anchor-scope` を項目に付け、`bottom: anchor(top); right: anchor(right)`。本文の枠に吊るのは、`.tl-bubble` 自体は足元の行 (hover で出るツールバーの場所を常に取る) の幅まで広がり、左寄せの短い吹き出しでは見える枠より右に伸びるため。jsonl を出している間は本文の枠が隠れて元の行が出るので、元の行 (`.tl-bubble > .tl-raw-view`) にも同じ名前を付ける (後に来る方が使われる)。`anchor-scope` を持たないブラウザは項目の右上の角のまま (☰ のメニューと同じ扱い、同じ名前の anchor が文書全体で 1 つに解決されると Chromium の layout が超線形に重くなる)
  - z-index は付けない。吹き出しの上の ☆⭐ は前の項目の領域に重なるので項目の中身より上に描かれるが (位置指定の要素)、sticky な TL のツールバー (`z-index: 1`) より下になる。着地した吹き出しの ☆⭐ はツールバーの下に隠れる
- 実測 (Chromium / WebKit、1280px / 390px、隔離 daemon と fixture): 吹き出しでない項目の高さは ☆⭐ を置いても置かなくても同じ (☆⭐ を `display: none` にして測り直して一致)、☆⭐ の箱の高さは jsonl のトグルと同じ (14.80px / 14.78px)。吹き出しの ☆⭐ の下端 = 本文の枠の上端、右端 = 本文の枠の右端 (jsonl を出している間は元の行の枠)。吹き出しでない項目の ☆⭐ の右端・上端 = 項目の右端・上端、jsonl の右端 < ☆⭐ の左端

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

- TL のヘッダ (`tl-toolbar` の左端、DR-0050 §3) に 🔔 🔐 ⭐ の順に並べる (`TOOLBAR_BADGE_KINDS`)。⭐ の数はそのセッションのブックマークの数で、🔔🔐 と同じ数を重ねる部品 `CountBadge` と同じ決まり (1 から数字、100 以上は `99+`、0 は数字なし。数の枠は absolute なので数の有無で幅が変わらない)。中身は `StarMark` で、0 なら ☆、1 以上なら ⭐。Sessions の行には出さない (行のバッジは「今呼ばれているのはどれか」を見つけるもの、DR-0050 §7)。agent の TL では出さない (🔔🔐 と同じ)
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

### 7. タッチの端末

jsonl のトグルはタッチの端末 (`@media (hover: none)`) では常に薄く (`opacity: 0.45`) 出ている (吹き出しの足元のツールバーも同じ)。☆ も同じ決まりにし (押せない ☆ は 0.25)、⭐ は常に `opacity: 1`。閉じた fold の項目には出さない (右端をスクロールのために触った指で押すため、jsonl と同じ)。

### 8. 吹き出しの形の項目の列挙

`ItemRawToggle` の `bubble` を渡す項目 (= `.tl-bubble` と `BubbleFooter` を持ち、jsonl を足元に置き、☆⭐ を吹き出しの右上の外側に置く項目):

- ユーザの発言 (`UserPromptBubble`)
- assistant の応答 (`AssistantBubble`)
- 許可依頼 (`PermitRequestBubble`、窓の外の依頼も)
- ccmsg のメッセージ (`CcmsgBubble`、ユーザ発の境界の行と、fold の中の peer 発の両方)

say と PushNotification (`.say`、足元は `say-footer`) と、`!` のコマンド (`BashRunCard`)、API エラー (`ApiErrorNotice`)、fold の中の行、worker の say は吹き出しでない項目として扱う (☆⭐ は項目の右上の角、jsonl はその左)。

### 9. テストの観点

- protocol: `bookmark_set` / `bookmark_rows` の要求と答え、`ev:"bookmarks"` の見本
- daemon: 付けた順に持つ、ファイルに書いてから答える、変わった時だけ全タブに送る、同じ状態への設定は送らない、session role を断る、購読の時に空でも送る、ファイルの読み戻しと読めないファイル。`bookmark_rows` は行・次の行・結果の行を file の順で返し、transcript に無い uuid は返さず、揃った行は読み直さず、結果待ちの行は次に読み直す
- webui: 項目の ☆⭐ が中身の後にあり、押すと `bookmark_set`、push の後に `aria-pressed` / `StarMark` の `data-shown` / `data-bookmarked` が立つ。押しても項目は選ばれない。吹き出しの ☆⭐ は吹き出しの後。uuid の無い項目と agent の TL の ☆ は disabled。⭐ のフィルタは `data-bookmarked` を残し (CSS)、`bookmark_rows` を聞き、窓の外の行を窓と同じ部品で時刻の位置に出し、0 件の時は 1 行。窓の外の行は許可依頼の結果・`!` の出力を付随の行から取る (`listed-bookmarks.ts`)。ヘッダの ⭐ は 🔔🔐 の後、0 で ☆ と数なし、1 以上で ⭐ と数、同じ `StarMark` の要素のまま、filter の link
- クリックで移動: 🔔 / 🔐 / ⭐ の窓の中の項目はすぐ、窓の外の項目は過去分を読んでから移る、読み込みの間は `aria-busy` で次のクリックを受けない、フィルタを離れたら移らない、ボタンのクリックはボタンのもの、worker の say は何もしない、フィルタの無い間は位置の選択のまま。許可依頼の最後の行に「TL に移動」が無い
- 実ブラウザ (Chromium / WebKit、1280px / 390px): §3 と §5 の実測

### 10. 細部の裁定と未決

| # | 論点 | 裁定 |
|---|---|---|
| B1 | 「uuid を持つ項目」とは | TL の位置になれる項目 (`data-timeline-uuid` を持つもの、§2)。fold の中の行も jsonl の行としては uuid を持つが、TL の位置になれず §6 の移動ができないので押せない ☆ にする |
| B2 | 窓の外のブックマークの中身 | daemon が行と付随の行を返し、webui が窓と同じ処理で描く (§5)。過去分は読まない |
| B3 | 置き場 | `<stateDir>/bookmarks.json` (say-read.json / permit-state.json と同じ層)。走っていないセッションの分も落とさない (§4) |
| B4 | ヘッダの ⭐ の数の色 | 🔔🔐 と同じ赤 (同じ部品・同じ決まり、§5) |
| B5 | フィルタの中での位置の選択 | できなくなる (クリックは移動、§6) |
| B6 | worker の say のクリック | 何もしない (§6) |
| B7 | 吹き出しの形の項目 | §8 の 4 種。say / PushNotification は `.say` の別の形なので含めない |

未決 (kawaz の判断を待つ):

- **U1: fold の中の行 (thinking、tool の行) のブックマーク**。今は押せない ☆。付けられるようにするには、fold の中の行を TL の位置にする (`data-timeline-uuid`、着地の時に閉じた fold を開く) 必要があり、位置の文法 (DR-0009 / usePositionPin.ts の「位置は境界の吹き出しだけ」) を変えることになる
- **U2: 吹き出しの ☆⭐ が前の項目に重なる**。吹き出しの上端の上に置くので、項目の間の空きより ☆⭐ が高いと前の項目の下端 (右寄せのユーザの吹き出しの時刻の行など) に重なる。390px で、左寄せの assistant の吹き出しの ⭐ が直前のユーザの吹き出しの時刻に重なるのを実測した。指示どおりの位置のままにしている
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
- [DR-0049](./DR-0049-webui-plamo-translation-tab.md) §8 — 吹き出しの足元の行と jsonl の置き場
- [DR-0054](./DR-0054-timeline-day-bands.md) — 日付の帯の見え方ごとの決め方
- [DR-0056](./DR-0056-scroll-motion-by-cause.md) — 押した移動は短い smooth
- [webui-url-grammar](../design/webui-url-grammar.md) — `filter` の値
