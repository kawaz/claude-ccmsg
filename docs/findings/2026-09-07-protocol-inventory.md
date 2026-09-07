# protocol (契約) 棚卸し (作り直し議論の一次資料)

- 日付: 2026-09-07
- 対象: `packages/protocol/src/` 全 7 ファイル (3,631 行) + それを補う daemon / webui / cli
  側の「実装上の約束事」
- 目的: ccmsg を daemon / protocol / webui の 3 リポに分離し、規約 (プロトコル)
  ファーストで作り直す議論の一次資料。**設計案は書かない**。事実の棚卸しと、
  疑わしいものの根拠付き列挙まで。
- 前提資料: `docs/decisions/DR-0003` (wire/storage)、`DR-0016` (seq)、`DR-0029` 追補
  (request_id)、`docs/issue/2026-09-07-multi-host-cluster.md` (クラスタ化)
- 数値は 2026-09-07 時点の `wc -l` / `grep` 実測。

## 判明した事実

1. **protocol は 3,631 行、うち `index.ts` が 3,220 行 (89%)**。`index.ts` の
   **1,713 行 (53%) がコメント**で、実行時コードは `llmCacheWindowEndMs` 1 関数だけ。
   残りはすべて型宣言 (interface 184 / type 19 / const 20)。**wire を検証する
   コードは protocol に 1 行も無く**、`typeof req.x` 相当の検査は daemon の
   `server.ts` (4,008 行) に手書きで散っている。
2. **op は 56 個**。宣言 (`RequestBody` union) と daemon の `case` は**完全に一致**
   (declared − handled = 空、handled − declared = 空)。定義されていない op を呼ぶ
   コードも、呼ばれない op も**リポ内には無い**。
3. **role の内訳は user-only 36 / session-only 1 (`say`) / どちらでも 19**。
   つまり **op の 64% は webui 専用**で、エージェント (session role) が使うのは
   room 系 + `say` + `notify` + `subscribe` の 20 個だけ。
4. **role 違反は専用エラーコードを持たず `bad_request` を返す** (`sendErr(conn,
   ErrorCode.bad_request, "op 'kick' requires user role")` の形)。`ErrorCode` は
   29 個の値を持つ const object だが、**wire の型は `ErrorBody { code: string }`**
   で ErrorCode を参照しておらず、**クライアント側は `ErrorCode` を一度も import
   していない** (webui / cli とも 0 件)。判定は `res.error.code === "file_conflict"`
   のような文字列リテラル比較 (webui に 5 箇所)。
5. **push event は 12 種**。うち **`ev:"net_online"` だけが `StreamEvent` union に
   入っていない** (`index.ts:869` で定義、`889-901` の union に不在)。daemon は
   送っているが、型の上ではストリームに流れないことになっている。
6. **`seq` と `mid` の二重系列**。`mid` は msg 専用の per-room 連番、`seq` (DR-0016) は
   全 event 型を貫く per-room 連番。`subscribe` は `since` (mid) と `since_seq` (seq)
   の**両方**を受け取り、daemon は room ごとにどちらを使うか分岐する
   (`server.ts:2568-2571`)。`since` を送るクライアントは**リポ内に存在しない**
   (cli / webui とも `since_seq` のみ)。
7. **時刻の単位が同じ命名で 2 系統に割れている**。`_at` サフィックスは ISO 文字列
   (`connected_at` / `joined_at` / `polled_at` …) と epoch ms (`observed_at` /
   `generated_at` / `expires_at` …) の両方に使われ、**`started_at` は
   `WorkflowAgentStatus` で number、`SessionWorkflowStatus` / `SessionBackgroundStatus`
   で string**。`created_at` / `updated_at` も `LlmStatusIncident` は number、
   `SessionSearchHit` は string。`ts` も `MsgEvent` は ISO 文字列、`LlmRequestInfo` は
   epoch ms。
8. **契約が webui という特定実装を名指ししている箇所がある**。`ClientTracePoint.comp`
   は `"webui"` のみを許すリテラル型 (`index.ts:1878`)。`HelloRequest` の `nav_type`
   (`PerformanceNavigationTiming.type`) と `ua` (`<platform>/<browser>`) もブラウザ
   固有で、どちらも「診断専用」と明記されている。
9. **クラスタ化に必要な概念が 1 つも無い**。`host` に相当するフィールドは protocol
   全体で 0 件、room id は daemon ローカルの連番 `r<N>` (`server.ts:1615-1616` で
   `while (daemon.rooms.has(id)) id = \`r${++n}\`` と採番、protocol 側に定義も正規表現も
   無い)、op を他 daemon へ転送する封筒も `host_unreachable` 相当のエラーコードも無い。
10. **配布は monorepo の workspace package 1 個** (`@ccmsg/protocol`、`main` が
    `./src/index.ts` = ビルド無しの TS 直参照)。import しているファイルは daemon 66 /
    webui 64 / cli 7 の計 137。testkit と translate-helper は protocol を使わない。

## 実用的な示唆

- op の 64% が user-only という偏りは、「1 つの wire に *エージェント間メッセージング*
  と *webui のバックエンド API* が同居している」ことの数値的な現れ。分離議論の
  第一の切れ目はここ (role) にあり、次が「room 系 (11 op) / fs 系 (12 op) /
  session 系 (11 op) / llm 系 (3 op) / transcript 系 (4 op)」のドメイン境界。
- 「型だけ / 検証は daemon 側の手書き」という現状は、protocol リポを独立させた瞬間に
  **契約の唯一の実行可能な表現が無くなる**ことを意味する。既に `sendDeliveredMsg`
  (`server.ts:473-500`) は `DeliveredEvent` 型を使わず `Record<string, unknown>` を
  手で組み立てており、型と実装の乖離を検出する仕組みが無い。
- 時刻・識別子・エラーの 3 つは、いずれも「upstream (claude agents / llm-gateway) の
  値をそのまま通す」判断が入口で、その pass-through が命名と単位の不統一として
  契約に漏れている (§4)。作り直すなら「正本が誰か」を型ごとに宣言する場所が要る。
