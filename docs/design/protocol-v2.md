# protocol v2 設計 (規約ファーストの契約)

- Status: **Draft** (統括判断で確定して進める。§9 の判断に異論があれば kawaz が直す)
- 関係: [DR-0032](../decisions/DR-0032-repo-split-protocol-first.md) (リポ分離・規約ファースト)、
  [issue multi-host-cluster](../issue/2026-09-07-multi-host-cluster.md) (instance / mesh)、
  DR-0003 (wire v1)、DR-0016 (per-room seq)、DR-0029 追補 (request_id)
- 一次資料: [protocol 棚卸し](../findings/2026-09-07-protocol-inventory.md)、
  [daemon 棚卸し](../findings/2026-09-07-daemon-inventory.md)、
  [webui 棚卸し](../findings/2026-09-07-webui-component-inventory.md)

## 1. v2 が解く問題 (棚卸しで確定した事実)

| # | 事実 | v2 での扱い |
|---|---|---|
| 1 | op 56 のうち user-only 36 (64%)。エージェント間メッセージングと webui の API が 1 本の wire に同居 | 面 (plane) を分ける (§2) |
| 2 | 契約に検証コードが無い (型だけ)。検査は daemon の手書き、`ErrorCode` はクライアントが import しない | 契約を実行可能にする (§7) |
| 3 | op の属性 (role / hello 必須 / 能力) が daemon の分岐 (35 個の同型コピー + Set) と hello のフラグ 6 個に二重管理 | op 属性表を契約側に持つ (§3) |
| 4 | 時刻の単位が名前と一致しない (ISO 21 / ms 24、`ts` `started_at` `created_at` が型で単位違い) | 表記規約を 1 つに (§5) |
| 5 | 正本が誰か (daemon / claude agents / gateway の pass-through) が型ごとに宣言されていない | 型に「正本」を宣言 (§4) |
| 6 | instance / mesh の概念が 0 件 (room id は daemon ローカル連番、転送の封筒なし、到達不能のエラーなし) | instance を第一級に (§6) |
| 7 | 同じ情報を複数経路で送る (status 3 経路、room 履歴 4 経路) | 経路を「snapshot + delta」の 1 形に (§3.3) |

## 2. 面 (plane) の分離

| 面 | 誰が使うか | 中身 | 輸送 |
|---|---|---|---|
| **messaging** | エージェント (session role)、人 (webui 経由) | **1 対 1 の配送だけ** (user ↔ session、session ↔ session)、返信経路、notify、say | UDS (同一 instance) / WS |
| **control** | webui、CLI の管理コマンド (user role) | セッション観測・操作、transcript、fs、launcher、sandbox、llm-* | WS / HTTP |
| **mesh** | instance 同士 | 他 instance への op 転送、event の relay、instance の生死 | WS (instance 間) |

### 2.1 messaging は room を持たない (kawaz r278m63/m64)

複数メンバーの会話 (room) は初期に数回使われた後は使われておらず、会話の様子は webui が
transcript で全部見せている。よって v2 の messaging は **会話の器を持たず、sid 宛の配送に縮める**:

- `message_send {to: sid, text}` と、受信側への配送 (返信経路の指示を含む)、`say`、`notify`
- 会話ログの正本は transcript (Timeline)。ccmsg 側の永続ログ (room jsonl)、`mid` / `seq`、既読カーソル
  (BBS モデル、DR-0001 §4〜§6)、replay 窓は持たない
- 未配送メッセージは **sid 単位の inbox に溜め、受信できるようになった時に配送する** (PV-Q8 = a、
  kawaz r278m65)。即時配送されなかった時は送信側の応答に理由を返す: 相手が準備中 (subscribe 未起動) /
  Paused / Disappeared / instance に到達不能。送信側 (エージェント) はそれを見て待つか諦めるかを決める。
  宛先が Paused / Disappeared の時は、**同じ cwd (repo / ws) で今動いているセッションがあれば候補 sid を
  添える** (宛先が新しいセッションに世代交代している場合、送信側がそちらへ送り直せる。kawaz r278m66)
- 同一 config home 内の session ↔ session は Claude Code 本体の cross-session メッセージ
  (`sessions/<pid>.json` の `messagingSocketPath`) に誘導できる可能性がある。daemon がその socket に
  直接配送できれば subscribe の Monitor 経由の注入自体が不要になる (スパイクで確認中)

v1 の room 系 op (`create_room` / `next_room` / `invite` / `leave` / `kick` / `set_title` /
`archive_room` / `rooms` / `room_history` / `read` / `reply`) は v2 に持たない。op 表の messaging 13 op は
この節に合わせて作り直す。

