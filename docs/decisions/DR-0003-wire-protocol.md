# DR-0003: Wire protocol & room semantics

- **Status**: Accepted (2026-07-03)
- **Date**: 2026-07-03
- **前提**: [DR-0001](./DR-0001-central-daemon-architecture.md) の room model を実装可能な粒度に確定する。一次資料は DR-0001 と同じ
- **記述規約**: DR-0001 と同じ ([kawaz] / [提案] / [保留])

## Context

UDS 上のプロトコルと room イベントの詳細、および DR-0001 が本 DR に委譲した論点 (`to` の複数指定 / 重複排除の「直近」定義 / identity 判定 / self-notify 後継) を確定する。socket と将来の HTTP は同一プロトコルをセキュリティ層越しに共有する [kawaz]。

## Decision

### 1. Frame: 双方向 jsonl [提案]

- client → daemon: request `{op: "...", ...}` (1 行 = 1 JSON)
- daemon → client: 対応する response `{ok: true, ...}` / `{ok: false, error: {code, msg}}` (code は `room_not_found` のような文字列)、および subscribe stream の event 行
- 呼称は storage / wire とも **jsonl** で統一する [kawaz]

### 2. Storage event schema (room jsonl の行) [kawaz スケッチ + 詳細確定]

```jsonl
{"type":"member","id":"a1","sid":"…","repo":"…","ws":"…","cwd":"…","joined_at":"…"}
{"type":"leave","id":"a2","ts":"…"}
{"type":"msg","mid":3,"from":"a1","to":["u1"],"ts":"…","msg":"…"}
{"type":"next","room":"<room-id>","ts":"…"}
{"type":"prev","room":"<room-id>","ts":"…"}
{"type":"title","title":"…","ts":"…"}
```

- フィールド名は `type` を採用 [kawaz 2026-07-03]。`t` は `ts` と紛れやすいため。**`id` = room 内参加者 id** (型付き文字列 `u1` / `a1`…、名前空間と採番は [DR-0006](./DR-0006-id-scheme-v2.md)) であり、Unix の UID とは別物 (threat model 等で Unix 側を指す時は「UID (Unix)」と書き分ける)
- `u1` は **User (kawaz) の予約 id** [kawaz]。member 行は不要で **全 room に暗黙に存在** する — user はどの room にも post / read できる [提案]
- `from` / `to` は member id を指す。`to` は省略可 (全員宛) / 単一 / **配列で複数指定可** [保留→本 DR で確定]。`to` の配信上の意味は [DR-0011](./DR-0011-to-delivery-filter.md) (配信フィルタ) が正本
- `mid` は msg 行のみの room 内連番 (daemon 採番)。イベント全体の順序はファイルの行順が正
- `next` / `prev` は **スレッドリンク** [kawaz]: 会話が長くなったら適度に次スレ (新 room) に分割する。daemon が旧 room に `next`、新 room に `prev` を対で書き、ユーザ UI でもリンクを辿れる。移行は強制ではなく **旧スレもそのまま使える**

### 3. Identity: hello 申告 + daemon 刻印

- 接続直後に `{op:"hello", role:"session", sid, repo, ws, cwd}` または `{op:"hello", role:"user"}` を送る
- **CLI の sid 自動判定順** [kawaz 2026-07-12 裁定]: `--as-session <sid>` > `CCMSG_SID` > `CLAUDE_CODE_SESSION_ID` > (無ければ null)
- **write 系 op (`post` / `create_room` / `next_room` / `leave` / `notify`) は identity 無しなら CLI が error 終了**する [kawaz 2026-07-12]。sid の無い CLI が u1 (User) 名義で書けると、受信側の「`from: "u1"` = ユーザ発言」判定が狂う。u1 発行経路は webui backend の `role: "user"` hello 一本に絞る
- **subscribe だけは identity 無しでも許容**し、CLI は stderr に警告を出しつつ `role: "user"` で hello する。kawaz が素のターミナルから u1 として観測する経路
- daemon 側: `IDENTITY_OPS` (post/create_room/next_room/…/subscribe/notify) が hello 必須ゲート、`role: "user"` hello は webui backend の合法経路として受理する。CLI 経由の u1 化を塞ぐ責任は CLI 側にある (指示側 client のポリシーであって、wire protocol の禁則ではない)
- daemon は connection → identity を保持し、**post の `from` は daemon が刻印** する (DR-0001 [提案]、自称 `from` を書かせない)。自称 sid の真正性検証はしない (同 UID trust、DR-0001 §5)

