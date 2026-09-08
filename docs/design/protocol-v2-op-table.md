# protocol v2 op 属性表 (Draft §2 / §3 / §5 の具体化)

- Status: **Draft の付表** (PV-Q1〜Q5 / Q7 / Q8 は親 §9 で確定済み)
- 親: [protocol v2 設計](protocol-v2.md)。本ファイルは §2 (面) / §3 (op 属性表) /
  §5 (命名) を op 単位に落とした表であり、**Draft の範囲を超える方針は「提案」節に隔離**する
- 一次資料: [protocol 棚卸し](../findings/2026-09-07-protocol-inventory.md) §2 (op 56) /
  §2' (push event 12) / §4.4 (エラー)、[daemon 棚卸し](../findings/2026-09-07-daemon-inventory.md)
  §2.9 (role / hello / 触る状態)

## 0. 表の読み方

| 列 | 値域 | 出典 |
|---|---|---|
| v1 | 対応する v1 の op 名 (無ければ「新設」) | 棚卸し §2 |
| v2 | 名詞先頭 (`<名詞>_<動詞>`) の op 名 | Draft §5 / §9 PV-Q4 |
| plane | messaging / control / mesh / **共通** | Draft §2 |
| roles | session / user / instance | Draft §3 |
| hello | 要 / — | Draft §3 (`hello` / `ping` 以外は全て `要`) |
| cap | capability 名 / — | Draft §3.2 |
| loc | L = instance-local / C = cluster | Draft §3 の `locality` |
| scope | role で応答の可視範囲が変わる op に `role` | Draft §9 PV-Q7 |
| errors | 固有エラー (全 op 共通の `invalid_args` は省略) | 棚卸し §2 の固有 error 欄 + Draft §3.1 / §3.2 / §6 |

新設エラーの適用規則 (Draft §3.1 / §3.2 / §6 をそのまま適用したもの、個別判断ではない):

- `forbidden` — roles に自分の role が無い op を呼んだ時。**roles が全 role を含まない op に付く**
- `capability_unavailable` — cap を持つ op で、その capability が hello の集合に無い時。
  v1 の `*_not_configured` / `*_unavailable` はすべてこれに畳まれる
- `instance_unreachable` — loc=L の op を担当 instance へ転送できない時。**loc=L の全 op に付く**

以降の表では、この 3 つは「規則で決まる」ので errors 欄に再掲せず、
**畳まれて消える v1 エラー**だけを `(→cap)` の形で示す。

## 1. 共通 (接続・購読) — 5 op

3 面すべてに現れる輸送レベルの op。plane 列を 1 つに決められないため「共通」とした。

| v1 | v2 | plane | roles | hello | cap | loc | scope | errors |
|---|---|---|---|---|---|---|---|---|
| `hello` | `hello` | 共通 | session, user, instance | — | — | L | — | — |
| `ping` | `instance_ping` | 共通 | session, user, instance | — | — | L | — | — |
| `shutdown` | `instance_shutdown` | 共通 | user | 要 | — | L | — | — |
| `subscribe` | `topic_subscribe` | 共通 | session, user | 要 | — | C | — | `topic_unknown` (新設) |
| 新設 | `topic_unsubscribe` | 共通 | session, user | 要 | — | C | — | `topic_unknown` |

- `hello` の応答は Draft §3.2 の `capabilities: string[]` と §6 の `instances[]` を返す。
  v1 の boolean 5 + `terminal_gateway_url` (棚卸し §4.5) はここで消える
- `ping` は daemon プロセスの実行形態を返す (棚卸し §5.4) ので loc=L。
  cluster 全体の生死は `hello` の `instances[]` が担う
- `topic_unsubscribe` は topic 化の対称として新設 (v1 は `session_status_unsubscribe` /
  `transcript_unsubscribe` の 2 つが個別に存在)

## 2. messaging 面 — 4 op

Draft §2.1 のとおり、messaging は会話の器 (room) を持たず **sid 宛の 1 対 1 配送**だけを扱う。
エージェント (session role) に見せる語彙はこの 4 op で閉じる。CLI の `--help` と skill が
参照する範囲もこれと同じ。

| v1 | v2 | roles | hello | cap | loc | scope | errors (固有) |
|---|---|---|---|---|---|---|---|
| `post` / `reply` | `message_send` | session, user | 要 | — | C | — | `session_not_found` |
| `say` | `say_post` | **session** | 要 | — | C | — | — |
| `say_read` | `say_mark_read` | **user** | 要 | — | C | — | — |
| `notify` | `notify_send` | session, user | 要 | — | C | — | — |