- control は「daemon の内部状態を読む・操作する API」。webui が唯一の利用者ではない
  (CLI の `ccmsg session kill` 等も同じ面)
- mesh は control の op を封筒に包んで転送する面。control と同じ op 定義を再利用し、
  封筒 (`to_instance` / `from_instance` / `hops`) だけを足す。mesh 固有の op は持たない
  (転送も relay も封筒のフィールドで表す)
- 3 面は **同じ型システム・同じ封筒・同じエラー体系** を共有する (別プロトコルにしない)。
  面は「op 属性表の 1 列」であって、別々のスキーマではない

## 3. op 属性表 (契約が持つメタデータ)

各 op に、契約側で次を宣言する:

| 属性 | 値 | 用途 |
|---|---|---|
| `plane` | messaging / control / mesh | 面の所属 |
| `roles` | session / user / instance の集合 | 認可 (daemon の 35 個の分岐を表に置換) |
| `needs_hello` | bool | hello 必須 (`IDENTITY_OPS` の Set を表に置換)。v2 では `hello` / `ping` 以外は全て必須 (v1 の例外 6 op に根拠が無いため) |
| `capability` | 能力名 (無ければ常時) | hello の能力フラグ 6 個を「op の可用性」に一本化。hello は「この instance で有効な capability の集合」を返す |
| `locality` | instance-local / cluster | instance-local な op (fs / pid / sandbox / hyoui) は担当 instance へ転送される |
| `errors` | 返しうる `ErrorCode` の集合 | op ↔ error の対応表 (現在は doc コメントに散在) |

### 3.1 認可エラーは専用コード

role 違反は `forbidden` (新設)。`bad_request` / `invalid_args` は引数の問題だけに使う。

### 3.2 能力 (capability)

hello の `*_available` boolean 6 個をやめ、`capabilities: string[]` (例 `["llm_usage", "sandbox",
"fork", "terminal"]`) にする。op 属性表の `capability` と突き合わせれば、クライアントは
「どの op が押せるか」を表から導ける。config の有無の判定は daemon の 1 箇所 (capability 集合の
計算) に集約され、op ハンドラ側の `<x>_not_configured` は `capability_unavailable` 1 つになる。

### 3.3 観測系は snapshot + delta の 1 形

peers / agents / session_errors / llm_requests / session_status / rooms の「op で全量、push で
全量」を、**`subscribe <topic>` で snapshot を 1 回返し、以後 delta を push** の 1 形に揃える。
topic = `peers` / `agents` / `session_status:<sid>` / `transcript:<sid>` / `room:<id>` …。
one-shot の取得が要る場面 (CLI) は `subscribe` + 即 `unsubscribe` で表現できるので、
`peers` / `agents` / `session_status` の one-shot op は置かない (裁定 PV-Q3)。snapshot の
frame には `snapshot: true` の印を付け、受け手が「snapshot が届いた」を判別できるようにする
(v1 の `room_history` sentinel を topic 全体に一般化)。具体表は
[protocol-v2-op-table.md](./protocol-v2-op-table.md)。

## 4. 型に「正本」を宣言する

| 正本 | 例 | 規約 |
|---|---|---|
| **ccmsg 自身** | room / msg / member / seq / instance | 語彙・単位・命名を ccmsg が決める (snake_case、ms) |
| **Claude Code** | `AgentInfo` (`claude agents`)、`sessions/<pid>.json`、transcript の行 | pass-through は `upstream: "claude"` を型に付け、**ccmsg の型に写す時に単位と命名を揃える** (camelCase / ISO のまま通さない) |
| **llm-gateway** | request / response event、usage / status / stats | 同上 `upstream: "llm-gateway"`。gateway は既に ms 統一済みなので写しは命名だけ |
| **ホスト** | pid / path / config_dir / hyoui handle | `locality: instance-local` を型に付け、instance の外に出す時は instance id を伴う |

「写す」= daemon が upstream の JSON を受けた時点で ccmsg の型に変換する (open set の string は
そのまま通すが、単位と名前は変える)。契約に camelCase が混ざる現状 (`AgentInfo.startedAt` 等) は
この規約で消える。

## 5. 表記規約

- **時刻は Unix ms の整数、名前は `*_at`**。ISO 文字列は wire に載せない (表示側で整形)
- **長さは名前に単位** (`*_ms` / `*_secs`)。`_ms` を時刻に使わない (`last_activity_ms` → `last_activity_at`)
- **識別子**: `sid` (uuid、グローバル)、`instance` (名前、クラスタ内一意)、room id は `<instance>/<n>`
  の形で instance を含意 (文法を契約に定義)、`mid` / `seq` は room 内連番 (持ち主 instance が発行)
