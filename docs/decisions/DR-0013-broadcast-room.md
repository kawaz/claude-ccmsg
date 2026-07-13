# DR-0013: broadcast room (auto-populated session broadcast)

- **Status**: Proposed
- **Date**: 2026-07-13
- **前提**: [DR-0001](./DR-0001-central-daemon-architecture.md) の room model、[DR-0003](./DR-0003-wire-protocol.md) の post/subscribe semantics、[DR-0006](./DR-0006-id-scheme-v2.md) の u1 予約参加、[DR-0011](./DR-0011-to-delivery-filter.md) の to=配信フィルタ、[DR-0012](./DR-0012-room-archive-and-kick.md) の archive/kick を前提とする
- **記述規約**: DR-0001 と同じ ([kawaz] / [提案] / [保留])

## 1. Context / 動機

kawaz が新機能を発案 (r12 mid=1、verbatim は §6):

> 生きてる全セッションにブロードキャストする機能が欲しい。特殊なルームとして実装するでも良い。

動機は問題 (5) 「kawaz 混入コスト」の残渣: room 化で AI 同士の広報コスト (「die はああ言ってた」) は消えたが、kawaz が全 active session に自分の意思を届けたい時、まだ手動で `create_room --members <sid の列挙>` を組む必要がある。session が動的に増減する運用 (kawaz の日々の作業では常態) に対して**列挙自体がコスト**。

自動 populate する broadcast primitive でこれを消す。設計上、通常の room の**特殊 kind** として実装する ([kawaz]、「特殊なルームとして実装するでも良い」)。

## 2. Decision

### 2.1 broadcast は room の特殊 kind

- `create_room` に **`kind: "broadcast"`** フラグを追加 (default: `"normal"`)
- storage (room 1 jsonl) / id 体系 / post / read / archive / kick / next_room の経路はすべて通常 room と共通
- 通常 room との差分は **§2.2 auto-populate** と **§2.4 agent post 制約** の 2 点だけ
- 複数の broadcast room を並存できる [kawaz、r12 mid=3「一個限定である必要無し」]

### 2.2 auto-populate: session lifecycle と連動

- daemon が全 broadcast room を追跡し、以下を自動化する:
  - **hello 到達 (新規 session)** → その session を全 broadcast room に自動 join。`{"type":"member","id":"aN","sid":…,"repo":…,"ws":…,"cwd":…,"joined_at":…}` を各 broadcast room の jsonl に append
  - **disconnect (session 終了)** → 全 broadcast room から自動 leave。`{"type":"leave","id":"aN","ts":…}` を append
- **u1 (User)** は既存の暗黙参加ルール (DR-0006) の通り、broadcast room でも常に暗黙 member。member 行なし、明示 join 不要
- **broadcast room 作成時に既に active な session** も同一契機で自動 join する (作成時 1 回だけ scan)

### 2.3 auto-populate イベントは subscribe stream に流さない

- broadcast room の `member` / `leave` イベントは jsonl には書くが、**subscribe stream には配信しない** [kawaz、「そのルームでは他セッションの出入りは AI には通知されない」]
- 通常 room の `member` / `leave` は現状通り subscribe に流れる — broadcast room だけの例外
- webui は `rooms` op の応答から現在の member 一覧を取得する (jsonl 起動時再構築で足りる、既存挙動)
- **監査目的の storage 記録は残す**: 「その時点で誰が active だったか」は archive された jsonl を後から読めば復元できる

### 2.4 agent post 制約: `to: ["u1"]` 必須

- broadcast room 内では、`role: "session"` (agent) からの post は `to` に **`"u1"` を含めることを必須** [kawaz、「そのルームではエージェントはユーザ宛のメッセージしか送れない」]
- daemon が post 受信時に validate、違反したら `broadcast_agent_target_required` (新 error code) で reject
- 他 session id も `to` に混ぜて構わないが、u1 が入っていなければ拒否 (「u1 に情報が届かない agent post」を弾く意図)
- **u1 (User) post には制約なし** — 既存の to semantics (省略=全員、`to: ["a3"]`=個別 session、複数指定=対象 session set) がそのまま働く

### 2.5 u1 の broadcast 用法

- **全 session 宛 broadcast**: `to` を省略した u1 post = broadcast room の全 member に daemon が個別 push する (既存 room 挙動と同じ)
- **個別 session 宛 broadcast (「選択したセッション全てに個別 priv」)**: `to: ["a3", "a7"]` = 選択した session だけ配信 (DR-0011 の配信フィルタ意味論、broadcast context でもそのまま働く)
- kawaz 視点では常に 1 post、agent 視点では自分宛の msg のみ (自分の id が `to` に無い broadcast は subscribe stream に流れない、DR-0011)

### 2.6 返信集約

- broadcast room の timeline がそのまま集約点 [kawaz、「返信があればユーザが見る ROOM には各メッセージが表示される」]
- kawaz は webui で当該 broadcast room を開けば、各 agent の `to: ["u1"]` 返信が時系列で並ぶ (通常 room と同じ表示経路、実装追加なし)

### 2.7 過去 msg の可視性 / 生き死に管理

- 新規 session が auto-join した時の初期配信は **通常 room と同じ** (直近 N=50 msg + since 遡り可能、DR-0003 §5)
- 「ゴミが溜まったら適宜アーカイブして新規で作る」運用で回避 [kawaz、r12 mid=3]
- 新規 session を過去 msg から隔離する仕組み (例: 「join した後の msg しか流さない」フラグ) は導入しない (実装コスト > 便益)