### 2.1 `message_send` — 引数と配送結果

```
message_send { to: sid, text: string, reply_to?: mid }
  → { delivered: bool, reason?: undelivered_reason, candidates?: sid[] }
```

| フィールド | 意味 |
|---|---|
| `to` | 宛先 sid (uuid、グローバル。room id は存在しない) |
| `text` | 本文 |
| `reply_to` | 直前に受け取った配送 frame の `mid` (会話の親子。省略可) |
| `delivered` | `true` = 受信側へ即時配送済み。`false` = inbox に積んだ |
| `reason` | `delivered: false` の理由 (下表)。`true` の時は省略 |
| `candidates` | 宛先が `paused` / `disappeared` の時、**同じ repo root で今動いているセッションの sid** (ws 名付き、Draft §2.1) |

| `reason` | 状態 | 送信側の取れる手 |
|---|---|---|
| `preparing` | 宛先は生きているが subscribe 未起動 | 待つ (起動時に daemon が配送する) |
| `paused` | 宛先が Paused | 待つ / `candidates` の別セッションへ送り直す |
| `disappeared` | 宛先のセッションが消えている | `candidates` へ送り直す / 諦める |
| `instance_unreachable` | 宛先の担当 instance に mesh で届かない | 待つ / 諦める |

`reason` は **エラーではなく正常応答**。`instance_unreachable` だけは ErrorCode と同名だが、
ここでは「配送できなかった理由」であって op は成功している (op 自体が失敗するのは
`session_not_found` = `to` の sid が cluster のどこにも存在しない場合)。

`mid` は配送 frame の同一性 (`reply_to` の指し先) のための識別子で、v1 の room 内連番ではなく
`<instance>/<連番>` (発行 instance が採番、Draft §5)。既読カーソル・`seq`・replay 窓は持たない (Draft §2.1)。

### 2.2 受信側への配送 frame

配送は topic `inbox` の delta として届く (§4)。frame:

```
{ topic: "inbox", mid, from: sid, from_label, text, reply_to?, sent_at, instance }
```

**返信経路の表し方 (提案 1 つ)**: v1 の `reply_via` (返信コマンドを組み立てた人間可読の
文字列、DR-0017 追補) は wire に載せず、**frame の `from` sid をそのまま `message_send` の
`to` に入れれば返信になる**という構造だけを契約に置く。文言 (「返信は
`ccmsg message send --to <sid>`」) は CLI / skill がローカルで組み立てる。

理由: v1 の `reply_via` は「room を辿って返信先を決める」ための誘導文で、room が無い v2 では
返信先が `from` に一意に定まる。文字列を wire に載せると **daemon がクライアントの UI 文言を
持つ**ことになり、Draft §4 の「型に正本を宣言する」に反する。

### 2.3 inbox 系 op を置かない根拠

未配送メッセージは sid 単位の inbox に溜まり、**受信側が `topic_subscribe inbox` した時点の
snapshot として daemon が自動配送する** (Draft §2.1)。したがって:

| 想定した op | 置かない理由 |
|---|---|
| `inbox_read` | topic `inbox` の snapshot が同じもの。one-shot 全廃 (PV-Q3) の対象 |
| `inbox_ack` / 既読カーソル | 会話ログの正本は transcript。ccmsg 側に読み位置を持たない (Draft §2.1) |
| `inbox_clear` | 配送した時点で inbox から消える (溜めるのは未配送分だけ) |

### 2.4 `say` の記録先

`ccmsg say` はセッションが CLI 経由で叩く (実装: `packages/cli/src/index.ts` の say 経路)
ため、**発話したこととその本文は呼び出し元セッションの transcript に tool 呼び出しとして残る**。
v2 は room jsonl を持たないので、`say_post` は「今どのセッションが喋ったか」を webui へ
push するだけで、ccmsg 側の永続ログを作らない。`say_mark_read` が操作する未読フラグは
daemon の揮発状態 (再起動で消えてよい)。

## 3. control 面 — 27 op

### 3.1 セッション観測・操作 (8)

