# DR-0036 段 C (room の削除) の前の room 依存の棚卸し

- Date: 2026-10-13

## 判明した事実

- room 系の op は、DR-0036 §2 に列挙されたもの (`create_room` / `next_room` / `read` / `room_history` / `rooms` / `leave` / `invite` / `kick` / `archive_room` / `set_title`) がすべてまだ実装に残っている。既に無くなった op は無い
- 列挙に無いが room に依存しているもの:
  - `post` / `reply` の room 宛て経路
  - stream event の `room_cursors`
  - `ping` の `rooms` (daemon が持つ room 数)
  - `PeerInjector.send` (room 封筒)
  - `refuseOneOnOneWrite`
  - ErrorCode の `room_not_found` / `not_a_member` / `broadcast_agent_target_required` / `self_reply` / `msg_not_found`
  - `IDENTITY_OPS` の room 系の行
- 読み取り専用の閲覧には、一覧 (`rooms`) と本文 (`room_history`) に加えて `read` も要る。webui の Timeline (`packages/webui/src/client/components/Timeline.tsx` の `useCcmsgBody`) が、過去の transcript に出る room メッセージの全文を `read` で取り寄せて差し替えている
- `classifyCcmsgSendResult` についての DR-0036 Consequences の懸念は、段 A で解消済み。直送の CLI は届いた時に `{"delivered":true,"mid":…}` を返し、`ok` を含まない (`packages/cli/src/index.ts` の `runDirectSend`)
- notify の配送 (`notifySession`) と net_online は room に依存しない
- dump (`packages/daemon/src/session-dump.ts`) は `rooms/` を自前で直接読む。`storage.ts` と daemon のメモリ上の room は経由しない
- session-search が `ADMIN_ID` を使うのは、transcript の task-notification に埋め込まれた room msg の `from:"u1"` を user と判定するため。room ファイルを検索しているわけではない
- 実機のデータ (`~/.local/share/ccmsg/rooms/`):
  - 規模: 396 ファイル、6.5MB。うち 1on1 が 218、broadcast が 1 (r33)
  - 最近の更新: 14 日以内に更新されたものが 47、30 日以内が 98
  - 2026-10-13 時点でも、業務面のセッション同士が room (r394 / r396) で `post` / `reply` を使って会話していた。直送の送り口 (段 A) ができた後も、エージェントは room を使い続けている
- 迷子になった試験用の v1 daemon が data dir を共有したまま動いており、broadcast room に同じ seq の行 (342 組) を書いていた。この daemon は停止済み

## 実用的な示唆 / ベストプラクティス

- room は今も使われている。段 C の最初の段では、CLI の `post rN` / `reply rNmM` をいきなり消さず、`ccmsg post <sid>` と `ccmsg peers` へ案内するエラーにする
- 閲覧用の op は 2 案ある (詳細は「閲覧に要るもの」)。読み取り専用の読み手を新しく作り、session-dump と共有する案 B を推奨する。daemon のメモリ上の room と書き込み経路がすべて消え、room ファイルを読む処理が `storage.ts` と `session-dump.ts` に二重にある状態も解消できる
- 過去の transcript を描くための部分は room と一緒に消さない:
  - transcript-model / ccmsg-direct-transcript の room 封筒と `rNmM` の抽出
  - `classifyCcmsgSendResult` の `other-ccmsg` 分岐
  - session-search の `ADMIN_ID`
  - webui の u1 発の行の描画
- 削除の順序は、書き込みを閉じる → 配送をなくす → storage を読み取り専用にする → 閲覧の UI を最小にする → docs とする (「削除の順序案」)

## 検証の詳細

調べ方: 対象リポの `packages/*/src` と `packages/*/test` を grep し、`packages/daemon/src/server.ts` の op の分岐と配送の関数を読んだ。実機のデータは `ls` / `find -mtime` / `grep` で数えた。テストの件数は grep による概数。

### room 系の op と使っている側

| op | CLI | webui | daemon 内部・その他 |
|---|---|---|---|
| `post` | `post rN` (`ROOM_ID_RE` で直送と分岐)、`--to` | Composer.tsx | broadcast で u1 宛てを必須にする制約、`to` の検証、`deliver` |
| `reply` | `reply rNmM` (直送の mid でなければ room 宛て) | なし | `reply_to: rNmM`、room 封筒の返信行 (`injectMessage`) |
| `create_room` | `create-room` (`--members` / `--exclude-self` / `--kind`) | RoomCreator.tsx、SessionRooms.tsx | dedup の索引、`createRoom`、`generateRoomId`、`deliverNewRoom` |
| `next_room` | `next-room` | なし | next/prev のリンク |
| `read` | `read rNmM` / `read <room> <mids>` | Timeline.tsx の `useCcmsgBody` (TL の全文の取り寄せ) | `readMsgs` / `parseMidSelector` |
| `room_history` | なし | RoomView.tsx | `sendBacklog` (配信 event として流し、返事を最後に送る) |
| `rooms` | `rooms` (`--all`) | ws.ts (接続時に一覧を取る) | `live_members` (`ADMIN_ID` を除いて数える) |
| `leave` | `leave` | なし | `appendLeaveAndBroadcast` |
| `invite` / `kick` / `archive_room` / `set_title` | なし | RoomView (DnD での招待、✕、archive)、RoomTitle.tsx | 権限は u1 か member |
| `subscribe` の room 配送 | `subscribe --since`、`room_cursors` を握りつぶす処理 | ws.ts の `since_seq` (localStorage `ccmsg.since_seq`) | `sendBacklog`、recent replay (`CCMSG_RECENT_REPLAY_MS`)、`room_cursors`、`streamsMsgs` |
| `to` の配信フィルタ | `--to` | Composer の mention | `msgVisibleTo` / `normalizeTo` / `injectToSessions` |
| per-room seq / `since` / `since_seq` | `--since` | `saveSince` | `storage.appendEvent`、`backfillSeq` |
| broadcast room | `--kind broadcast` | RoomView のバッジ | `joinAllBroadcasts` / `leaveAllBroadcasts` (hello と forgetSession から呼ばれる)、`isSuppressedForBroadcastStream` |

