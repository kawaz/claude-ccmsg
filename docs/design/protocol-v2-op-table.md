# protocol v2 op 属性表 (Draft §2 / §3 / §5 の具体化)

- Status: **Draft の付表** (裁定待ち: PV-Q1 / PV-Q3 / PV-Q4)
- 親: [protocol v2 設計](protocol-v2.md)。本ファイルは §2 (面) / §3 (op 属性表) /
  §5 (命名) を v1 の 56 op に機械的に適用した表であり、**Draft の範囲を超える方針は
  「提案」節に隔離**する
- 一次資料: [protocol 棚卸し](../findings/2026-09-07-protocol-inventory.md) §2 (op 56) /
  §2' (push event 12) / §4.4 (エラー)、[daemon 棚卸し](../findings/2026-09-07-daemon-inventory.md)
  §2.9 (role / hello / 触る状態)

## 0. 表の読み方

| 列 | 値域 | 出典 |
|---|---|---|
| v1 | v1 の op 名 | 棚卸し §2 |
| v2 | 名詞先頭 (`<名詞>_<動詞>`) に付け直した案 | Draft §5。PV-Q4 が b/c なら読み替える |
| plane | messaging / control / mesh / **共通** | Draft §2 |
| roles | session / user / instance | daemon 棚卸し §2.9 の role 欄 |
| hello | 要 / — | 同 hello 欄 (`IDENTITY_OPS`) |
| cap | capability 名 / — | Draft §3.2 |
| loc | L = instance-local / C = cluster | Draft §3 の `locality` |
| errors | 固有エラー (全 op 共通の `invalid_args` は省略) | 棚卸し §2 の固有 error 欄 + Draft §3.1 / §3.2 / §6 の新設 3 種 |

新設エラーの適用規則 (Draft §3.1 / §3.2 / §6 をそのまま適用したもの、個別判断ではない):

- `forbidden` — roles に自分の role が無い op を呼んだ時。**roles が 1 値の全 op に付く**
- `capability_unavailable` — cap を持つ op で、その capability が hello の集合に無い時。
  v1 の `*_not_configured` / `*_unavailable` はすべてこれに畳まれる
- `instance_unreachable` — loc=L の op を担当 instance へ転送できない時。**loc=L の全 op に付く**

以降の表では、この 3 つは「規則で決まる」ので errors 欄に再掲せず、
**畳まれて消える v1 エラー**だけを `(→cap)` の形で示す。

## 1. 共通 (接続・購読) — 5 op

3 面すべてに現れる輸送レベルの op。plane 列を 1 つに決められないため「共通」とした
(Draft §2 は 3 面しか定義していないので、この扱いは PV-Q1 の判断材料。§7 に代案)。

| v1 | v2 | plane | roles | hello | cap | loc | errors |
|---|---|---|---|---|---|---|---|
| `hello` | `hello` | 共通 | session, user, instance | — | — | L | — |
| `ping` | `instance_ping` | 共通 | session, user, instance | — | — | L | — |
| `shutdown` | `instance_shutdown` | 共通 | user | — | — | L | — |
| `subscribe` | `topic_subscribe` | 共通 | session, user | 要 | — | C | `topic_unknown` (新設) |
| (なし) | `topic_unsubscribe` | 共通 | session, user | 要 | — | C | `topic_unknown` |

- `hello` の応答は Draft §3.2 の `capabilities: string[]` と §6 の `instances[]` を返す。
  v1 の boolean 5 + `terminal_gateway_url` (棚卸し §4.5) はここで消える
- `ping` は v1 で daemon プロセスの実行形態を返す (棚卸し §5.4) ので loc=L。
  cluster 全体の生死は `hello` の `instances[]` が担う
- `topic_unsubscribe` は v1 に無い (v1 は `session_status_unsubscribe` /
  `transcript_unsubscribe` の 2 つが個別に存在)。topic 化の対称として新設

## 2. messaging 面 — 13 op

エージェント (session role) に見せる語彙。CLI の `--help` と skill が参照する範囲。