- クラスタ化の観点では、room id・sid→pid・パス・sandbox URL・hyoui ハンドルがすべて
  ホストローカルであり (§5.6)、「host を足す」だけでは済まない箇所が列挙できる。

---

## 1. 全体像

| 項目 | 値 |
|---|---|
| protocol 総行数 | 3,631 (7 ファイル) |
| `index.ts` | 3,220 行 / うちコメント 1,713 行 (53%) |
| 補助ファイル | `paths.ts` 112 / `file-search-query.ts` 97 / `search-query.ts` 63 / `version.ts` 55 / `config-migration.ts` 51 / `version-compare.ts` 33 |
| export 総数 (全ファイル) | 243 (interface 184 / type 19 / const 20 / function 1 + 補助 19) |
| op 数 | 56 (`RequestBody` union) |
| response 数 | 53 (`ResponseBody` union、`ErrorResponse` 含む) |
| push event 数 | 12 (`ev:` を持つもの。`StreamEvent` union は 12 メンバだがうち 1 は `DeliveredEvent`、`net_online` は union 外) |
| storage event 数 | 10 (`StorageEvent` union) |
| ErrorCode 数 | 29 |
| role | `session` / `user` の 2 値 (`Identity` union)。member id は別体系 (`u1` = admin 固定、`u2+` guest、`a1+` agent) |
| 版 | `PROTOCOL_VERSION = 1` (手動 bump)、`UNANNOUNCED_PROTOCOL_VERSION = 1`、`VERSION` = root package.json の版 |
| 輸送 | UDS (`daemon.sock`) と WS (`/ws`) で **同一の 1 行 1 JSON**。`http.ts` は接続と Origin/IP 検査のみを担い、dispatch は共通 (`http.ts:3` のコメントが明言) |
| 配布 | workspace package `@ccmsg/protocol`、`main: ./src/index.ts` (ビルド成果物なし)。import 元は daemon 66 / webui 64 / cli 7 ファイル |

### 版と互換の扱い

| 仕組み | 内容 |
|---|---|
| `PROTOCOL_VERSION` | wire 世代。リリースでは動かず手動 bump。**異なる世代の hello は `bad_request` で拒否**され、互換パスを持たない (DR-0002 §4「ホスト単位で一斉に更新する」) |
| `UNANNOUNCED_PROTOCOL_VERSION` | `protocol` を送らない旧クライアント = 世代 1 と**定義**する (互換パスではないと明記)。次の bump 時にはそのまま拒否対象になる |
| `client_version` | hello が申告する ccmsg ビルド。**診断専用**、daemon は一切ゲートしない |
| `StaleClientInfo` | hello を拒否されたクライアントの記録 (`PeerInfo.stale_client`)。`protocol` の有無で「世代不一致」と「request_id 欠落」を区別する |
| `HelloResponse.protocol` | daemon の世代。到達した時点で一致は確定しているので「表示用、分岐するな」と明記 |

### 互換のための残骸 (現役でないもの)

| 対象 | 状態 |
|---|---|
| `SubscribeRequest.since` (mid ベース) | 「old-client compat のため保持」とコメント。**リポ内に送信側が無い** (cli / webui とも `since_seq`)。daemon の分岐 (`server.ts:2568-2571`) だけが生きている |
| `RoomSummary.live_members` の absent | 「daemon が古い場合は unknown」と定義。単一 monorepo で daemon と client が同時更新される以上、到達しない分岐 |
| `Response.request_id` の optional | 「envelope 以前の daemon 相手」のための optional。同上 |

---

## 2. op 一覧 (56)

呼び出し元の凡例: **cli** = `packages/cli/src`、**web** = `packages/webui/src`。
role は daemon `server.ts` の実装から採取 (宣言的な表は protocol 側に存在しない)。
error 欄は当該 op に固有のコードのみ (全 op が `bad_request` / `invalid_args` を返しうる)。

### 2.1 接続・診断 (4)

| op | role | request 主要フィールド | response | 固有 error | 呼び出し元 |
|---|---|---|---|---|---|
| `hello` | any | `role`, `sid`,`repo`,`ws`,`cwd`,`transcript_path`,`repo_root`,`branch`,`config_dir`,`client_version`,`protocol`,`nav_type`,`ua` | `HelloResponse` (version/protocol + 能力フラグ 5) | — | cli, web |
| `ping` | any | — | `PingResponse` (version,uptime,pid,rooms,clients,exe,script,http,httpAllow,network) | — | cli, web |
| `shutdown` | any | `reason?` | `{stopping:true}` | — | cli |
| `client_trace` | user | `sid`,`start`,`end`,`size`,`sampled`,`elapsed_ms`,`points[]` | `{written}` | — | web |

### 2.2 room / メッセージング (13)

| op | role | request 主要フィールド | response | 固有 error | 呼び出し元 |
|---|---|---|---|---|---|
| `create_room` | any | `members[]`,`msg?`,`title?`,`include_self?`,`kind?` | `{room,reused,mid?,warning?}` | `one_on_one_requires_single_member` | cli, web |
| `next_room` | any | `room`,`msg?`,`title?` | `{room,mid?}` | `room_not_found` | cli |
| `post` | any | `room`,`msg`,`to?` | `{room,mid}` | `broadcast_agent_target_required`, `reply_via_tl` | cli, web |
| `reply` | any | `room`,`mid`,`msg` | `PostResponse` | `msg_not_found`,`self_reply`,`reply_via_tl` | cli |
| `read` | any | `room`,`mids` (range 文字列 or number[]) | `{room,msgs[]}` | `room_not_found`,`not_a_member` | cli, web |
| `room_history` | any | `room` | `{room}` (**snapshot 送出後に届く完了 sentinel**) | `room_not_found` | web |
| `rooms` | any | — | `{rooms: RoomSummary[]}` | — | cli, web |
| `set_title` | any | `room`,`title` | `{room,title}` | `room_not_found`,`not_a_member` | web |
| `archive_room` | any | `room`,`archived` | `{room,archived}` | 同上 | web |
| `invite` | any | `room`,`sid` | `{room,id,already}` | 同上 | web |
| `leave` | any | `room` | `{room}` | 同上 | cli |
| `kick` | **user** | `room`,`id` | `{room,id}` | `room_not_found` | web |
| `subscribe` | any | `since?`,`since_seq?`,`backlog?` | `{subscribed:true}` + 以後ストリーム | — | cli, web |

