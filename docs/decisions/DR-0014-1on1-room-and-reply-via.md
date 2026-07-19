# DR-0014: 1on1 room + msg 応答経路 hint (`reply_via`)

- **Status**: Accepted (2026-07-14)。§2.4-2.5 の routing hint は
  [DR-0017](./DR-0017-reply-command.md) で `reply_via` 実行指示 + `ccmsg reply`
  に置換された — 1on1 room 本体 (§2.1-2.3, §2.6) は現行仕様のまま
- **Date**: 2026-07-14
- **前提**: [DR-0001](./DR-0001-central-daemon-architecture.md) の room model、[DR-0003](./DR-0003-wire-protocol.md) の post/subscribe semantics、[DR-0006](./DR-0006-id-scheme-v2.md) の u1/aN namespace、[DR-0011](./DR-0011-to-delivery-filter.md) の to=配信フィルタ、[DR-0013](./DR-0013-broadcast-room.md) の broadcast room を前提とする
- **記述規約**: DR-0001 と同じ ([kawaz] / [提案] / [保留])

## 1. Context / 動機

kawaz が新機能を発案 (r12 mid=10 + mid=27、verbatim §7):

- **1on1**: SessionView の Timeline / File viewer 画面から特定 session へ priv を送りたい。1on1 room を経由し、返信は SessionView TL 側で表示。
- **reply_via**: 応答経路の 5〜6 パターンが暗黙知になってきた (通常 room / 通常 room に to / broadcast の u1 priv / broadcast の複数宛 priv / 1on1 tl / 不要) ため、msg jsonl に daemon が応答経路を刻印して agent が迷わず従える形にする。

現状の暗黙応答ルール (SKILL 上の運用):

1. 通常 room で from:agent, to なし → その room に返信
2. 通常 room で from:agent, to あり → その room に to=[from + 元 to - 自分] で返信
3. broadcast room で from:u1 (省略 to) → その room に to:[u1] priv 返信
4. broadcast room で from:u1 (to に自分) → その room に to:[u1] priv 返信 (同上)

追加パターン (今回の 1on1):

5. 1on1 room で from:u1 → 自セッションの TL 側で返信 (webui SessionView TL)
6. archive 済み room 等の惰性 msg → 返信不要 (静穏化)

これらを agent が **pattern match で判定するのではなく、msg 自身が持つ hint を読むだけ** にする。

## 2. Decision

### 2.1 1on1 room = kind:"1on1"

- `create_room` の `kind` に **`"1on1"`** を追加 (`kind: "normal" | "broadcast" | "1on1"`)
- 判別は title 文字列ではなく `room.kind === "1on1"` フィールドで行う (title 文字列一致は typo に弱い)
- 通常 room と storage / id / archive / next_room の経路はすべて共通
- **member 制約**: `kind: "1on1"` は「u1 + 単一 session」の 2 者 room。u1 は暗黙参加、session member は 1 名だけを許容する
  - `create_room --kind 1on1 --members <sid>` で作成、members が空 or 複数だと error
  - auto-populate は行わない (broadcast と違って動的加入なし)
- **agent post 制約はなし** *(2026-07-17 supersede: kawaz r26 mid=85-90 裁定で session 発の 1on1 post は常に reply_via_tl 拒否に変更 — 1on1 の応答は TL が正経路で、room post はユーザから不可視のため。詳細は issue cli-help-diet-and-reply-rails)*: 1on1 は元々「u1 と特定 session の 2 人」なので配信対象は必然的に絞られる

### 2.2 1on1 room の auto-create (webui 側)

- webui の SessionView (Timeline / File viewer) から priv 送信する時、対象 session との 1on1 room を **必要になるまで作らない**、送信時に webui backend (u1 hello) が:
  1. 自分と対象 session の kind:"1on1" room が既存かチェック (rooms 応答から探す)
  2. なければ `create_room --kind 1on1 --members <sid> --title "<リポ名> 1on1 <sid8>"` で作成
  3. 作成 or 既存 room に対して post
- タイトルは表示用のみ、判別は `kind` フィールドで行う (kawaz 表現の「`リポ名 1on1 sid8`」タイトルは表示便宜、判別のロジックは含まない)