| v1 | v2 | roles | hello | cap | loc | scope | errors (固有) |
|---|---|---|---|---|---|---|---|
| `session_kill` | `session_kill` | user | 要 | — | L | — | `session_not_found` |
| `session_rename` | `session_rename` | user | 要 | `terminal` | L | — | (→cap: `terminal_unavailable`) |
| `session_env` | `session_env_read` | user | 要 | — | L | — | `session_not_found` |
| `session_search` | `session_search` | user | 要 | — | L | — | — |
| `session_dump_file` | `session_dump_write` | user | 要 | — | L | — | `not_found` |
| `transcript_read` | `transcript_read` | session, user | 要 | — | L | **role** | `not_found` |
| `fork_origin` | `session_fork_origin` | user | 要 | `fork` | L | — | `not_found` |
| `last_live_remove` | `session_last_live_remove` | user | 要 | — | L | — | — |

- 全 op が loc=L (pid / 絶対パス / hyoui ハンドルに依存、棚卸し §5.6)。
  よって全 op が `instance_unreachable` を返しうる
- `transcript_read` の `scope: role` = session role では自分の transcript だけ、
  user role では全セッション。可否ではなく可視範囲が変わる (PV-Q7)

### 3.2 ファイルアクセス (9)

| v1 | v2 | roles | hello | cap | loc | scope | errors (固有) |
|---|---|---|---|---|---|---|---|
| `fs_list` + `fs_list_workspace` | `dir_list` | session, user | 要 | — | L | **role** | `path_forbidden`, `not_found` |
| `fs_read` + `fs_read_external` + `fs_read_workspace` | `file_read` | session, user | 要 | — | L | **role** | `path_forbidden`, `not_found` |
| `fs_write` | `file_write` | user | 要 | — | L | — | `path_not_writable`, `file_exists` |
| `fs_create` | `file_create` | user | 要 | — | L | — | `file_exists`, `path_forbidden` |
| `fs_edit` | `file_edit` | user | 要 | — | L | — | `file_conflict`, `not_a_text_file` |
| `fs_delete` | `file_delete` | user | 要 | — | L | — | `path_forbidden`, `not_found` |
| `fs_find` | `file_find` | user | 要 | — | L | — | `path_forbidden` |
| `fs_stat_batch` | `file_stat_batch` | user | 要 | — | L | — | — |
| `dir_tree` | `dir_tree` | user | 要 | `launcher` | L | — | (→cap: `launcher_not_configured`) |

統合の根拠: v1 の `fs_read` / `fs_read_external` / `fs_read_workspace` は
**response 型が既に `FsReadResponse` 1 つ**で共有されている (棚卸し §3.3、「意図的な統一」)。
違いは request の認可面だけで、`fs_create` / `fs_edit` / `fs_delete` は既に `kind`
(`contained` / `workspace` / `external`) を引数に取る (棚卸し §2.6)。読み・一覧だけが
op 名で面を分けているのが非対称。`kind` に寄せると 5 op → 2 op (-3)。

### 3.3 launcher / sandbox / 翻訳 / llm (7)

| v1 | v2 | roles | hello | cap | loc | scope | errors (固有) |
|---|---|---|---|---|---|---|---|
| `session_launcher_config` | `launcher_config_read` | user | 要 | `launcher` | L | — | (→cap) |
| `session_launch` | `launcher_run` | user | 要 | `launcher` | L | — | (→cap) |
| `sandbox_grant` | `sandbox_grant` | user | 要 | `sandbox` | L | — | `path_forbidden` (→cap: `sandbox_not_configured`) |
| `sandbox_revoke` | `sandbox_revoke` | user | 要 | `sandbox` | L | — | (→cap) |
| `translate` | `translate_run` | user | 要 | `translate` | L | — | `translate_helper_failed` (→cap: `translate_unavailable`) |
| `llm_usage` | `llm_usage_read` | user | 要 | `llm_usage` | L | — | (→cap: `llm_usage_not_configured` / `_unavailable`) |
| `llm_stats` | `llm_stats_read` | user | 要 | `llm_stats` | L | — | (→cap: `llm_stats_*`) |

### 3.4 汎用 kv (3、[DR-0033 §7.1](../decisions/DR-0033-webui-color-system.md))

| v1 | v2 | roles | hello | cap | loc | scope | errors (固有) |
|---|---|---|---|---|---|---|---|
| — | `kv_read` | user | 要 | — | C | — | `not_found` |
| — | `kv_write` | user | 要 | — | C | — | — |
| — | `kv_delete` | user | 要 | — | C | — | — |

- `kv_read {ns, key}` → `{value, updated_at}`、`kv_write {ns, key, value, updated_at?}` (省略時は daemon の
  現在時刻)、`kv_delete {ns, key}`。`value` は JSON、`ns` / `key` は文字列