### 4. Room 開設と重複排除 [kawaz 2026-07-03 + 詳細確定]

- `{op:"peers"}`: hello 済みで接続中の session 一覧 (sid / repo / ws / cwd)。room 開設時の相手解決に使う [提案]
- `{op:"create_room", members:[sid,…], msg?, title?}`: **daemon が room ID を発行** し、指定 member 全員 (の接続) に開設 event を配る [kawaz]
- **room ID の形式は `r<N>`** (N は daemon 採番の連番、既存の最大 N + 1)。ID 自体は不透明値として扱う (daemon も client も構造を読まない) が、**先頭の `r` と `r<N>m<M>` ロケータ** は CLI (`ccmsg read r12m3`、`ccmsg reply r12m3`) と webui (URL の room / session 判別) が共通に解釈するため、ここは仕様で固定する [提案、実装済みの事実を明文化]
- **重複排除は時間で判定** [kawaz 2026-07-03]: 同一 member set の room が **直近 T 以内**に作られていれば新規作成せず reuse する。後発 create に添えられた初期 `msg` は既存 room への post として追記する。T の既定値は **60 秒** (`DEFAULT_DEDUP_WINDOW_MS`)。[提案: 根拠の言語化] 目的は同時開設 race の吸収なので、複数セッションが同じ指示を受けて create_room に至るまでの時間差 (数秒〜数十秒) を覆えばよく、それより長いと「同じ相手と改めて別の話を始める」正当な create が reuse に吸われる
- `{op:"next_room", room, msg?, title?}`: **次スレ発行** [kawaz]。daemon が新 room を発行して旧 room の member を引き継ぎ、旧→新 `next` / 新→旧 `prev` リンクを対で書き、**全 member に次スレ開設が通知される**。`msg` は新 room の最初の post になる。重複排除の対象外 (= 同じ相手との新部屋は leave せずともこれで作れる)
- `{op:"leave", room}`: 退出。member イベントの対になる `leave` イベントを追記する [提案]。CLI は `leave` サブコマンドとして提供

### 5. subscribe と配送 [kawaz]

- `{op:"subscribe", since?: {"<room-id>": <mid>, …}}` — このコネクションを常駐 stream 化する
- 配送は **本文込み・room 全メンバー宛**。event 行には `"r": "<room-id>"` を付与して flatten する
- **自分の post は本文なしの軽量エコー**として配信する (session role の subscriber)。`msg` を落として `msg_via` (= `ccmsg read r<N>m<M>` 参照) に差し替え、`echo: true` を付け、`reply_via` は付けない。`seq` は残す (CLI の cursor がエコー済み post を追い越せる)。storage は不変で、変換は配信時のみ (`reply_via` と同じ流儀)。live deliver / cursor replay / recent-replay / 新 room snapshot の全経路に一様に適用する。user role (webui) 向けは全文を配る — 自分の送信は composer 側で描画済みで、かつ observation surface として全文が要る
  - 目的は 2 つを同時に満たすこと: AI が自分の post を開封して「自分のでした」と報告する無駄を作らない (`echo: true` が「開封不要」の機械判定になる) / **session log にルーム発言の記録が残る** (webui の TL が自 post を daemon 原本から復元できる)
- **join 時初期配信**: room に入れられたら、開設/join event + 現 member 状態 + **直近 N=50 msg** を配る。それより前は `read` で遡る (kawaz「全部または直近N件、その前が気になるなら遡れば良い」)。N は AI セッションの context cost を抑える上限で、user role には全件を配る
- **since 指定 replay**: 各 room の cursor より後の行を全て配る。cursor の座標は [DR-0016](./DR-0016-storage-event-seq.md) の `seq` (全 event 型横断)。連番なので抜け検出・再取得はクライアント側で自明にできる (BBS モデル、DR-0001 §6)
- user (u1) が subscribe した場合は **全 room の event** を受ける (kawaz UI 用) [提案]