### 2.3 1on1 room の subscribe 挙動

- 通常 room と同じ (member/leave/msg すべて配信)。特別な filter なし
- session がメンバーの 1on1 room = agent 側に post が届く (subscribe stream で受信) → agent は §2.4 の reply_via を見て「tl 応答」する

### 2.4 応答経路 hint フィールド `reply_via`

**msg イベントに daemon が刻印する** (自称ではなく) 応答経路の記法。値は文字列。

記法 (kawaz r12 mid=25 提案):

| 値の例 | 意味 |
|---|---|
| `r10` | room r10 で通常 msg 返信 (to なし = room 全員) |
| `r10u1` | room r10 で to:[u1] priv 返信 |
| `r10u1a32a35` | room r10 で to:[u1, a32, a35] priv 返信 (broadcast の複数宛選択返信) |
| `tl` | 自セッションの TL 側で返信 (1on1 room から u1 priv を受けた agent の応答経路) |
| `不要` | 応答不要 (静穏化。archive 済み room の惰性 msg 等) |

**syntax**:

- prefix `r<room-id>` = 対象 room。room-id はサフィックス無しの ID (`r7` / `r10` / `r42` 等、DR-0006 の room id namespace)
- 続く `u<N>` / `a<N>` = to に含める member id を連結 (セパレータなし、id は完全一致で読める)
- `tl` = 特別値、「自セッションの TL」の意
- `不要` = 特別値、応答不要 ([提案] 実装値は `none` などの英語も許容、UI/log 表示時は kawaz 提示の日本語表現も対応)

[提案] 実装での値表現: **daemon 側で発行する値は英字/数字のみ** (`r10u1a32a35` / `tl` / `none`) に統一し、`不要` は agent 側で `none` を表示する時の視覚表現 (SKILL 内での説明) とする。日本語 literal は identifier に混ぜない (typo / エンコード事故耐性)。

### 2.5 daemon の刻印ロジック

daemon は post を受け取った時、room state と参加者情報から `reply_via` を導出して msg イベントに含める:

- **通常 room + to なし** → `reply_via = "r<room-id>"`
- **通常 room + to あり** → `reply_via = "r<room-id>u<...>a<...>"` (from + 元 to - 受信者本人、u1/a{N} を id 順に連結)
- **broadcast room + u1 発 + to なし (全員宛)** → `reply_via = "r<room-id>u1"` (u1 宛 priv 返信)
- **broadcast room + u1 発 + to に個別 session** → `reply_via = "r<room-id>u1a<N>a<M>..."` (元 to の member 全員 + u1)
- **1on1 room + u1 発** → `reply_via = "Reply in your normal assistant response"`
- **archive 済み room からの msg** → `reply_via = "No reply needed"`

補足:

- `reply_via` は **配信先 agent 個々に別値** が入る (受信者を除外して to を構成する規則があるため)
- 保存 (jsonl) には共通の `msg` event として書き、配信時に daemon が受信者ごとの `reply_via` を注入する = event の shape として `reply_via` は **subscribe stream での配送 event に付く post-hoc field**、jsonl storage の永続 event には書かない ([提案] シンプル化のため)
- [保留] archive 済み room の判定は「room の archived: true と、msg の post 時刻が archive_ts 以降か」の 2 段判定 or 単純に room.archived: true → 全 msg に none? — 実装時判断

### 2.6 webui SessionView の 1on1 floating composer

kawaz r12 mid=27 (verbatim §7):

- SessionView の Timeline tab / Files tab の **右下** に position:fixed の **丸い ＋ ボタン** を常時表示
- ＋ ボタン押下 → 1on1 入力欄 (popup) が出現
- 送信ボタンで 1on1 room に post (無ければ §2.2 の手順で auto-create)、入力欄は閉じる
- 閉じるボタンで入力欄を閉じて ＋ ボタン状態に戻る
- **入力中メッセージは localStorage に保存** (key = sid 単位)、再オープンで復元
- 送信時 localStorage を消去
- **cleanup 条件** (リロード時などに実行): 以下のいずれかで localStorage entry を消す
  1. 10 日以上 kawaz 側でアクセスしていない session
  2. 対応する session が既に無い (peers から消えた)