- **命名**: フィールドは snake_case、op は `<名詞>_<動詞>` (`room_create` / `session_kill`) で
  名詞先頭に統一 (現状の `create_room` と `session_kill` の混在を解消。裁定 PV-Q4)
- **省略の意味**: 「不明」は省略、「無い」は空配列。型ごとに doc で例外を書かない (規約で固定)
- **wire に乗らない型は契約に置かない** (HTTP multipart の `AttachmentUploadResponse` 等は
  HTTP API の節に分ける)、daemon の運用既定値 (`DEFAULT_*`) や paths / config-migration は
  daemon リポへ移す

## 6. instance と mesh

- `instance` は名前 (例 `personal@mba`)。`hello` の応答に自 instance と、mesh で見えている
  instance の一覧 (`instances: [{id, host, reachable}]`) を含める
- session 系オブジェクト (`PeerInfo` / `AgentInfo` / `LastLiveSession` / `SessionSearchHit`) は
  `instance` を持つ
- `locality: instance-local` の op は、接続先が担当でなければ mesh で担当へ転送。到達できなければ
  `instance_unreachable`
- room の持ち主 instance が `mid` / `seq` を発行。他 instance のメンバの post は持ち主へ転送
- event の relay: 発生元 instance を event に付け (`instance` フィールド)、全量置換の意味論を
  持つ topic (peers / agents) は **instance ごとの全量置換** にする (複数 instance の全量が
  衝突しない)
- instance 間の認証は [mesh-peer-auth.md](./mesh-peer-auth.md) (Web PKI + 接続ごとの使い捨て鍵の JWS、`iss` / `aud` は endpoint URL の完全一致)。`role: instance` の hello がその手順を担う。自 instance の URL (`self`) は [mesh-self-identification.md](./mesh-self-identification.md) で起動時に確定する。instance の識別子は endpoint URL (表示名は config の別名)

## 7. 契約を実行可能にする

- protocol リポは **schema (JSON Schema 相当) + TS 型 + op 属性表** を持ち、daemon / webui は
  同じ schema で検証する (daemon の手書き `typeof` 検査を置換)
- schema から TS 型を生成するか、TS 型を正本に schema を生成するかは PV-Q5
- テストは protocol リポに「fixture (実 wire の JSON) が schema を通る」形で置き、daemon / webui
  の変更が契約に違反したら protocol のテストで落ちるようにする

## 8. 版と互換

- `PROTOCOL_VERSION` は整数のまま (世代)。同一世代内の追加は任意フィールド・任意 op の追加のみ
  許し、削除・意味変更は世代を上げる
- 世代が違う hello は拒否 (v1 と同じ)。mesh も同じ規則 (世代の違う instance とは繋がない)
- 旧系 (v1 の daemon / webui / plugin) は凍結し、新系は別 instance として横に立てる (DR-0032 §2.2)。
  daemon が v1 と v2 を両受けする必要は無い

## 9. 統括判断 (kawaz r278m67「溜めずに決めて進めろ」に従い確定)

| # | 論点 | 判断 | 理由 |
|---|---|---|---|
| PV-Q1 | 面の粒度 | **3 面** (messaging / control / mesh) | room 廃止で messaging は小さくなるが、「エージェント語彙」と「管理 API」を分ける目的は残る。mesh は封筒だけなので表の 1 列で済む |
| PV-Q2 | capability | **hello が集合を返す** | UI が押せる op を事前に導ける。op 属性表と二重にならない (表が唯一の正本) |
| PV-Q3 | 観測系 | **one-shot 全廃、snapshot に `snapshot: true`** | CLI の往復増 (1→3) は許容。重複経路を残す方が高い |
| PV-Q4 | op 命名 | **名詞先頭** (`room_*` は消えるので実質 `session_*` / `fs_*` / `message_*` / `instance_*`) | topic 名 (名詞) と揃う。改名コストは新系なので無い |
| PV-Q5 | 契約の正本 | **TS 型を正本、schema を生成** | 既存 184 interface を出発点にできる。生成器は実装時に選ぶ (未検証) |
| PV-Q7 | role で可視範囲が変わる 3 op | **属性 `scope` を足す** | op を割ると messaging / control の両面に同じ op が要る。表で挙動が読める方を取る |
| PV-Q8 | 未配送 | **sid 単位 inbox + 理由 + 同 cwd の候補 sid** | kawaz 裁定 (r278m65/m66) |