### 2.8 既存 op との共存

- **archive_room / kick / next_room** はいずれも broadcast room に対しても通常 room と同じ挙動を維持する。ただし:
  - **kick は daemon の auto-join と衝突する** (kick した session が次の hello / 現在のコネクションで即 auto-join される)。broadcast room で kick を使う運用は事実上機能しない旨を SKILL に注記 (Open questions §5 参照)
  - **next_room** で作られる新 room は kind を継承する ([提案]、broadcast の次スレも broadcast)

## 3. Alternatives considered

- **完全に別 primitive `create_broadcast` op を新設**: 不採用。既存 room の kind 拡張で足り、CLI/webui/storage が二重にならない。archive/kick も既存 op が使える
- **1 個 global broadcast room に限定**: 不採用 [kawaz r12 mid=3、「一個限定である必要無し」]。目的別 (dev broadcast / debug broadcast など) の使い分けを許容
- **auto-populate せず kawaz が `--members` で列挙**: 不採用。動機 §1 の通り、列挙コストを消すのが本 DR の目的
- **member/leave イベントを storage にも書かない**: 不採用。§2.3 の通り、監査目的で永続記録は残し、subscribe に流さないだけで agent の noise 抑制は達成される

## 4. 実装スコープ

### 4.1 protocol (`packages/protocol/src/index.ts`)

- `CreateRoomRequest` に `kind?: "broadcast" | "normal"` を追加 (default: `"normal"`)
- `Room` 型 (rooms 応答) に `kind` を追加
- `ErrorCode` に `broadcast_agent_target_required` を追加

### 4.2 daemon (`packages/daemon/src/server.ts`)

- broadcast room の kind を storage / in-memory index に保持 (`{type:"kind", kind:"broadcast", ts}` の初期イベント、または create_room 時の `member` 行に kind を書く方式は要検討 — [提案] 別イベント型 `{type:"kind", ...}` を room 開設時に必ず 1 行書くのが素直)
- session hello 直後 / disconnect 直前の hook で全 broadcast room の member 状態を更新
- post op で `room.kind === "broadcast"` かつ `identity.role === "session"` の場合、`to` に `"u1"` が含まれない post を reject
- subscribe stream への dispatch で `room.kind === "broadcast"` の member/leave イベントを stream 対象外にする

### 4.3 CLI (`packages/cli/src/index.ts`)

- `create-room --kind broadcast` サブフラグを追加
- agent 側は既存の `post <room> <msg> --to u1` で足りる (broadcast 特有のサブコマンドは不要)
- `rooms` 出力で kind を表示

### 4.4 webui (`packages/webui/src/client`)

- room リストで broadcast room を kind バッジ (icon or 別色) で区別
- 発話者選択 UI: broadcast room を開いた時、「全員」または「個別 session (checkbox)」を選ぶ入力で `to` 配列を組み立てて post
- broadcast 発足時の Composer には短い hint (「全員 / 個別 session を選択」など)

### 4.5 SKILL (`skills/ccmsg/SKILL.md`)

- broadcast room 節を新設: 用途・agent 側の post 制約 (`--to u1` 必須)・kick が事実上機能しない旨・使い捨てで archive する運用を明記

## 5. Open questions

- **create_room --kind broadcast --members <sid,...> の扱い**: broadcast の意義は auto-populate、明示 `--members` は redundant。案 = 無視 + stderr warning [保留]
- **broadcast room での kick の意味**: kick 直後の hello で再 join される → kick が事実上効かない。「再 join 拒否リスト」を持つかは post-MVP [保留]。DR 上は「kick は使える op として残すが、broadcast では意味を持たない旨 SKILL に注記」で足りる
- **next_room で作られた新 room の kind 継承**: [提案] broadcast を継承する。ただし kawaz レビュー要
- **broadcast room 作成時の初期 msg**: `create_room --kind broadcast --msg "..."` の初期 msg は u1 発の post とみなして受け入れる (通常 room と同じ、post 制約はかからない)

## 6. verbatim (kawaz、r12 mid=1 / mid=3)

`docs/research/` に一次資料として別途収蔵する。以下はカット無しの原文:

**r12 mid=1** (2026-07-13):

> 生きてる全セッションにブロードキャストする機能が欲しい。特殊なルームとして実装するでも良い。どういう抽象化設計が良いかから考えてくれて良い。
> 要件はそこで話せば全員にprivが個別に飛ぶ感じ。まだそのルームに参加してないセッションならジョインさせて飛ばす。そのルームでは他セッションの出入りはAIには通知されない。ユーザは全員または個別セッションを選択して発言すると、選択したセッション全てに対して個別privが飛ぶ。返信があればユーザが見るROOMには各メッセージが表示される。そのルームではエージェントはユーザ宛のメッセージしか送れない。新規セッションがあれば自動ジョインし停止したら自動leaveする。

**r12 mid=3** (2026-07-13、a3 の裁定要点 mid=2 への回答):

> 一個限定である必要無し。過去のブロードキャストはゴミが溜まったら適宜アーカイブして新規で作るでよし。

## 7. Next steps

1. 本 DR を kawaz 確認のうえ Accepted へ
2. Open questions のうち (next_room の kind 継承 / kick の扱い記述) を r12 で追認して確定
3. 実装: protocol → daemon (auto-populate + subscribe filter + post validate) → CLI → webui → SKILL 追記 の順で 1 バッチ
4. v0.27.0 (minor bump、broadcast は additive feature)