### 閲覧に要るもの

一覧 (id / title / 件数 `last_mid` / 最終更新 `last_ts`)、本文、TL の全文の取り寄せの 3 つ。

| 案 | 形 | 消せる `storage.ts` の範囲 |
|---|---|---|
| A: op 名を残して返事を縮める | `rooms` (members・`live_members`・kind・archived を残すか落とすか選ぶ)、`room_history` (配信 event として流すのをやめ、返事に events を入れる)、`read` | `appendEvent`・`scheduleFsync`・`flushRoom`・`closeRoom`・`fd`・`fsyncTimer`・dedup の欄・`nextAgentMemberId`・`createdAt`・next/prev。`loadRoom` で壊れた末尾行を切り詰めて書き戻す処理も「読むときに捨てる」に変える。起動時の `scanRooms` とメモリ上の保持は残る |
| B: 読み取り専用の新しい読み手 | 要求のたびにファイルを読み、`mtime-cache.ts` で使い回す。session-dump の `loadContextRooms` と room メッセージの読み込みを同じ読み手にまとめる | `storage.ts` を丸ごと消せる。`daemon.rooms` / `dedupIndex` / 起動時の scan も消える |

### room 以外が room の仕組みに依存している箇所

| 箇所 | 現状 | 段 C 後 |
|---|---|---|
| 1on1 | `refuseOneOnOneWrite`、say 行の抑止 (`isSuppressedForSubscriber`)、RoomReadOnlyNote、RoomList の「1on1」の折り畳み、store.ts の 1on1 の say 行、one-on-one.test (14 件) | 書き込みの拒否は op ごと消える。閲覧で kind をどう表示するかだけが残る |
| `ADMIN_ID` (daemon) | server.ts の 14 箇所 (`resolveFrom`、u1 を配信フィルタから免除、kick の拒否、`live_members`) | room と一緒にすべて消える |
| `ADMIN_ID` (session-search) | task-notification の `<event>` に入った room msg の `from:"u1"` を user と判定 | 過去の transcript を読むために残す |
| `ADMIN_ID` (webui) | TimelineItem / Timeline / utils の `memberLabel` / MemberChip / Composer / CatalogView | u1 発の行の描画のために残す。Composer・MemberChip の分は消える |
| `classifyCcmsgSendResult` | 直送の stdout は `ok` を含まない | `other-ccmsg` の分岐は、過去の transcript にある `{"ok":true,room,mid}` を読むために残す。新しく打たれた `post rN` は stderr のエラーになり、`failed` に分類される |
| transcript-model / ccmsg-direct-transcript | room 封筒・`rNmM`・tool_result の `{ok,room,mid}` を抽出し、`ROOM_REPLY_LINE_RE` で返信行を落とす | 過去の transcript を描くためにすべて残す |
| dump (session-dump.ts) | `rooms/` を自前で直接読む | ファイルが残る限りそのまま動く。案 B なら閲覧と読み手を共有できる |
| URL | `/r/<room>`、`/r/<room>/m<mid>`、`/s/<sid>/rooms`、`sb.panel=room`。issue-ref.ts が `rNmM` から `/r/rN/mM` へリンクを張る | `/r/…` は、本文や TL の `rNmM` から飛ぶ先として残すのが妥当。`/s/<sid>/rooms` と `sb.panel=room` は消す候補 |
| subscribe の stream | room の event、`room_cursors`、notify、net_online、user 向けの push (agents / peers / says / llm 系) | room の event・`room_cursors`・`since` / `since_seq` / `backlog`・recent replay を消す |
| peer-inject | `PeerInjector.send` (room 封筒)、`InjectMessage.mid` の `rNmM` | 消す。`deliver` は直送が使うので残る |

### テスト

room に言及するファイルの grep による概数。