| v1 | v2 | roles | hello | cap | loc | errors (固有) |
|---|---|---|---|---|---|---|
| `create_room` | `room_create` | session, user | 要 | — | C | `one_on_one_requires_single_member` |
| `next_room` | `room_next` | session, user | 要 | — | C | `room_not_found` |
| `post` | `room_post` | session, user | 要 | — | C | `broadcast_agent_target_required`, `reply_via_tl` |
| `reply` | `room_reply` | session, user | — | — | C | `msg_not_found`, `self_reply`, `reply_via_tl` |
| `read` | `room_read` | session, user | — | — | C | `room_not_found`, `not_a_member` |
| `set_title` | `room_title_set` | session, user | 要 | — | C | `room_not_found`, `not_a_member` |
| `archive_room` | `room_archive` | session, user | 要 | — | C | `room_not_found`, `not_a_member` |
| `invite` | `room_invite` | session, user | 要 | — | C | `room_not_found`, `not_a_member` |
| `leave` | `room_leave` | session, user | 要 | — | C | `room_not_found`, `not_a_member` |
| `kick` | `room_kick` | **user** | 要 | — | C | `room_not_found` |
| `say` | `say_post` | **session** | 要 | — | C | — |
| `say_read` | `say_mark_read` | **user** | 要 | — | C | — |
| `notify` | `notify_send` | session, user | 要 | — | C | — |

消えた 2 op:

| v1 | 行き先 |
|---|---|
| `rooms` | topic `rooms` の snapshot (§4) |
| `room_history` | topic `room:<id>` の snapshot。v1 の「sentinel response」(棚卸し §5.7) は snapshot の到達が完了を意味するので不要になる |

hello 欄の `—` (= v1 で hello 不要) が `room_reply` / `room_read` に残っているのは
daemon 棚卸し §2.9 の実測どおり。**messaging の全 op を `要` に揃えるのが自然**だが、
Draft に記述が無いので実測値のまま置く (§7 の提案 3)。

## 3. control 面 — 25 op

### 3.1 セッション観測・操作 (8)

| v1 | v2 | roles | hello | cap | loc | errors (固有) |
|---|---|---|---|---|---|---|
| `session_kill` | `session_kill` | user | 要 | — | L | `session_not_found` |
| `session_rename` | `session_rename` | user | 要 | `terminal` | L | (→cap: `terminal_unavailable`) |
| `session_env` | `session_env_read` | user | — | — | L | `session_not_found` |
| `session_search` | `session_search` | user | 要 | — | L | — |
| `session_dump_file` | `session_dump_write` | user | 要 | — | L | `not_found` |
| `transcript_read` | `transcript_read` | user (一部) | 要 | — | L | `not_found` |
| `fork_origin` | `session_fork_origin` | user | 要 | `fork` | L | `not_found` |
| `last_live_remove` | `session_last_live_remove` | user | 要 | — | L | — |

- 「user (一部)」= daemon 棚卸し §2.9 の「role が可否でなく可視範囲を決める」3 op のうちの
  1 つ。roles には session も含むが応答が縮む。**属性表の 1 列では表現できない**唯一の形
  (§7 の提案 4)
- 全 op が loc=L (pid / 絶対パス / hyoui ハンドルに依存、棚卸し §5.6)。
  よって全 op が `instance_unreachable` を返しうる

### 3.2 ファイルアクセス (9)

| v1 | v2 | roles | hello | cap | loc | errors (固有) |
|---|---|---|---|---|---|---|
| `fs_list` + `fs_list_workspace` | `dir_list` | user (一部) | 要 | — | L | `path_forbidden`, `not_found` |
| `fs_read` + `fs_read_external` + `fs_read_workspace` | `file_read` | user (一部) | 要 | — | L | `path_forbidden`, `not_found` |
| `fs_write` | `file_write` | user | 要 | — | L | `path_not_writable`, `file_exists` |
| `fs_create` | `file_create` | user | 要 | — | L | `file_exists`, `path_forbidden` |
| `fs_edit` | `file_edit` | user | 要 | — | L | `file_conflict`, `not_a_text_file` |
| `fs_delete` | `file_delete` | user | 要 | — | L | `path_forbidden`, `not_found` |
| `fs_find` | `file_find` | user | 要 | — | L | `path_forbidden` |
| `fs_stat_batch` | `file_stat_batch` | user | 要 | — | L | — |
| `dir_tree` | `dir_tree` | user | 要 | `launcher` | L | (→cap: `launcher_not_configured`) |