### 2.3 通知・say (3)

| op | role | request | response | 固有 error | 呼び出し元 |
|---|---|---|---|---|---|
| `notify` | any | `sid?`,`text` | `{delivered}` | — | cli, web |
| `say` | **session** | `text` | `{room,seq,created}` | — | cli |
| `say_read` | **user** | `room`,`seq` | `{room,ref}` | — | web |

### 2.4 セッション観測・操作 (11)

| op | role | request | response | 固有 error | 呼び出し元 |
|---|---|---|---|---|---|
| `peers` | any | — | `{peers[], last_live?}` | — | cli, web |
| `agents` | user | — | `{agents[], polled_at}` | — | web |
| `session_status` | user | `sid` | snapshot + `sid` | `not_found` | web |
| `session_status_subscribe` | user | `sid` | **snapshot + `sid` (`session_status` と同一形)** | `not_found` | web |
| `session_status_unsubscribe` | user | `sid` | `{sid}` | — | web |
| `session_errors` | user | — | `{errors[]}` | — | web |
| `session_kill` | user | `session_id`,`force?` | `{terminated}` | `session_not_found` | cli, web |
| `session_rename` | user | `session_id`,`title` | `{hyoui_session_id,title}` | `terminal_unavailable` | web |
| `session_env` | user | `session_id` | `{pid, env}` | `session_not_found` | web |
| `last_live_remove` | user | `sid` | `{removed}` | — | web |
| `session_search` | user | `query?`,`case_sensitive?`,`regex?`,`target_user?`,`target_agent?`,`cwd?`,`sid?`,`config_dirs?`,`mtime_within?` | `{hits[],truncated}` | — | web |

### 2.5 transcript (5)

| op | role | request | response | 固有 error | 呼び出し元 |
|---|---|---|---|---|---|
| `transcript_read` | user | `sid`,`before?`,`max_bytes?`,`agent_id?`,`run_id?`,`teammate?` | `{sid,lines[],start,end,size}` | `not_found` | web |
| `transcript_subscribe` | user | `sid` | `{sid,size}` | `not_found` | web |
| `transcript_unsubscribe` | user | `sid` | `{sid}` | — | web |
| `fork_origin` | user | `sid` | `{origin: ForkOrigin|null}` | `not_found` | web |
| `session_dump_file` | user | `sid`,`since?`,`until?`,`no_thinking?`,`no_agent?` | `{path,entries,bytes}` | `not_found` | web |

### 2.6 ファイルアクセス (12)

`kind` は認可面の選択子: `contained` (containment root 相対) / `workspace` (DR-0026 の
ディレクトリ prefix 許可、絶対パス) / `external` (DR-0024 の完全一致 1 ファイル許可、絶対パス)。

| op | role | request | response | 固有 error | 呼び出し元 |
|---|---|---|---|---|---|
| `fs_list` | any | `sid`,`path?` | `{sid,path,entries[]}` | `path_forbidden`,`not_found` | web |
| `fs_read` | any | `sid`,`path` | `{sid,path,size,truncated,binary,content,mtime}` | 同上 | web |
| `fs_read_external` | user | `sid`,`path` (絶対) | `FsReadResponse` | 同上 | web |
| `fs_list_workspace` | user | `sid`,`path` (絶対) | `FsListResponse` | 同上 | web |
| `fs_read_workspace` | user | `sid`,`path` (絶対) | `FsReadResponse` | 同上 | web |
| `fs_write` | user | `sid`,`path`,`content` | `{sid,path}` | `path_not_writable`,`file_exists` | web |
| `fs_create` | user | `sid`,`path`,`kind`,`content` | `{sid,path}` | `file_exists`,`path_forbidden` | web |
| `fs_edit` | user | `sid`,`path`,`kind`,`content`,`expected_mtime`,`expected_size` | `{sid,path,size,mtime}` | `file_conflict`,`not_a_text_file` | web |
| `fs_delete` | user | `sid`,`path`,`kind` | `{sid,path}` | `path_forbidden`,`not_found` | web |
| `fs_find` | user | `sid`,`kind`,`root?`,`query`,`respect_gitignore?` | `{sid,hits[],truncated}` | `path_forbidden` | web |
| `fs_stat_batch` | user | `sid`,`paths[]` (最大 256) | `{results: (FsStatEntry|null)[]}` | — | web |
| `dir_tree` | user | `roots[]`,`depth?`,`filter?` | `{entries[]}` | `launcher_not_configured` | web |

### 2.7 launcher / sandbox / 翻訳 / llm (8)

| op | role | request | response | 固有 error | 呼び出し元 |
|---|---|---|---|---|---|
| `session_launcher_config` | user | — | `{root_dirs[],templates[]}` | `launcher_not_configured` | web |
| `session_launch` | user | `cwd`,`params`,`command?`,`template?` | `{stdout,stderr,exit_code,timed_out}` | `launcher_not_configured` | web |
| `sandbox_grant` | user | `sid`,`path`,`kind` | `{gid,token,url,exp}` | `sandbox_not_configured`,`path_forbidden` | web |
| `sandbox_revoke` | user | `gid` | `{ok}` | — | web |
| `translate` | user | `texts[]` (空 = 能力プローブ) | `{results[]}` | `translate_unavailable`,`translate_helper_failed` | web |
| `llm_usage` | user | `refresh?` | `{generated_at?,credentials[]}` | `llm_usage_not_configured`,`llm_usage_unavailable` | web |
| `llm_stats` | user | `days?` (1..36,524) | `{generated_at?,days{}}` | `llm_stats_*` | web |
| `llm_status` | user | `refresh?` | `{ok} & LlmStatusReport` | `llm_status_*` | web |