| 区分 | room 専用 (消すか大きく直す) | 無関係なテストが道具に使っているだけ (別の op に差し替え) |
|---|---|---|
| daemon | integration (44 件のほぼ全部)、broadcast 12、one-on-one 14、storage 11、event-seq 6、subscribe-recent-replay 6、subscribe-no-backlog-default 4、room-history 3、reply 5、subscribe-msg-field-order 5、peer-inject の daemon 配送 4 件、say の 1on1 関連 2 件 | http-transport 3 件、llm-events-relay (目印の post)、agents (目印の post、broadcast の leave 1 件)、subscribe-superseded 2、request-correlation (エラーを起こす道具として `read` を使う) |
| cli | cli.test (46 件中、room 系は約 14 件以上)、reconnect 2 | client-correlation (`leave` / `post` を偽の op として使う)、daemon-restart、subscribe-duplicate、cli-output の `CliRoomsSchema` |
| webui | rooms-filter 8、room-creator 14、room-readonly-note 3、store.test の room 系 (約 59/135)、ws.test (約 13/54)、utils.test (約 38/232) | navigation / locator / sidebar-url の room の部分 |
| protocol | request.test 約 5、response.test 約 2、frame / stream-event の `room_cursors` | なし |

閲覧に残すテスト:

- storage の membership の導出と壊れた末尾行の読み方 (読み取り専用の版に直す)
- room-history (返事の形に合わせて直す)
- integration の「存在しない room は `room_not_found`」
- locator の `/r/`、issue-ref の `rNmM`
- transcript-model の room 抽出 (すべて)
- session-dump の room 2 件
- store の `rooms/loaded` と履歴の読み込み

### docs

- README.md / README-ja.md:
  - 概要 (「browses rooms」)
  - web UI の節 (u1 として post する説明、URL fragment の説明。後者は既に古い)
  - Design の節 (room 前提)
- docs/design/webui-url-grammar.md (`/r/…`、`/s/<sid>/rooms`、`sb.panel=room`)
- docs/design/webui-architecture.md (store の `rooms`)
- docs/design/protocol-package.md (request-rooms / storage-event / u1・a1 の採番)
- CLI の help 本文 (`packages/cli/src/index.ts`、`CCMSG_DEDUP_WINDOW_MS` を含む)
- DR の置き換え注記: DR-0001 / 0003 / 0011 / 0012 / 0013 / 0016 / 0017 / 0027 §1〜4、DR-0036 の Status

docs/runbooks には room の記述が無い。protocol-v2*・daemon-v2・webui-rebuild-checklist は v2 の文書なので対象外とした。

### 削除の順序案

各段で `just test` が通る単位に分ける。

1. C1 書き込みの口を閉じる
   - CLI: `post rN` / `reply rNmM` / `create-room` / `next-room` / `leave` を、`ccmsg post <sid>` と `ccmsg peers` へ案内するエラーにする
   - daemon: `post` / `reply` / `create_room` / `next_room` / `leave` / `invite` / `kick` / `set_title` / `archive_room` と、broadcast の自動 join / leave を消す
   - webui: Composer / RoomComposerFab / RoomCreator / room-creator.ts / RoomTitle の編集 / kick / archive / invite / `sb.panel=room` を消す
   - 残すもの: `rooms` / `room_history` / `read`、subscribe の配送、storage
   - テスト: 書き込み系を消す。道具に使っている側は notify / peers / ping に差し替える
2. C2 配送をなくす
   - daemon: `deliver` / `injectToSessions` / `injectMessage` / `msgVisibleTo` / `sendBacklog` の subscribe 経路 / recent replay / `room_cursors` / `since` / `since_seq` / `backlog` / `PeerInjector.send` を消す
   - CLI: `subscribe --since` を消す
   - webui: ws.ts の `since_seq` と `rooms/history-reset` を消す
   - テスト: event-seq、subscribe-*、reconnect、peer-inject の一部
3. C3 storage を読み取り専用にする
   - 案 B の読み手を足して session-dump と共有し、`storage.ts`・`daemon.rooms`・`dedupIndex`・`createRoom` を消す
   - `rooms` / `room_history` / `read` の返事を縮める
   - protocol の request-rooms / response-rooms と ErrorCode を整理する
   - webui の store を新しい返事の形に合わせる
4. C4 閲覧の UI を最小にする
   - RoomView を読み取り専用にし、RoomList を簡素にする
   - SessionRooms タブと、rooms-filter の active / inactive の区別 (`live_members` 由来) を消す
   - C1 にまとめてもよい
5. C5 docs: 上の「docs」の一覧と、DR-0036 の Status を更新する

### 判断が要る点

1. 閲覧用の op を案 A と案 B のどちらにするか (推奨は B)
2. TL の全文の取り寄せのために `read` を残すか、`room_history` で 1 回取って cache する形で代えるか
3. URL の `/s/<sid>/rooms` を消すか、読み取り専用で残すか (`/r/…` は残すのが妥当)
4. CLI の `post rN` / `reply rNmM` を、案内するエラーとして当面残すか (C1 では残すことを推す)。`ccmsg rooms` / `ccmsg read` を CLI に残すか
5. broadcast room (r33、3622 行、大半が member / leave の行) を閲覧の一覧に含めるか
6. 閲覧で 1on1 の折り畳み・archive の折り畳み・kind のバッジを残すか
7. 壊れた末尾行を見つけたとき、今のように切り詰めて書き戻すか、読むときに捨てるだけにするか