- 契約が約束するのは「ns 内で key が一意」だけ。instance 間のミラーは daemon の責務で、決着は `updated_at`
  の LWW。デバイス固有の値は key に端末名を含める (契約に device の概念を足さない)
- topic `kv:<ns>` (snapshot + delta) で他端末の保存が即時に見える (§4)
| `client_trace` | — (v2 に持たない。webui の計測は新 webui の実装時に要れば同一世代内で追加) | | | | | | |

- `translate` の v1 「空配列 = 能力プローブ」(棚卸し §2.7) は capability 集合で置き換わるので、
  空配列の特別扱いが消える
- `llm_status` はここに無い。push を持つので topic 化 (§4)

## 4. topic 表 (Draft §3.3)

v1 の「op で全量 + push で全量」を `topic_subscribe <topic>` の snapshot + delta 1 形に写す。
snapshot frame には `snapshot: true` の印が付く (PV-Q3)。

| topic | plane | snapshot | delta | 置き換わる v1 op | 置き換わる v1 ev | 差分の粒度 | roles |
|---|---|---|---|---|---|---|---|
| `inbox` | messaging | 未配送メッセージの配列 (自 sid 宛) | 配送 frame (§2.2) | (v1 は subscribe の backlog) | `DeliveredEvent` | 要素追加 | session, user |
| `notify` | messaging | (なし、delta 専用) | `notify` event | — | `notify` | — | session, user |
| `peers` | control | `{peers[], last_live[]}` | 同型 | `peers` | `peers` | **instance ごと全量置換** (Draft §6) | session, user |
| `agents` | control | `{agents[], polled_at}` | 同型 | `agents` | `agents` | instance ごと全量置換 | user |
| `session_status:<sid>` | control | `SessionStatusSnapshot` | 全量置換 | `session_status`, `session_status_subscribe`, `session_status_unsubscribe` | `session_status` | 全量置換 | user |
| `transcript:<sid>` | control | `{sid, size}` | 追記バイト列 (offset 整合) | `transcript_subscribe`, `transcript_unsubscribe` | `transcript` | 追記 (byte offset) | user |
| `session_errors` | control | `{errors[]}` | instance ごと全量置換 | `session_errors` | `session_errors` | 全量置換 | user |
| `llm_requests` | control | `{requests[]}` (非期限切れ全量) | 要素追加・更新 | (**v1 に op が無い**) | `llm_requests` | 要素差分 | user |
| `llm_status` | control | `LlmStatusReport` | 全量置換 | `llm_status` | `llm_status` | 全量置換 | user |