### 2.8 定義と実使用の突き合わせ

| 観点 | 結果 |
|---|---|
| 定義されているが呼ばれない op | **0** (56 op すべてに cli か webui の呼び出しがある) |
| 定義外の op を呼ぶコード | **0** |
| daemon に handler が無い op | **0** |
| cli だけが呼ぶ op | `reply` / `next_room` / `shutdown` / `leave` / `say` (5) |
| webui だけが呼ぶ op | 40 |
| 両方が呼ぶ op | `hello` / `ping` / `post` / `read` / `rooms` / `peers` / `notify` / `subscribe` / `create_room` / `session_kill` (10) |
| `Request` インターフェースの名前参照数 | ほぼ 0 (`FsEditRequest` 等 40 個以上が「名前としては」未参照)。クライアントは `{op:"fs_edit", ...}` をリテラルで組み、union 側で型付けされるため。**死んでいるわけではない** |

---

## 2'. push event 一覧 (12)

購読単位の凡例: **conn** = その接続全体、**room** = 可視 room 単位、**sid** = 明示的に
subscribe した sid 単位。

| ev | 発火契機 | 宛先 role | 購読単位 | seq | 再送・差分再生 |
|---|---|---|---|---|---|
| (`DeliveredEvent`) | storage event の append | both | room | **あり** (per-room、全 event 型横断) | `since_seq` / `since` / `backlog` / recent-replay (`replay:true`、既定 3 分) |
| `notify` | `notify` op | both | conn (対象 sid) | なし | なし |
| `restarting` | daemon 再起動前 | both | conn | なし | なし (cli は stdout から除外) |
| `subscribe_superseded` | 同一 sid に新しい subscribe | session | conn | なし | なし (受けた側は exit) |
| `room_cursors` | subscribe 時、replay しなかった room の一覧 | both | conn | なし | — (これ自体が cursor 通知。空なら送らない) |
| `agents` | agents poll の結果変化 | **user** | conn | なし | 全量置換 |
| `peers` | session の register / disconnect / hello 更新 | **user** | conn | なし | 全量置換 (+ `last_live` 同梱) |
| `transcript` | transcript への追記 | **user** | sid (`transcript_subscribe`) | なし (byte offset で整合) | `transcript_read` の offset と接続可能 |
| `session_status` | status を変える transcript event | **user** | sid (`session_status_subscribe`) | なし | 全量スナップショット |
| `session_errors` | API エラー停止セッション集合の変化 | **user** | conn | なし | 全量置換 |
| `llm_requests` | gateway の request イベント | **user** | conn | なし | **常に非期限切れ全量** (途中接続でも復元可) |
| `llm_status` | gateway が 529 を報告した後の再読 | **user** | conn | なし | 全量 |
| `net_online` | ホストのネットワーク復帰 | **session** (停止中のみ) | conn | なし | なし (1 回だけ) |

補足:

- **seq を持つのは `DeliveredEvent` だけ**。ephemeral な 11 種は順序保証も再送も無く、
  再接続時は「全量 push を待つ」か「対応する op を叩き直す」かの二択。
- `net_online` は `StreamEvent` union に**入っていない**ため、型としては消費側に
  現れない。cli は未知 ev をそのまま stdout に流すので、実質「テキストとして届く」。
- cli が stdout から落とす ev は `restarting` / `room_cursors` の 2 つ
  (`index.ts:473`)。`subscribe_superseded` は exit 契機。それ以外は素通し。
- webui が `ws.ts` で明示分岐する ev は 10 種 (`notify` は「UI には出さない」と
  コメントして捨てている)。

---

## 3. 型の体系

### 3.1 主要な共有型と正本

| 型 | 正本 | 備考 |
|---|---|---|
| `PeerInfo` | daemon の live session registry | hello 由来の申告値 + daemon の観測 (`connected_at` / `last_activity_at` / `last_user_input_at`) + 問い合わせ元依存の計算値 (`send_message`) の 3 層が同居 |
| `LastLiveSession` | daemon の state ファイル (`last-live-sessions.json`) | `PeerInfo` の凍結コピー。ただし `model`/`effort` だけは transcript から読み直す |
| `AgentInfo` | **外部** `claude agents --json` | camelCase を pass-through。`config_dir` / `hyoui_session_id` / `hyoui_namespace` は daemon が付加 |
| `LlmRequestInfo` | **外部** llm-gateway の SSE | 単位 (epoch ms) も語彙 (`origin` / `keepalive`) も gateway のもの。`main` だけが daemon の判定 |
| `LlmUsage*` / `LlmStats*` / `LlmStatus*` | **外部** llm-gateway の JSON | 「gateway が語彙を持つ」と各所に明記。ccmsg 側は正規化せず通す (例外: `LlmStatusSeverity` / `LlmStatusOfficialState` だけは閉じた union にして未知値を `"unknown"` へ落とす) |
| `SessionStatusSnapshot` | daemon の transcript fold | `todos` / `workflows` / `background` / `teammates` / `agent_tree` / `context` / `api_error` / `external_files` / `workspace_folders` の 9 系統が 1 型に同居 |
| `AgentTreeNode` / `AgentTreeGroups` | daemon が `subagents/*.meta.json` を走査した結果 | 深さ上限 5、`kind` は閉じた 3 値、`state` は open set |
| `RoomState` 相当 (`RoomSummary`) | daemon の room log | `live_members` と `say_unread_seqs` だけが「毎回計算する派生値」 |
| `StorageEvent` (10 種) | room jsonl (append-only) | ファイル行順が順序の正本、`seq` はその写像 |

### 3.2 open set (upstream 制御の string) の箇所

型としては `string` だが実際は語彙が決まっている、あるいは upstream が増やしうる箇所。
**11 箇所**あり、すべてコメントで「open set」と明示されている。