### 6. read / rooms (補完コマンド) [kawaz]

- `{op:"read", room, mids:"10-15" | [10,11,15]}`: mid 指定の取得。**非メンバーからも可** (同 UID trust の BBS モデル。「C に mid10-15 辺り読んでと言えば良い」)
- `{op:"rooms"}`: room 一覧 (id / title / members / last_mid / last_ts)

### 7. notify — self-notify の後継 (room 外 primitive) [提案]

- `{op:"notify", sid?, text}`: 指定 session (省略時は自分) の subscribe stream に ephemeral event `{ev:"notify", text, from}` を流す。**storage には書かない** (fire-and-forget)。`from` は daemon が接続 identity から刻印する (`{role:"user"}` または `{role:"session", sid}`) — 受信側が **self notify (実行可) と peer notify (自動実行禁止)** を判別するための必須フィールド [提案]
- 用途は push-workflow の `cmux-msg notify --self` 後継 (justfile → 自セッションの AI へのシグナル)。会話ではなく通知なので room model の外に置くのが責務として正しい

### 8. ping [提案]

- `{op:"ping"}` → `{ok:true, pong:true, version, uptime, pid, rooms, clients}`。DR-0002 の health check / version mismatch 検出 / `ccmsg status` の表示に使う

## Alternatives considered

- **CLI に `--as-user` フラグを残して kawaz がターミナルから u1 として post できる状態**: 不採用 [kawaz 2026-07-12]。kawaz は webui からしか write しない運用と決まり、CLI から u1 発行できる経路自体を消すことで「sid 未設定 sidecar が u1 に化ける」事故モードごと排除する。write は webui backend (`role: "user"` hello) 経由に一本化
- **write 系 identity 無しを warning にとどめて post を通す**: 不採用 [kawaz 2026-07-12、`docs/issue/2026-07-12-prevent-u1-masquerade-on-missing-sid.md`]。stderr 警告では Monitor 経由の AI サイドカー・agent は気付けず、実際に誤配信が起きた。hard error にして「気付かせる」ほうが安全
- **自分の post を一切配信しない (echo back なし)**: 不採用 [kawaz 2026-07-29、`docs/issue/2026-07-29-self-ccmsg-post-bubbles-missing`]。開封の無駄は消えるが、session log にルーム発言の記録が残らず、webui の TL が Bash tool result のパターンマッチで復元する hack を要した。本文なしエコー (§5) が両方を満たす
- **self-notify を self room (1 人 room) で表現**: 不採用。シグナル用途に永続 log は過剰で、自 post のエコー規則 (§5) とも噛み合わない
- **`to` を可視性フィルタにする**: 不採用 [kawaz 2026-07-03]。storage / `read` からは隠さない (DR-0001 §5)。配信の絞り込みは DR-0011
- **room 状態 (open / moved / left) による重複排除**: 不採用 [kawaz 2026-07-03]。leave しない限り同じ相手との新 room が作れなくなり、次スレ運用と噛み合わない。時間 window + `next_room` の明示経路の方が柔軟
- **`move` (引越し) 語彙**: 不採用 [kawaz 2026-07-03]。room が daemon 発行になった時点で「専用部屋からの引越し」ではなく「次スレ/前スレのリンク」がモデルとして素直。`next` / `prev` の対リンクに置き換え
- **binary frame (msgpack 等)**: 不採用。jsonl は jq / 目視で dogfood 効率が高い
- **`CLAUDE_SESSION_ID` env を sid 判定順に含める**: 不採用。Claude Code 実環境に存在しない

## Open questions

- HTTP transport への同一プロトコルの載せ方 (WebSocket / SSE の選定) — webui phase の DR

## Next steps

1. MVP 実装 (`packages/daemon` + `packages/cli`) で本 DR を実装
2. SKILL (AI 向け使い方ガイド) に短文文化・mention 運用を書き起こす (実装後)