統合の根拠: v1 の `fs_read` / `fs_read_external` / `fs_read_workspace` は
**response 型が既に `FsReadResponse` 1 つ**で共有されている (棚卸し §3.3、「意図的な統一」)。
違いは request の認可面だけで、`fs_create` / `fs_edit` / `fs_delete` は既に `kind`
(`contained` / `workspace` / `external`) を引数に取る (棚卸し §2.6)。読み・一覧だけが
op 名で面を分けているのが非対称。`kind` に寄せると 5 op → 2 op (-3)。

### 3.3 launcher / sandbox / 翻訳 / llm / 診断 (8)

| v1 | v2 | roles | hello | cap | loc | errors (固有) |
|---|---|---|---|---|---|---|
| `session_launcher_config` | `launcher_config_read` | user | 要 | `launcher` | L | (→cap) |
| `session_launch` | `launcher_run` | user | 要 | `launcher` | L | (→cap) |
| `sandbox_grant` | `sandbox_grant` | user | — | `sandbox` | L | `path_forbidden` (→cap: `sandbox_not_configured`) |
| `sandbox_revoke` | `sandbox_revoke` | user | — | `sandbox` | L | (→cap) |
| `translate` | `translate_run` | user | 要 | `translate` | L | `translate_helper_failed` (→cap: `translate_unavailable`) |
| `llm_usage` | `llm_usage_read` | user | — | `llm_usage` | L | (→cap: `llm_usage_not_configured` / `_unavailable`) |
| `llm_stats` | `llm_stats_read` | user | — | `llm_stats` | L | (→cap: `llm_stats_*`) |
| `client_trace` | `trace_write` | user | 要 | — | L | — |

- `translate` の v1 「空配列 = 能力プローブ」(棚卸し §2.7) は capability 集合で置き換わるので、
  空配列の特別扱いが消える
- `llm_status` はここに無い。push を持つので topic 化 (§4)
- `trace_write` は v1 で `comp: "webui"` の名指し (棚卸し §5.3) を含む。plane=control に
  置くだけでは解消しないが、面の分離により「control 面の診断 op」と位置づけが確定する

消えた 5 op (すべて topic 化、§4):
`peers` / `agents` / `session_status` / `session_status_subscribe` /
`session_status_unsubscribe` / `session_errors` / `transcript_subscribe` /
`transcript_unsubscribe` / `llm_status` — 計 9 (control 面から)。

## 4. 観測系 topic 表 (Draft §3.3)

v1 の「op で全量 + push で全量」9 系統 (棚卸し §5.2) を `topic_subscribe <topic>` の
snapshot + delta 1 形に写す。

| topic | snapshot | delta | 置き換わる v1 op | 置き換わる v1 ev | 差分の粒度 | roles |
|---|---|---|---|---|---|---|
| `peers` | `{peers[], last_live[]}` | 同型 | `peers` | `peers` | **instance ごと全量置換** (Draft §6) | session, user |
| `agents` | `{agents[], polled_at}` | 同型 | `agents` | `agents` | instance ごと全量置換 | user |
| `rooms` | `{rooms: RoomSummary[]}` | room 単位の要素差分 | `rooms` | (なし) | 要素差分 | session, user |
| `room:<id>` | `{room, msgs[], members[], cursor}` | `DeliveredEvent` (seq 付き) | `room_history`, `subscribe` の backlog | `DeliveredEvent` | 要素追加 (seq 連番) | session, user |
| `session_status:<sid>` | `SessionStatusSnapshot` | 全量置換 | `session_status`, `session_status_subscribe`, `session_status_unsubscribe` | `session_status` | 全量置換 | user |
| `transcript:<sid>` | `{sid, size}` | 追記バイト列 (offset 整合) | `transcript_subscribe`, `transcript_unsubscribe` | `transcript` | 追記 (byte offset) | user |
| `session_errors` | `{errors[]}` | instance ごと全量置換 | `session_errors` | `session_errors` | 全量置換 | user |
| `llm_requests` | `{requests[]}` (非期限切れ全量) | 要素追加・更新 | (**v1 に op が無い**) | `llm_requests` | 要素差分 | user |
| `llm_status` | `LlmStatusReport` | 全量置換 | `llm_status` | `llm_status` | 全量置換 | user |
| `notify` | (なし、delta 専用) | `notify` event | — | `notify` | — | session, user |