| 型.フィールド | 現在の値 | 誰の語彙か |
|---|---|---|
| `SessionTodo.status` | pending / in_progress / completed | Claude Code |
| `WorkflowAgentStatus.state` | done / error / progress / running | CC + daemon 合成 |
| `SessionWorkflowStatus.status` | running / 終了値 | CC |
| `SessionBackgroundStatus.status` | running / 終了値 | CC |
| `SessionTeammate.state` | spawned / active / idle / stopped | daemon の推定 |
| `AgentTreeNode.state` | active/idle/spawned/stopped/completed/unknown | daemon の推定 |
| `AgentInfo.kind` / `.status` / `.state` | interactive / background、waiting / running … | `claude agents --json` |
| `LlmRequestInfo.origin` / `.keepalive` | main/sub/unknown/oneshot、applied/late/foreign | llm-gateway |
| `LlmUsageWindow.status` / `LlmUsageOverage.status` / `LlmUsageAuth.status` / `LlmUsageLimit.kind` / `.severity` / `LlmUsageCredential.support` / `.type` | allowed / rejected / ok / relogin_required … | llm-gateway |
| `LlmStatusIncident.state` / `.impact` / `.scope` / `LlmStatusObserved.last_failure.kind` | investigating / monitoring / page … | provider の status page |
| `ErrorBody.code` | ErrorCode の 29 値 | **ccmsg 自身** (= ここだけは閉じられるはずなのに開いている) |

### 3.3 型の重複・同型

| 対象 | 内容 |
|---|---|
| `SessionStatusResponse` と `SessionStatusSubscribeResponse` | どちらも `SessionStatusSnapshot & {ok:true, sid}`。**構造が完全に同一** |
| `LlmStatusResponse` と `LlmStatusStreamEvent.report` | 同一 document (`LlmStatusReport`)。`ok:true` の有無だけが違うと明記 |
| `PeersResponse` と `PeersStreamEvent` | `peers[]` + `last_live?` で同型。ただし push 側では `send_message` が**必ず欠落**する (問い合わせ元が定まらないため) |
| `AgentsResponse` と `AgentsStreamEvent` | `agents[]` + `polled_at` で同型 (op 側だけ `polled_at: string \| null`、push 側は `string`) |
| `SessionErrorsResponse` と `SessionErrorsStreamEvent` | `errors[]` で同型 |
| `SessionTeammate` と `AgentTreeNode` | teammate 系フィールド (`name`/`color`/`model`/`agent_type`/`state`) が重複。後者のコメントが「mirror SessionTeammate」と明言 |
| `WorkflowPhaseStatus` と `AgentTreeWorkflowPhase` | どちらも title + done/total。後者は `index` と `members[]` を追加した上位互換 |
| `FsReadResponse` | `fs_read` / `fs_read_external` / `fs_read_workspace` の 3 op が共有 (これは意図的な統一) |

---

## 4. 規約の一貫性

### 4.1 命名

| 規約 | 遵守状況 |
|---|---|
| フィールドは snake_case | ほぼ徹底。**例外 4 件**: `AgentInfo.startedAt` / `.sessionId` / `.waitingFor` (upstream pass-through とコメントで正当化) と `PingResponse.httpAllow` (**正当化なし**、同じ型の隣に `http` がある) |
| op 名は snake_case の動詞 or 名詞 | 動詞形 (`create_room` / `archive_room` / `session_kill`) と名詞形 (`rooms` / `peers` / `agents`) が混在。取得系は名詞、操作系は動詞という緩い一貫性はある |
| `*_at` = 時刻 | §4.2 の通り単位が割れている |
| `_iso` サフィックス | **0 件**。過去の残骸は無い |
| 型名 | `<Op>Request` / `<Op>Response` で統一。例外は `SubscribeAck` (`SubscribeResponse` ではない)、`SessionLaunchResponse` 等の「Payload of a completed …」系 |

### 4.2 時刻の単位

| 表現 | 使用箇所 | 例 |
|---|---|---|
| ISO 8601 文字列 | storage event の `ts` 全 9 種、`joined_at`,`connected_at`,`last_activity_at`,`last_user_input_at`,`last_seen_at`,`polled_at`,`spawned_at`,`last_sent_at`,`last_received_at`,`started_at`(2 型),`ended_at`(2 型),`created_at`/`updated_at`(SessionSearchHit),`mtime`,`SessionContextUsage.timestamp`,`SessionApiError.timestamp`,`ClientTracePoint.ts` | 21 箇所 |
| epoch ms | `LlmRequestInfo.ts`,`cache_expires_at`,`cache_since`,`next_keepalive_at`,`cache_until`,`cache_breakeven_until`,`AgentInfo.startedAt`,`WorkflowAgentStatus.started_at`,`AgentTreeNode.last_activity_ms`,`observed_at`(3),`generated_at`(3),`reset`,`resets_at`,`created_at`/`updated_at`(Incident),`expires_at`,`last_success_at`,`last_failure.at`,`SandboxGrantResponse.exp` | 24 箇所 |
| 秒 (長さ) | `timeout_seconds`,`window_seconds`(2),`cache_ttl_secs` | 4 箇所 |
| ms (長さ) | `duration_ms`,`elapsed_ms` | 2 箇所 |

**衝突している名前**:

| 名前 | 一方 | 他方 |
|---|---|---|
| `ts` | `MsgEvent` 他 storage event = ISO 文字列 | `LlmRequestInfo.ts` / `ClientTracePoint.ts` = epoch ms / ISO |
| `started_at` | `SessionWorkflowStatus` / `SessionBackgroundStatus` = ISO | `WorkflowAgentStatus` = epoch ms |
| `created_at` / `updated_at` | `SessionSearchHit` = ISO | `LlmStatusIncident` = epoch ms |
| `_ms` サフィックス | `duration_ms` / `elapsed_ms` = **長さ** | `last_activity_ms` = **時刻** |
| 単位サフィックスなし | — | `SandboxGrantResponse.exp` (epoch ms)、`LlmUsageWindow.reset` (epoch ms) |