[提案] cleanup は SessionView が mount した時に 1 回スキャンする軽い処理で足りる (専用 scheduler は不要)。

### 2.7 SessionView TL 側の 1on1 応答表示

kawaz r12 mid=25 「既存で既に ccmsg の u1 メッセージ通知は tl に表示される実装がある」を根拠に **追加実装は基本不要**。既存の SessionView Timeline が u1 発の priv を transcript 上に表示する経路がある想定。

[保留] webui 側の実装確認: 実装時に SessionView Timeline (`packages/webui/src/client/components/Timeline.tsx` and SessionView tab) が 1on1 room の u1 msg を表示しているか確認。していない場合は補助 fix を追加。

## 3. Alternatives considered

- **1on1 判別を title 文字列一致 (`"1on1"` を含むか) で行う**: 不採用。typo に弱い、title のリネームで判別が壊れる、識別ロジックが不安定
- **reply_via を jsonl storage にも書く**: 不採用 [提案]。受信者ごとに値が変わるフィールドなので、jsonl (共通 event) に書くと矛盾する。配送 event にのみ post-hoc で注入
- **reply_via 値に日本語 literal (`不要`) を採用**: 不採用 [提案]。identifier に日本語混ぜると encoding / typo 事故のリスク。`none` などの英字値に統一
- **1on1 room の member 上限を 2 に固定しない (multi-user session)**: 不採用。1on1 の意味論は「u1 と 1 session」、複数 session なら通常 room / broadcast room を使う
- **1on1 room に auto-populate を入れる**: 不採用。1on1 は明示的な 2 者 room = 動的加入は不要
- **応答経路をロケータ syntax (`#r7-u1`) で書く**: 不採用 (現状)。ロケータは kawaz 用のリンク記法 (人間読み)、reply_via は agent の hint (機械読み)。ただし §2.4 の `r10u1a32a35` は連結 syntax = ロケータ syntax (セパレータ `-`) との差別化になっている

## 4. 実装スコープ

### 4.1 protocol (`packages/protocol/src/index.ts`)

- `CreateRoomRequest.kind` に `"1on1"` を追加
- `Room.kind` に `"1on1"` を追加
- `MsgEvent` (subscribe stream 配送 event) に `reply_via?: string` を追加 (jsonl storage event には出ない)
- `ErrorCode` に `one_on_one_requires_single_member` (1on1 で members が空 or 複数) を追加

### 4.2 daemon (`packages/daemon/src/server.ts`)

- `create_room --kind 1on1`: members が空 or 複数なら error、正常時は kind:"1on1" で room 開設
- broadcast の auto-populate 対象から 1on1 を除外 (通常 room と同じ扱いにする)
- subscribe stream への配送時に §2.5 の分岐で `reply_via` を計算して msg event に注入
- archive 済み room からの msg には `reply_via = "No reply needed"`

### 4.3 CLI (`packages/cli/src/index.ts`)

- `create-room --kind 1on1 --members <sid>` サブフラグ (broadcast の `--kind broadcast` と同じ扱い)
- `rooms` 出力で kind を表示 (1on1 は "[1on1]" バッジ等)
- agent 側は既存の `post <room> <msg>` で足りる *(2026-07-17 supersede: session 発 1on1 post は reply_via_tl 拒否)*

### 4.4 webui (`packages/webui/src/client`)

- **SessionView (Timeline tab / Files tab)** に floating ＋ ボタン + 1on1 Composer (popup)
- **localStorage**: key = `ccmsg.1on1.<sid>`、value = 入力中テキスト
- **cleanup**: SessionView mount 時に、localStorage の `ccmsg.1on1.*` キーを走査して条件不一致 (10 日 non-active or sid が peers に無い) を削除
- **1on1 room auto-create**: 送信時に `rooms` から自分と対象 session の 1on1 room を探す → 無ければ create_room → post
- **タイトル**: `"<repo> 1on1 <sid8>"` を初回 create 時に付ける (表示用のみ、判別は kind)

### 4.5 SKILL (`skills/ccmsg/SKILL.md`)