差分の粒度が「全量置換」に留まる 4 topic (`peers` / `agents` / `session_status` /
`session_errors` / `llm_status`) は v1 の push がそもそも全量置換 (棚卸し §2')。
Draft §3.3 は形 (snapshot + delta) を揃えることが目的で、delta の粒度を細かくすることは
要求していないので、粒度は v1 を保つ。

### 4.1 one-shot 全廃で CLI が困る箇所

Draft §3.3 は「one-shot は `subscribe` + 即 `unsubscribe` で表現できる」とする。
v1 で **cli が呼んでいる観測系 op は `peers` / `rooms` の 2 つ** (棚卸し §2.8 の
「両方が呼ぶ op」)。この 2 つが subscribe 往復になると:

| 論点 | 内容 |
|---|---|
| 往復数 | 1 往復 (`peers`) → 3 往復 (`subscribe` ack + snapshot + `unsubscribe`)。CLI の 1 回実行で完結する用途では純増 |
| 打ち切り条件 | snapshot が届いた時点で unsubscribe すればよいが、**「snapshot が届いた」の判別が必要**。v1 の `room_history` が sentinel response を持っていた (棚卸し §5.7) のと同じ問題が topic 全体に広がる → snapshot frame に `snapshot: true` の印を置くのが最小 |
| delta の取りこぼし | unsubscribe 前に delta が 1 つ届くと CLI は捨てるだけ。害はない |

この 3 点以外に CLI が困る箇所は無い (`session_status` / `agents` / `transcript` は
webui 専用、棚卸し §2.8)。

## 5. event 表

### 5.1 push event 12 種の v2 での扱い

| v1 ev | v2 | instance フィールド | seq |
|---|---|---|---|
| `DeliveredEvent` | topic `room:<id>` の delta | 要 (持ち主 instance が発行、Draft §6) | あり (v1 のまま per-room) |
| `notify` | topic `notify` の delta | 要 (発生元) | なし |
| `peers` | topic `peers` の delta | **要** (instance ごと全量置換の鍵) | なし |
| `agents` | topic `agents` の delta | **要** (同上) | なし |
| `session_status` | topic `session_status:<sid>` の delta | 要 (sid の担当 instance) | なし |
| `session_errors` | topic `session_errors` の delta | 要 | なし |
| `transcript` | topic `transcript:<sid>` の delta | 要 | なし (byte offset で整合) |
| `llm_requests` | topic `llm_requests` の delta | 要 (gateway は instance ごと) | なし |
| `llm_status` | topic `llm_status` の delta | 要 | なし |
| `room_cursors` | **廃止** | — | — |
| `restarting` | 据え置き (topic 外の接続イベント) | 要 | なし |
| `subscribe_superseded` | 据え置き (topic 外の接続イベント) | 不要 (自接続の話) | なし |
| `net_online` | 据え置き (topic 外の接続イベント)。**v2 では union に入れる** | 要 | なし |

- `room_cursors` の廃止根拠: v1 では「subscribe 時に replay しなかった room の一覧」
  (棚卸し §2')。topic ごとに subscribe する v2 では、subscribe していない room に
  cursor 通知を出す必要がなく、`rooms` topic の snapshot が同じ情報 (last_mid) を持つ
- `restarting` / `subscribe_superseded` / `net_online` の 3 つは topic ではなく
  **接続そのものの状態**なので topic 化しない。v1 で `net_online` だけが `StreamEvent`
  union から漏れている (棚卸し §5.1) のは v2 で解消する

### 5.2 storage event 10 種

`member` / `leave` / `msg` / `next` / `prev` / `title` / `archive` / `kind` / `say` /
`say_read` の 10 種は room jsonl の行の型 (棚卸し §3.1)。**全 10 種を据え置き**。

| 変更点 | 内容 |
|---|---|
| `ts` の単位 | ISO 文字列 → Unix ms (Draft §5)。10 種すべてが対象 (棚卸し §4.2 で「storage event の `ts` 全 9 種」が ISO) |
| `instance` | **不要**。room の持ち主 instance が jsonl の持ち主なので、room id (`<instance>/<n>`) が既に含意する |
| seq | あり (v1 のまま。行順が正本、`seq` はその写像) |

storage event は「永続形式」であって wire 形式ではないので、面の所属を持たない
(wire に出るのは `DeliveredEvent` = storage event + room id + framing)。

## 6. 統合・廃止候補 (根拠付き)

### 6.1 廃止 (topic 化で不要、11)

`rooms` / `room_history` / `peers` / `agents` / `session_status` /
`session_status_subscribe` / `session_status_unsubscribe` / `session_errors` /
`transcript_subscribe` / `transcript_unsubscribe` / `llm_status`

根拠: 棚卸し §5.2 の「同じ情報を 2 経路以上」9 系統のうち、op と push の重複がある 8 系統
すべて。`session_status` は 3 経路 (op / subscribe ack / push) で、しかも
`SessionStatusResponse` と `SessionStatusSubscribeResponse` は**構造が完全同一**
(棚卸し §3.3) — 型の重複が経路の重複の写しになっている。

### 6.2 統合 (-3)

| 統合後 | 統合前 | 根拠 |
|---|---|---|
| `file_read` | `fs_read` / `fs_read_external` / `fs_read_workspace` | response 型が既に共有 (棚卸し §3.3)。差は認可面のみで、書き系は既に `kind` 引数で表現済み |
| `dir_list` | `fs_list` / `fs_list_workspace` | 同上 |

同型 response の残り (`PeersResponse`↔`PeersStreamEvent`、`AgentsResponse`↔
`AgentsStreamEvent`、`SessionErrorsResponse`↔`SessionErrorsStreamEvent`、
`LlmStatusResponse`↔`LlmStatusStreamEvent.report`、棚卸し §5.7) は **6.1 の topic 化で
自動的に 1 つになる** (snapshot と delta が同じ型)。

### 6.3 フィールドの廃止 (残骸、棚卸し §1 の残骸表 / §5.5)

| 対象 | 根拠 |
|---|---|
| `SubscribeRequest.since` (mid ベース) | 送信側がリポ内に 0 件。daemon の分岐だけが生きている |
| `Response.request_id` の optional | 「envelope 以前の daemon」向け。v2 では必須 |
| `RoomSummary.live_members` の absent 分岐 | 「daemon が古い場合」= 到達しない |
| `PeerInfo.protocol` の absent 分岐 | 同上 |
| `HelloResponse` の能力 boolean 5 + `terminal_gateway_url` | Draft §3.2 の `capabilities[]` に置換 |
| `DEFAULT_*` (7 個) / `paths.ts` / `config-migration.ts` | daemon の運用既定値・FS レイアウト。Draft §5 末尾で daemon リポへ |
| `AttachmentUploadResponse` | wire に乗らない (HTTP multipart)。Draft §5 末尾で HTTP API の節へ |
| `LlmRequestInfo.prefix` の空文字分岐、`TRANSCRIPT_READ_MAX_BYTES` の変遷史コメント | 外部の版番号・値の変遷史が契約の説明文に埋まっている |

### 6.4 ErrorCode の畳み込み

| v1 コード | v2 |
|---|---|
| `llm_usage_not_configured` / `llm_usage_unavailable` / `llm_stats_*` / `llm_status_*` / `sandbox_not_configured` / `launcher_not_configured` / `translate_unavailable` / `terminal_unavailable` | `capability_unavailable` 1 つ |
| role 違反で返していた `bad_request` (daemon 内 41 箇所の一部) | `forbidden` (新設) |
| (なし) | `instance_unreachable` (新設)、`topic_unknown` (新設) |

`ErrorBody.code` の型は `string` → `ErrorCode` union に閉じる (棚卸し §3.2 が
「ここだけは閉じられるはずなのに開いている」と指摘、§5.1 も同じ)。

## 7. 数値まとめ

| 面 | v2 op 数 | v1 からの内訳 |
|---|---|---|
| 共通 (接続・購読) | 5 | v1 4 + `topic_unsubscribe` 新設 1 |
| messaging | 13 | v1 15 − topic 化 2 (`rooms` / `room_history`) |
| control | 25 | v1 37 − topic 化 9 − 統合 3 |
| mesh | 2 | 新設 (`instance_forward` / `instance_relay`、§8 の提案 1) |
| **合計** | **45** | 56 − 廃止 11 − 統合 3 + 新設 3 |

| 指標 | 値 |
|---|---|
| v1 op | 56 |
| 廃止 (topic 化) | 11 |
| 統合による減 | 3 (5 op → 2 op) |
| 新設 | 3 (`topic_unsubscribe` / mesh 2) |
| v2 op | 45 (-20%) |
| topic 数 | 10 |
| v1 の 9 系統の重複経路 | 0 (すべて snapshot + delta 1 形へ) |
| 畳まれる ErrorCode | 8 → 1 (`capability_unavailable`) |
| 新設 ErrorCode | 4 (`forbidden` / `capability_unavailable` / `instance_unreachable` / `topic_unknown`) |
| capability 名 | 8 (`llm_usage` / `llm_stats` / `sandbox` / `fork` / `terminal` / `launcher` / `translate` / `llm_status`) |
| loc=L の op | 25 (control 面の全 op) |
| loc=C の op | 20 |

## 8. Draft に無い提案 (裁定対象外、参考)

1. **mesh 面の op 名**。Draft §2 は mesh を「control の op を封筒に包んで転送する面」と
   規定するが op 名を挙げていない。表を閉じるために `instance_forward` (op 転送) /
   `instance_relay` (event 中継) の 2 つを仮置きした。封筒だけで op を持たない設計
   (= 既存 op に `to_instance` を足す) も成立するので、その場合 mesh の op 数は 0
2. **`snapshot: true` の印**。§4.1 のとおり one-shot 全廃には snapshot frame の識別が要る。
   Draft §3.3 は言及していない
3. **messaging の hello 必須を揃える**。v1 は `reply` / `read` / `rooms` / `peers` /
   `ping` などが hello 不要 (daemon 棚卸し §2.9)。属性表にする以上「なぜこの 6 op だけ
   不要か」の根拠が要るが、v1 側に根拠が見つからない
4. **「role が可視範囲を変える」3 op** (`fs_list` / `fs_read` / `transcript_read`)。
   `roles` 列は可否しか表せず、この 3 op を表現できない。属性を足す (`role_scoped`) か、
   応答を role で分けず**別 op に割る**かの判断が要る

## 9. PV-Q の選択肢で表がどう変わるか

### PV-Q1 (面の分離の粒度)

| 選択 | 表への影響 |
|---|---|
| a. 3 面 (Draft) | 本表のまま。plane 列 4 値 (共通含む) |
| b. messaging + control を 1 つに | plane 列は 2 値 (local / mesh) に縮む。**roles 列が唯一の分離軸**になり、v1 の「user-only 36 / session 20」の偏り (棚卸し §3) は表に残るが構造としては解消しない。§1 の「共通」問題は消える |
| c. mesh を control に吸収 | plane 列は messaging / control の 2 値。mesh 固有の 2 op は control の op となり、`locality` 列が転送の唯一の根拠になる。**§7 の合計は 45 のまま** |

### PV-Q2 (capability の表現)

| 選択 | 表への影響 |
|---|---|
| a. hello が集合を返す (Draft) | cap 列 8 値。クライアントは集合と表を突き合わせる |
| b. op 属性表から導くだけ | cap 列は残るが hello の応答が消え、クライアントは「op を叩いて `capability_unavailable` が返るか」で判定する。**UI が事前に押せるか判断できない**ので webui 側に影響 |

### PV-Q3 (観測系の一本化)

| 選択 | 表への影響 |
|---|---|
| a. one-shot 全廃 (Draft) | §4 のとおり。v2 op = **45** |
| b. `peers` / `rooms` の one-shot を残す (CLI 用) | 2 op 復活で **47**。§4.1 の往復数問題が消え、`snapshot: true` の印 (提案 2) も不要になる |
| c. 全 topic に one-shot を併置 | 10 op 復活で **55**。v1 の重複経路が形を変えて戻るので、Draft §1 の事実 7 が解決しない |

### PV-Q4 (op の命名)

| 選択 | 表への影響 |
|---|---|
| a. 名詞先頭に統一 (Draft) | v2 列のまま。**改名は 56 中 33 op** (`post`→`room_post` 等) |
| b. v1 の名前を維持 | v2 列 = v1 列。統合・廃止だけが差分になり、移行コストは最小。`create_room` と `session_kill` の混在 (棚卸し §4.1) は残る |
| c. 動詞先頭に統一 | `create_room` / `read_file` / `kill_session` の形。改名数は a と同程度だが、v1 の取得系 (`rooms` / `peers`) が `list_rooms` / `list_peers` になり **topic 名と op 名が乖離**する (topic は名詞) |

### PV-Q5 (schema と TS 型のどちらが正本か) / PV-Q6 (v1/v2 両受け)

本表は op の属性しか扱わないため、どちらの選択でも表は変わらない。ただし PV-Q6 で
両受けを選ぶ場合、§6.1 で廃止する 11 op と §6.2 で統合する 5 op は**並走期間中 daemon に
残る** (v1 の handler として)。