### 4.3 識別子

| 識別子 | 形 | 発行者 | 一意性のスコープ |
|---|---|---|---|
| `sid` | Claude Code の session UUID | Claude Code | グローバル |
| room id (`r`) | `r<N>` 連番 | **daemon** (`server.ts:1615`) | **daemon ローカル**。protocol に定義も正規表現も無い |
| `mid` | 連番 | daemon | room 内、msg のみ |
| `seq` | 連番 | daemon | room 内、全 event 型 |
| member id | `u1` (admin 予約) / `u2+` / `a1+` | daemon | room 内 |
| msg 参照 | `r<N>m<M>` (`reply_to`, `msg_via` の本文) | daemon | daemon ローカル |
| `request_id` | 任意文字列 | クライアント | **1 接続の in-flight 内のみ**。再利用可 |
| `gid` / `token` | sandbox の grant id / capability | daemon | daemon ローカル (`gid` は DNS ラベルに乗るので非秘密と明記) |
| `agent_id` / `run_id` / `teammate` | `a<...>` / `wf_XXXXXXXX-XXX` / 名前 | Claude Code | sid 配下 |
| `task_id` | Monitor/Bash の taskId、Agent の agentId | Claude Code | session 内 |
| `config_dir` | 絶対パス | ホスト | **ホストローカル** |
| `hyoui_session_id` / `hyoui_namespace` | 外部ツール hyoui のハンドル | hyoui | **ホストローカル** |

### 4.4 エラーの体系

| 観点 | 状況 |
|---|---|
| コード数 | 29 |
| wire 型 | `ErrorBody { code: string; msg: string }` — **`ErrorCode` 型を使っていない** |
| クライアントの利用 | `ErrorCode` の import は webui / cli とも **0 件**。文字列リテラル比較が webui に 5 箇所 (`launcher_not_configured` / `not_found` / `file_conflict`×2) |
| op ↔ error の対応表 | **存在しない**。どの op がどのコードを返すかは各 Request の doc コメントに散在 |
| 汎用コードへの寄せ | `bad_request` が daemon 内 41 箇所、`invalid_args` が 70 箇所。**role 違反も引数不正もフォーマット不正もすべてこの 2 つ**に集約されており、role 違反専用のコードは無い |
| 使用回数の少ないコード | `hello_required` / `unknown_op` / `not_a_text_file` / `msg_not_found` / `self_reply` / `reply_via_tl` / `broadcast_agent_target_required` / `one_on_one_requires_single_member` / `sandbox_not_configured` / `file_conflict` は daemon 内 1 箇所ずつ |
| `msg` の言語 | 英語と日本語が混在 (ErrorCode の定義コメント自体が日英混在) |

### 4.5 boolean フラグの増殖

| 箇所 | フラグ |
|---|---|
| `HelloResponse` の能力 | `llm_usage_available` / `llm_stats_available` / `llm_status_available` / `sandbox_available` / `fork_available` の 5 boolean + `terminal_gateway_url` (URL の有無が能力を兼ねる) = **6 つの能力表明が 6 通りの形**で並ぶ |
| `DeliveredEvent` の framing | `replay?: true` / `echo?: true` / `msg_via?` / `reply_via?` の 4 つで「この frame をどう扱うか」を表現。組み合わせの意味は doc コメントでのみ規定 (`echo` は必ず `reply_via` を伴わない、など) |
| `SubscribeRequest` | `since` / `since_seq` / `backlog` の 3 つで replay 方針を決める (room ごとに優先順位あり) |
| `LlmRequestInfo` | `main` / `cache_paused` の 2 boolean + `origin` / `keepalive` の open string で状態を表現 |
| `SessionSearchRequest` | `case_sensitive` / `regex` / `target_user` / `target_agent` の 4 boolean (後者 2 つは既定 true) |

### 4.6 「省略 = 何を意味するか」の明文化

明文化されている箇所は多い (「absent は unknown であって healthy ではない」等が
`LlmUsageCredential.auth` / `LlmStatusOfficial` / `PeerInfo.last_user_input_at` /
`LastLiveSession.title` などで繰り返し書かれている)。一方で規約としては統一されておらず、
同じ「空」に 3 通りの意味がある:

| 意味 | 例 |
|---|---|
| 「無い」= 空配列を送らない | `PeersResponse.last_live` (「omitted — not `[]`」と明記)、`RoomCursorsStreamEvent` (空なら送らない)、`SessionTodo.blocked_by` |
| 「無い」= 空配列を送る | `AgentTreeGroups.teammates/agents/workflows` (「空カテゴリは空配列」と明記) |
| 「不明」= 欠落 | `PeerInfo.protocol`、`RoomSummary.live_members`、`SessionTeammate.model` |

---

## 5. 疑わしいものリスト (根拠付き)

### 5.1 型が実装と一致していない / union の漏れ

| 対象 | 根拠 |
|---|---|
| `ev:"net_online"` が `StreamEvent` union に無い | `NetworkOnlineStreamEvent` は `index.ts:869` で定義されているが、`889-901` の union に含まれない。daemon (`session-wake.ts` 経由) は実際に送っている |
| `DeliveredEvent` が実装で使われていない | daemon の `sendDeliveredMsg` (`server.ts:473-500`) は `Record<string, unknown>` を手で組み立て、フィールド順まで手動管理。型と実装を突き合わせる仕組みが無い |
| `ErrorBody.code: string` | 29 値の `ErrorCode` が隣にありながら参照していない。クライアントが `ErrorCode` を import しない (0 件) のはこの型付けの帰結 |
| `ClientTracePoint.comp: "webui"` | 単一値のリテラル union。契約が特定クライアント実装を名指ししている |

### 5.2 同じ情報を 2 経路以上で送っている