`room:<id>` と `rooms` の 2 topic は v2 に無い (room が無い)。差分の粒度が「全量置換」に
留まる 4 topic (`peers` / `agents` / `session_status` / `session_errors` / `llm_status`) は
v1 の push がそもそも全量置換 (棚卸し §2')。Draft §3.3 は形を揃えることが目的で、
delta の粒度を細かくすることは要求していないので、粒度は v1 を保つ。

### 4.1 webui が「セッションとの会話」を見る経路

**`transcript:<sid>` だけ**で足りる。会話ログの正本は transcript (Draft §2.1) なので、
webui は room 一覧・room 履歴を持たず、セッションを選んで transcript を購読する。

人 (u1) からセッションへの送信も **`message_send` に統一**し、webui 専用の composer op は
置かない。webui は user role で `message_send {to: sid}` を呼び、送った内容は受信側セッションの
transcript に (注入されたメッセージとして) 現れるので、送信の反映も同じ 1 経路で見える。

### 4.2 one-shot 全廃で CLI が困る箇所

Draft §3.3 は「one-shot は `subscribe` + 即 `unsubscribe` で表現できる」とする。
v1 で CLI が呼んでいた観測系 op のうち v2 に残るのは `peers` のみ (`rooms` は消滅)。

| 論点 | 内容 |
|---|---|
| 往復数 | 1 往復 (`peers`) → 3 往復 (`topic_subscribe` ack + snapshot + `topic_unsubscribe`)。CLI の 1 回実行で完結する用途では純増 |
| 打ち切り条件 | snapshot frame の `snapshot: true` で判別して unsubscribe する |
| delta の取りこぼし | unsubscribe 前に delta が 1 つ届くと CLI は捨てるだけ。害はない |

この 3 点以外に CLI が困る箇所は無い (`session_status` / `agents` / `transcript` は
webui 専用、棚卸し §2.8)。

## 5. event 表

### 5.1 push event 12 種の v2 での扱い

| v1 ev | v2 | instance フィールド | seq |
|---|---|---|---|
| `DeliveredEvent` | **持たない**。1 対 1 の配送 frame (§2.2) が topic `inbox` の delta になる | 要 (発生元) | なし (`mid` のみ、room 内連番は廃止) |
| `notify` | topic `notify` の delta | 要 (発生元) | なし |
| `peers` | topic `peers` の delta | **要** (instance ごと全量置換の鍵) | なし |
| `agents` | topic `agents` の delta | **要** (同上) | なし |
| `session_status` | topic `session_status:<sid>` の delta | 要 (sid の担当 instance) | なし |
| `session_errors` | topic `session_errors` の delta | 要 | なし |
| `transcript` | topic `transcript:<sid>` の delta | 要 | なし (byte offset で整合) |
| `llm_requests` | topic `llm_requests` の delta | 要 (gateway は instance ごと) | なし |
| `llm_status` | topic `llm_status` の delta | 要 | なし |
| `room_cursors` | **持たない** (room が無い) | — | — |
| `restarting` | 据え置き (topic 外の接続イベント) | 要 | なし |
| `subscribe_superseded` | 据え置き (topic 外の接続イベント) | 不要 (自接続の話) | なし |
| `net_online` | 据え置き (topic 外の接続イベント)。**v2 では union に入れる** | 要 | なし |

`restarting` / `subscribe_superseded` / `net_online` の 3 つは topic ではなく
**接続そのものの状態**なので topic 化しない。v1 で `net_online` だけが `StreamEvent`
union から漏れている (棚卸し §5.1) のは v2 で解消する。

### 5.2 storage event 10 種

`member` / `leave` / `msg` / `next` / `prev` / `title` / `archive` / `kind` / `say` /
`say_read` の 10 種は room jsonl の行の型 (棚卸し §3.1)。**全 10 種を v2 に持たない**。

| 種別 | v2 での行き先 |
|---|---|
| `member` / `leave` / `next` / `prev` / `title` / `archive` / `kind` | 対応する概念 (room・メンバ・分割) が無い |
| `msg` | 会話の正本は transcript。ccmsg 側の永続ログを持たない (Draft §2.1) |
| `say` | 発話は呼び出し元セッションの transcript に tool 呼び出しとして残る (§2.4) |
| `say_read` | 未読フラグは daemon の揮発状態 |

room jsonl そのものが無くなるので、棚卸し §4.2 が指摘した「storage event の `ts` が
ISO 文字列」問題は対象ごと消える。wire に出る時刻はすべて Draft §5 の Unix ms。

## 6. 統合・廃止 (根拠付き)

### 6.1 廃止 — room 系 11 op (Draft §2.1)

`create_room` / `next_room` / `invite` / `leave` / `kick` / `set_title` / `archive_room` /
`rooms` / `room_history` / `read` / `reply`

根拠: 複数メンバーの会話は初期に数回使われた後は使われておらず、会話の様子は webui が
transcript で全部見せている。messaging を「sid 宛の 1 対 1 配送」に縮めると、
会話の器・メンバ管理・履歴取得・既読の 4 系統がまとめて要らなくなる。
`post` は宛先が room から sid になったので `message_send` に置き換わる (廃止ではなく改称)。

### 6.2 廃止 — topic 化で不要 9 op

`peers` / `agents` / `session_status` / `session_status_subscribe` /
`session_status_unsubscribe` / `session_errors` / `transcript_subscribe` /
`transcript_unsubscribe` / `llm_status`

根拠: 棚卸し §5.2 の「同じ情報を 2 経路以上」。`session_status` は 3 経路
(op / subscribe ack / push) で、しかも `SessionStatusResponse` と
`SessionStatusSubscribeResponse` は**構造が完全同一** (棚卸し §3.3) — 型の重複が
経路の重複の写しになっている。

### 6.3 統合 (-3)

| 統合後 | 統合前 | 根拠 |
|---|---|---|
| `file_read` | `fs_read` / `fs_read_external` / `fs_read_workspace` | response 型が既に共有 (棚卸し §3.3)。差は認可面のみで、書き系は既に `kind` 引数で表現済み |
| `dir_list` | `fs_list` / `fs_list_workspace` | 同上 |

同型 response の残り (`PeersResponse`↔`PeersStreamEvent`、`AgentsResponse`↔
`AgentsStreamEvent`、`SessionErrorsResponse`↔`SessionErrorsStreamEvent`、
`LlmStatusResponse`↔`LlmStatusStreamEvent.report`、棚卸し §5.7) は **6.2 の topic 化で
自動的に 1 つになる** (snapshot と delta が同じ型)。

### 6.4 フィールドの廃止 (残骸、棚卸し §1 の残骸表 / §5.5)

| 対象 | 根拠 |
|---|---|
| `SubscribeRequest.since` (mid ベース) | 送信側がリポ内に 0 件。daemon の分岐だけが生きている。v2 は replay 窓を持たない |
| `Response.request_id` の optional | 「envelope 以前の daemon」向け。v2 では必須 |
| `RoomSummary` 一式 (`live_members` 等) | room が無い |
| `PeerInfo.protocol` の absent 分岐 | 「daemon が古い場合」= 到達しない |
| `HelloResponse` の能力 boolean 5 + `terminal_gateway_url` | Draft §3.2 の `capabilities[]` に置換 |
| `msg` の `reply_via` 文字列 | 返信先は配送 frame の `from` に一意に定まる (§2.2) |
| `DEFAULT_*` (7 個) / `paths.ts` / `config-migration.ts` | daemon の運用既定値・FS レイアウト。Draft §5 末尾で daemon リポへ |
| `AttachmentUploadResponse` | wire に乗らない (HTTP multipart)。Draft §5 末尾で HTTP API の節へ |
| `LlmRequestInfo.prefix` の空文字分岐、`TRANSCRIPT_READ_MAX_BYTES` の変遷史コメント | 外部の版番号・値の変遷史が契約の説明文に埋まっている |

### 6.5 ErrorCode の畳み込み

| v1 コード | v2 |
|---|---|
| `llm_usage_not_configured` / `llm_usage_unavailable` / `llm_stats_*` / `llm_status_*` / `sandbox_not_configured` / `launcher_not_configured` / `translate_unavailable` / `terminal_unavailable` | `capability_unavailable` 1 つ |
| role 違反で返していた `bad_request` (daemon 内 41 箇所の一部) | `forbidden` (新設) |
| `room_not_found` / `not_a_member` / `msg_not_found` / `self_reply` / `reply_via_tl` / `one_on_one_requires_single_member` / `broadcast_agent_target_required` | 消滅 (room 系 op ごと廃止)。宛先不明は `session_not_found` に一本化 |
| (なし) | `instance_unreachable` (新設)、`topic_unknown` (新設) |

`ErrorBody.code` の型は `string` → `ErrorCode` union に閉じる (棚卸し §3.2 が
「ここだけは閉じられるはずなのに開いている」と指摘、§5.1 も同じ)。

## 7. 数値まとめ

| 面 | v2 op 数 | v1 からの内訳 |
|---|---|---|
| 共通 (接続・購読) | 5 | v1 4 + `topic_unsubscribe` 新設 1 |
| messaging | 4 | v1 15 − room 系廃止 11 (`post` / `reply` は `message_send` に統合) |
| control | 25 | v1 37 − topic 化 9 − 統合 3 |
| mesh | 0 | op を持たない (封筒 `to_instance` / `from_instance` / `hops` だけ、Draft §2) |
| **合計** | **36** | 56 − 廃止 21 − 統合 3 + 新設 4 (`topic_unsubscribe`、`kv_*` 3) |

| 指標 | 値 |
|---|---|
| v1 op | 56 |
| 廃止 (room 系) | 11 |
| 廃止 (topic 化) | 9 |
| 統合による減 | 3 (5 op → 2 op) |
| 新設 | 1 (`topic_unsubscribe`) |
| v2 op | 36 (-36%) |
| topic 数 | 9 (messaging 2 / control 7) |
| v1 の重複経路 | 0 (すべて snapshot + delta 1 形へ) |
| 畳まれる ErrorCode | 8 → 1 (`capability_unavailable`) |
| 消滅する ErrorCode (room 系) | 7 |
| 新設 ErrorCode | 4 (`forbidden` / `capability_unavailable` / `instance_unreachable` / `topic_unknown`) |
| capability 名 | 8 (`llm_usage` / `llm_stats` / `sandbox` / `fork` / `terminal` / `launcher` / `translate` / `llm_status`) |
| `scope: role` の op | 3 (`transcript_read` / `dir_list` / `file_read`) |
| loc=L の op | 25 (control 27 + `instance_shutdown`。`hello` / `instance_ping` は接続先そのものへの op なので転送されない) |
| loc=C の op | 6 (`topic_subscribe` / `topic_unsubscribe` + messaging 4) |

