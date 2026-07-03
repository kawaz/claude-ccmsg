# DR-0003: Wire protocol & room semantics

- **Status**: Proposed
- **Date**: 2026-07-03
- **前提**: [DR-0001](./DR-0001-central-daemon-architecture.md) の room model を実装可能な粒度に確定する。一次資料は DR-0001 と同じ
- **記述規約**: DR-0001 と同じ ([kawaz] / [提案] / [保留])

## Context

UDS 上のプロトコルと room イベントの詳細、および DR-0001 が本 DR に委譲した論点 (`to` の複数指定 / 重複排除の「直近」定義 / identity 判定 / self-notify 後継) を確定する。socket と将来の HTTP は同一プロトコルをセキュリティ層越しに共有する [kawaz]。

## Decision

### 1. Frame: 双方向 NDJSON [提案]

- client → daemon: request `{op: "...", ...}` (1 行 = 1 リクエスト)
- daemon → client: 対応する response `{ok: true, ...}` / `{ok: false, error: {code, msg}}` (code は `room_not_found` のような文字列)、および subscribe stream の event 行
- binary frame (msgpack 等) は不採用。NDJSON は jq / 目視で dogfood 効率が高い

### 2. Storage event schema (room jsonl の行) [kawaz スケッチ + 詳細確定]

```jsonl
{"t":"member","id":1,"sid":"…","repo":"…","ws":"…","cwd":"…","joined_at":"…"}
{"t":"leave","id":2,"ts":"…"}
{"t":"msg","mid":3,"from":1,"to":[0],"ts":"…","msg":"…"}
{"t":"move","to_room":"r-…","reason":"…","ts":"…"}
{"t":"title","title":"…","ts":"…"}
```

- `id: 0` は **User (kawaz) の予約 ID** [kawaz]。member 行は不要で **全 room に暗黙に存在** する — user はどの room にも post / read できる [提案]
- `to` は省略可 (全員宛) / 単一 / **配列で複数 mention 可** [保留→本 DR で確定]。意味はアテンションであって可視性フィルタではない (DR-0001 §5)
- `mid` は msg 行のみの room 内連番 (daemon 採番)。イベント全体の順序はファイルの行順が正
- `move` は誘導であって強制ではない (DR-0001 §3)。旧 room はその後も使える

### 3. Identity: hello 申告 + daemon 刻印

- 接続直後に `{op:"hello", role:"session", sid, repo, ws, cwd}` または `{op:"hello", role:"user"}` を送る
- CLI は環境から自動判定: Claude セッション内 (session id が環境に得られる場合) は `session`、素のターミナルは `user`。`--as-user` / `--as-session <sid>` で明示上書き可 [提案]
- daemon は connection → identity を保持し、**post の `from` は daemon が刻印** する (DR-0001 [提案]、自称 `from` を書かせない)。自称 sid の真正性検証はしない (同 UID trust、DR-0001 §5)

### 4. Room 開設と重複排除 [kawaz 2026-07-03 + 詳細確定]

- `{op:"peers"}`: hello 済みで接続中の session 一覧 (sid / repo / ws / cwd)。room 開設時の相手解決に使う [提案]
- `{op:"create_room", members:[sid,…], msg?, title?}`: **daemon が room ID を発行** し、指定 member 全員 (の接続) に開設 event を配る [kawaz]
- **重複排除**: 同一 member set の **open room** (move されておらず、誰も leave していない room) が既に存在すれば新規作成せず reuse する。後発 create に添えられた初期 `msg` は既存 room への post として追記する [kawaz + DR-0001 提案]
- 「直近」の定義は時間 window ではなく **room 状態 (open / moved / left)** で判定する [保留→本 DR で確定]

### 5. subscribe と配送 [kawaz]

- `{op:"subscribe", since?: {"r-…": <mid>, …}}` — このコネクションを常駐 stream 化する
- 配送は **本文込み・room 全メンバー宛**。event 行には `"r": "<room-id>"` を付与して flatten する
- **echo back なし**: 自分の post は自分に流れない
- **join 時初期配信**: room に入れられたら、開設/join event + 現 member 状態 + **直近 N=50 msg** を配る。それより前は `read` で遡る (kawaz「全部または直近N件、その前が気になるなら遡れば良い」)。[保留] N の値は dogfood で調整
- **since 指定 replay**: 各 room の since-mid より後の行を全て配る。mid が連番なので抜け検出・再取得はクライアント側で自明にできる (BBS モデル、DR-0001 §6)
- user (id 0) が subscribe した場合は **全 room の event** を受ける (kawaz UI 用) [提案]

### 6. read / rooms (補完コマンド) [kawaz]

- `{op:"read", room, mids:"10-15" | [10,11,15]}`: mid 指定の取得。**非メンバーからも可** (同 UID trust の BBS モデル。「C に mid10-15 辺り読んでと言えば良い」)
- `{op:"rooms"}`: room 一覧 (id / title / members / last_mid / last_ts)

### 7. notify — self-notify の後継 (room 外 primitive) [提案]

- `{op:"notify", sid?, text}`: 指定 session (省略時は自分) の subscribe stream に ephemeral event `{ev:"notify", text}` を流す。**storage には書かない** (fire-and-forget)
- 用途は push-workflow の `cmux-msg notify --self` 後継 (justfile → 自セッションの AI へのシグナル)。会話ではなく通知なので room model の外に置くのが責務として正しい。echo back なし原則とも干渉しない
- これで DR-0001 §13 の移行 blocker は解消: justfile 側は `ccmsg notify --self --text "…"` に置換できる

### 8. ping [提案]

- `{op:"ping"}` → `{ok:true, pong:true, version, uptime}`。DR-0002 の health check / version mismatch 検出に使う

## Alternatives considered

- **self-notify を self room (1 人 room) で表現**: 不採用。echo back なし原則と正面衝突し、シグナル用途に永続 log は過剰
- **`to` を可視性フィルタにする**: 不採用済み (DR-0001 §5、kawaz 2026-07-03 決定)
- **member set の時間 window による重複排除**: 不採用。状態判定 (open/moved/left) の方が説明可能で、dormant room との再会話も「leave しておけば新規」と利用者が制御できる
- **binary frame**: 不採用 (§1)

## Open questions

- HTTP transport への同一プロトコルの載せ方 (WebSocket / SSE の選定) — webui phase の DR
- room ID の具体形式 (`r-` + 桁数) — 実装時
- 初期配信 N=50 の妥当性 — dogfood で調整

## Next steps

1. MVP 実装 (`packages/daemon` + `packages/cli`) で本 DR を実装
2. SKILL (AI 向け使い方ガイド) に短文文化・mention 運用を書き起こす (実装後)