| 情報 | 経路数 | 内訳 |
|---|---|---|
| session status | **3** | `session_status` の reply / `session_status_subscribe` の reply (同一形) / `ev:"session_status"` |
| room の履歴 | **4** | `subscribe` の backlog / `room_history` の snapshot / `read` (msg のみ) / `rooms` の `RoomSummary` (last_mid, members) |
| peers | 2 | `peers` op / `ev:"peers"` (ただし push 側は `send_message` を欠く) |
| agents | 2 | `agents` op / `ev:"agents"` |
| session_errors | 2 | `session_errors` op / `ev:"session_errors"` |
| llm status | 2 | `llm_status` op / `ev:"llm_status"` |
| transcript | 2 | `transcript_read` (byte offset paging) / `ev:"transcript"` (tail) |
| say の未読 | 2 | `RoomSummary.say_unread_seqs` (集合) / live の `say` + `say_read` event |
| last_live | 2 | `PeersResponse.last_live` / `PeersStreamEvent.last_live` |
| llm_requests | **1 (逆の非対称)** | push 専用で、対応する op が無い。webui は接続直後の push に依存する |

### 5.3 webui 都合のフィールドが契約に混ざっている

| 対象 | 根拠 |
|---|---|
| `HelloRequest.nav_type` | `PerformanceNavigationTiming.type` の値をそのまま。「webui が page load の最初の hello でのみ送る」と doc に明記。ブラウザ以外のクライアントには意味がない |
| `HelloRequest.ua` | `<platform>/<browser>`。同上、診断専用 |
| `ClientTracePoint` 全体 | `comp:"webui"`、`kind: "ws_receive"|"store_dispatch"|"dom_commit"` — **store / DOM という webui の内部アーキテクチャが wire に露出している** |
| `HelloResponse.terminal_gateway_url` | iframe embed の base URL。「未設定なら Terminal タブを出さない」という UI 判断が契約の説明文に入っている |
| `RoomSummary.say_unread_seqs` の Design rationale | 「webui のサイドバー 📣 マーカーを seed する」「クライアントが集合として持つので冪等」と、特定 UI の実装方針が正当化に使われている |
| `SessionStatusSnapshot.workspace_folders` | DR-0026。「reading them is a viewer feature, not something the AI session itself needs」と doc が明言 |
| `LastLiveSession.title` | `claude agents --json` の `name`。「agents poll は webui が繋がっている間しか走らない」ため欠落しうる、という webui の存在に依存した意味論 |

### 5.4 daemon / ホストの内部構造を漏らしている名前

| 対象 | 漏れている内容 |
|---|---|
| `PingResponse.exe` / `.script` / `.pid` / `.rooms` / `.clients` / `.http` / `.httpAllow` / `.network` | daemon プロセスの実行形態そのもの。`script` は「どの face の plugin cache から起動したか」を判別するためと明記 |
| `SessionEnvResponse.pid` | ホストの pid |
| `SessionRenameResponse.hyoui_session_id` | **外部ツール hyoui の名前が response 型に入っている**。`AgentInfo.hyoui_session_id` / `.hyoui_namespace` も同様 |
| `AgentInfo.config_dir` | `CLAUDE_CONFIG_DIR` の絶対パス |
| `SessionSearchHit.file` / `.config_dir` | daemon ホストの絶対パス |
| `SessionDumpFileResponse.path` | daemon ホストの絶対パス (「a successor session can be handed」= 同一ホスト前提) |
| `SessionIdentity.transcript_path` / `.repo_root` / `.config_dir` | 同上 |
| `AttachmentUploadResponse.path` | `TMPDIR/claude-ccmsg-<uid>/...` の絶対パス。「同一 UID 信頼」前提で本文に埋め込まれる |
| `ErrorCode.terminal_unavailable` の説明 | 「no HYOUI_SESSION_ID on its process」と、特定ツールの環境変数名がエラーの定義に登場 |

### 5.5 互換のための残骸 / 経緯 narrative

| 対象 | 内容 |
|---|---|
| `SubscribeRequest.since` | 「Retained for old-client compat」。送信側がリポ内に存在しない (§1 の残骸表) |
| `Response.request_id` の optional | 「envelope 以前の daemon」への配慮。monorepo 同時更新の前提では到達しない |
| `RoomSummary.live_members` の absent 分岐 | 「daemon predates the field」 |
| `PeerInfo.protocol` の absent 分岐 | 同上 |
| `LlmRequestInfo.prefix` の空文字 | 「gateway older than v0.13.0」— 外部の版番号が契約の説明に埋まっている |
| `TRANSCRIPT_READ_MAX_BYTES` のコメント | 「1 MB (kawaz r76 m107、2026-07-31。500KB を試して増量)。旧 2 MB (kawaz r15 mid=18 …) は … 縮小した」— **値の変遷史がそのまま残っている** ([[no-historical-noise]] に照らして削除対象) |
| `SessionLauncherConfig.clean_env` / `keep_env` | 「DR-0018 §3.1 addendum 2026-07-18」「(2nd)」と追補の回数が本文に |
| ルーム参照コメント全般 | `kawaz r38 mid=23` / `r44 m7` / `r46 m8` / `r135m16` / `r244 m5-m6` / `r55m133` 等、**room+mid の会話参照が 20 箇所以上**。protocol 外の会話ログに依存した根拠付け |
| `SessionTodo.blocked_by` / `AgentTreeNode.kind` 等 | doc コメントが日本語と英語で混在 (同一 interface 内で切り替わる箇所もある) |

### 5.6 クラスタ化 (`docs/issue/2026-09-07-multi-host-cluster.md`) の観点で足りない概念

issue の骨子 1〜8 に対して、現契約に**存在しない**もの:

| issue の要求 | 現状 |
|---|---|
| セッション系オブジェクトに host 属性 | `host` に相当するフィールドは protocol 全体で **0 件**。`PeerInfo` / `AgentInfo` / `LastLiveSession` / `SessionSearchHit` はいずれも「1 台の daemon が見ているもの」を前提とした形 |
| room id がホストを含意する | room id は `r<N>` の daemon ローカル連番 (`server.ts:1615-1616`)。**protocol 側に id の文法定義も正規表現も無い** ため、形を変える際の正本が存在しない。`reply_to` / `msg_via` が使う `r<N>m<M>` 参照も同じ形 |
| room に持ち主 daemon、mid/seq は持ち主が振る | 現在は「この daemon が全 room の mid/seq を振る」ことが暗黙。`MsgEvent.mid` / `seq` に発行者を示す情報は無い |
| op を担当 daemon へ relay | 転送用の封筒が無い。`RequestEnvelope` は `request_id` 1 フィールドのみで、宛先ホスト・ホップ数・転送元を表現できない |
| 持ち主ホスト断絶時の失敗 (`host_unreachable`) | 該当する ErrorCode が無い。最も近いのは `session_not_found` / `room_not_found` だが、どちらも「存在しない」を意味しており「到達できない」と区別できない |
| 断絶ホストのセッションを Disappeared 扱い | セッションの状態は「`peers` に居る / 居ない」の 2 値のみ。`PeerInfo` に生死・到達性を表す軸が無い (`stale_client` は別概念) |
| hyoui をホスト単位で解決 | `AgentInfo.hyoui_session_id` / `hyoui_namespace` はホストローカルなハンドルだが、どのホストのものかを示す情報を持たない。`session_rename` も同様 |
| 表示系イベントをメンバ間で relay | push event に発生元を示すフィールドが無い (`ev:"peers"` / `"agents"` / `"llm_requests"` はいずれも「全量置換」の意味論なので、**複数ホストからの全量置換が衝突する**) |
| daemon 間認証 | `Identity` は `session` / `user` の 2 role のみ。daemon 自身を表す role が無い |

ホストローカルであることが型から読み取れない値 (クラスタ化で意味が壊れる箇所):

`sid`→pid 解決を前提とする `session_kill` / `session_env` / `session_rename`、
絶対パスを扱う全 `fs_*` op と `dir_tree` / `session_launch` / `session_dump_file` /
`session_search`、ホスト固有 origin を返す `sandbox_grant`、ホストの gateway を
指す `llm_usage` / `llm_stats` / `llm_status`、`ping` の全フィールド。

### 5.7 その他の疑わしいもの

| 対象 | 根拠 |
|---|---|
| `session_status` と `session_status_subscribe` の response が同一構造 | subscribe の ack が snapshot を兼ねているため、one-shot 版が構造的に不要に見える。両方 webui から呼ばれている |
| `room_history` の response が sentinel | `{ok:true, room}` を「snapshot 完了マーカー」として使う契約。データではなく**順序**が意味を持つ唯一の response |
| `RoomSummary` に集約と派生が同居 | 永続値 (`title`,`members`,`last_mid`) と毎回計算する派生値 (`live_members`,`say_unread_seqs`) が同じ型に並ぶ |
| `SessionStatusSnapshot` の 9 系統 | todos / workflows / background / teammates / agent_tree / context / api_error / external_files / workspace_folders。最後の 2 つは**認可の allowlist** であって status ではない (`external_files` は「fs_read_external が受け付けるちょうどその一覧」と doc が明言) |
| `HelloResponse` の能力フラグが user role のみ | session role の hello は能力を一切受け取らない。能力ネゴシエーションが role に依存する非対称 |
| `subscribe` の replay 方針が 3 パラメータ × room ごとの優先順位 | `since` / `since_seq` / `backlog` + recent-replay 窓 (既定 3 分、`CCMSG_RECENT_REPLAY_MS`) の組み合わせで挙動が決まり、真理値表が doc コメントに散っている |
| protocol が環境変数の既定値を持つ | `DEFAULT_HTTP_BIND` / `DEFAULT_HTTP_ALLOW` / `DEFAULT_DEDUP_WINDOW_MS` / `DEFAULT_JOIN_BACKLOG` / `DEFAULT_ATTACHMENT_MAX_BYTES` / `DEFAULT_DIR_TREE_DEPTH` / `DEFAULT_LAUNCH_TIMEOUT_SECONDS` — **daemon の運用既定値**であって wire の契約ではない |
| `paths.ts` / `config-migration.ts` が protocol にある | ファイルシステムレイアウト (state/config/data の分離) と設定ファイル移行は daemon の関心。webui は import していない |
| `AttachmentUploadResponse` が Response union の外 | HTTP multipart 専用のため意図的に union から外されている (DR-0015 §2.3)。**契約に「wire に乗らない型」が同居**している |
| `search-query.ts` / `file-search-query.ts` | クエリ文法のパーサ (計 160 行)。protocol 内で唯一の実行時ロジック群だが、`index.ts` からは `export *` されるだけで型としての接点が薄い |

---

## 6. 数値まとめ

| 指標 | 値 |
|---|---|
| protocol 総行数 / ファイル数 | 3,631 / 7 |
| `index.ts` の行数 / コメント率 | 3,220 / 53% |
| export 総数 | 243 |
| interface / type / const / function | 184 / 19 / 20 / 1 |
| op 数 | 56 |
| op の role 内訳 (user / session / any) | 36 / 1 / 19 |
| response 型 (`ResponseBody` union) | 53 |
| push event | 12 (うち union 外 1) |
| storage event | 10 |
| ErrorCode | 29 (クライアントの import 0 件) |
| 定義されているが呼ばれない op | 0 |
| 定義外の op を呼ぶコード | 0 |
| daemon の op handler | 56 (宣言と完全一致) |
| `server.ts` (dispatch 側) の行数 | 4,008 |
| `bad_request` / `invalid_args` の daemon 内出現 | 41 / 70 |
| 時刻フィールド (ISO / epoch ms / 秒 / ms) | 21 / 24 / 4 / 2 |
| 単位が名前と衝突している時刻フィールド | 5 パターン |
| open set の string フィールド | 11 箇所 |
| camelCase の例外フィールド | 4 (うち正当化なし 1) |
| `_iso` 残骸 | 0 |
| 同じ情報の複数経路 | 9 系統 (最大 4 経路) |
| host 相当フィールド | 0 |
| protocol を import するファイル (daemon / webui / cli) | 66 / 64 / 7 |