- **応答経路 (`reply_via`)** 節を新設:
  - agent は msg event の `reply_via` を読んで、その通りに応答する (pattern match しない)
  - 値と意味の対応表 (§2.4 の表)
  - `none` は応答不要 (静穏化)、無理に返信を返さない
- **1on1 room** 節を新設:
  - 用途 (kawaz が特定 session に priv したい時、webui の SessionView 右下 ＋ ボタンから)
  - agent 側は 1on1 room の `reply_via` が通常の assistant response を指示したら、その経路で返す
  - post 制約なし *(2026-07-17 supersede: session 発は拒否)*

## 5. Open questions

- **reply_via の archive 判定**: 「archive 済み room 全 msg = none」か「archive_ts 以降の post のみ none」か — 実装時判断 [保留]
- **reply_via 値の実装表記**: 日本語 (`不要`) と英語 (`none`) の混在をどこまで許すか — SKILL 表示は kawaz 提示に沿うが、実装 identifier は英字統一 [提案]
- **1on1 title フォーマット**: kawaz 提示は `"リポ名 1on1 sid8"` (日本語空白区切り) だが、リポ名に空白があるとパース不能。実装は `"<repo> 1on1 <sid8>"` (半角空白) を採用予定 [提案]

## 6. Next steps

1. broadcast (DR-0013) 実装バッチ完了後、または並行で 1on1 実装バッチ着手
2. protocol → daemon (kind:"1on1" + reply_via 刻印) → CLI → webui (floating composer + auto-create) → SKILL 追記
3. v0.27.0 想定 (broadcast と 1on1 を同 minor に載せる or 別 minor で分ける — release フローの判断)

## 7. verbatim

### r12 mid=10 (2026-07-14)

> セッションのtimelineビューからメッセージ送信ができるようにしたい。仕様は以下の通り。
> 
> Timeline下部にチャット入力欄を設置
> メッセージ送信すると、
> そのセッションとの1on1ルームが無ければ「リポ名（user無し）1on1 sid8」というタイトルのルームを作成
> 1on1ルームでpriv送信
> タイトルに1on1を含むユーザからのprivへの応答はセッション出力として応答する
> 
> ccmsg経由で話しかけられた際にどこに応答するかのルールが増えてきたのでmsgのjsonlに応答方法を伝えるフィールド追加しても良いかもですね。どう思いますか?
> 
> 今まで出てきたの＋今思いついたのだとこんなとこか？
> ブロードキャストルームでのユーザからのメッセージにはルームのユーザ宛priv
> 1on1ルームのユーザからのprivはセッションtlで応答
> 通常ルーム、from:他セッション、toなし（ルームメッセージ）→ルームへ返信
> 通常ルーム、from:他セッション、toあり→ルームのto:[from+元toリスト-自分]
> 
> ５位はどんなのが良いかな?

### r12 mid=25 (2026-07-14、a3 の OTO-Q1..Q3 提示への回答)

> OTO-Q1
> 既存で既にccmsgのu1メッセージ通知ははtlに表示される実装があるから何もしなくて良い筈。
> 
> OTO-Q2 aパターンとしてはこんな感じに入れときゃ伝わるか？
> r10（ルームメッセージ
> r10u1 （ユーザとpriv
> r10u1a32a35  （ユーザ+3セッション会話priv
> tl（自分のセッションタイムサインに返事
> 不要

### r12 mid=27 (2026-07-14、1on1 の UI 仕様変更)

> 1on1について仕様変更。
> 基本仕様は先ほど伝えた通りだが、tl下に入力欄を置くのをやめる。
> SESSIONのTimelineとFileビューアー画面の右下に 少し大きな丸い＋ボタンを位置固定で常時表示。それを押すと1on1入力欄が出てくる。QUESTIONファイルを見ながらメッセージ書きたいので送りたい時すぐ送れるように。
> 送信ボタンでROOMにprivして入力欄は閉じられる。入力欄には閉じるボタンもあり押すとフォームは閉じてまた＋ボタンに戻る。ただし入力中メッセージはローカルストレージに保存されて再度開くと復元される。送信時は当然ローカルストレージは消す。書きかけが放置された場合のクリーニングはリロード時とかで偶に行えば良く条件は10日以上非アクティブなセッションまたは対応するセッションが無ければ消す。
