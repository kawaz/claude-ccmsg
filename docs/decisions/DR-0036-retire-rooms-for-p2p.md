# DR-0036: room を廃止し、セッション間メッセージを p2p (sid 宛の直送) にする

- Status: Proposed (2026-10-06、廃止の方針は kawaz 決定済み、細部が裁定待ち)
- Date: 2026-10-06

## Context

v1 の daemon は room を中心に組まれている。会話の単位が room で、room jsonl が唯一の永続状態であり ([DR-0001](./DR-0001-central-daemon-architecture.md) §3-§6、[DR-0003](./DR-0003-wire-protocol.md))、宛先は room member と `to` の配信フィルタで決まる ([DR-0011](./DR-0011-to-delivery-filter.md))。broadcast room ([DR-0013](./DR-0013-broadcast-room.md))、archive / kick ([DR-0012](./DR-0012-room-archive-and-kick.md))、per-room の `seq` ([DR-0016](./DR-0016-storage-event-seq.md))、room log から宛先を組み立てる `ccmsg reply rNmM` ([DR-0017](./DR-0017-reply-command.md)) も room の上にある。セッションへの配送は [DR-0034](./DR-0034-peer-socket-injection.md) の peer 注入で、room member ごとに封筒を書いている。

kawaz 2026-10-06: 「room は廃止する予定。1on1 同様に。複数セッションで見える部屋というアイデアは面白かったが、実際に使ったのは初期に 3、4 回程度で、エージェント間メッセージは基本 p2p で良いという結論になった。room を作った理由は、複数セッションが絡む会話を僕が個別セッションに対して行うと、セッション同士が僕との直接会話を他セッションに無駄にリレーすることが多々あったからだが、それはセッション間メッセージを行う際の注意点として ccmsg で規約を作ったことで起きなくなった」。

人 (webui) からセッションへの入力は [DR-0035](./DR-0035-user-input-via-composer-fill.md) で composer への fill + Enter に移り、1on1 room はそこで廃止される。本 DR は残りの room (通常 room / broadcast room) と、room に載っていたセッション間メッセージを扱う。

v2 (kawaz/ccmsg と契約 kawaz/ccmsg-protocol) は room を持たず、sid 宛の直送で設計されている: 宛先の綴りは `ccmsg:<sid>`、mid は `<instance id>/<連番>` で `reply_to` が指すためだけの識別子、返信行は `Reply with: ccmsg reply <mid> --to <sid> <text>`、本文の `from` / `from-name` は `ccmsg:<送り主>` (契約 DR-0006 / DR-0008 / DR-0033)。v1 の webui と dump は、この v2 の直送封筒を既に描画・抽出できる (`packages/protocol/src/ccmsg-direct-transcript.ts`、DR-0027 §6)。

## Decision

### 1. セッション間メッセージは sid 宛の直送にする

- daemon に sid 宛の送信 op を足す。宛先は 1 セッションで、daemon は room を経ずに `PeerInjector.send` で封筒を書く (DR-0034 §2 の手順・期限値はそのまま)
- 封筒・宛先の綴り・mid・返信行は v2 の契約の形に揃える。v1 の webui と dump が既に読める形であり、v2 へ戻る時に agent が覚える形が変わらない。ただし返信行の launcher は v1 の `bin/ccmsg` の絶対パスのまま (`resolveLauncher`)。PATH 上の `ccmsg` は v2 を指しうるため
- 返信は封筒の `--to` で宛先を明示する。daemon は「mid から送り主を引く」ための送信 index を持たない (v2 契約 DR-0008 と同じ)
- 送信の結果 (届いた / 届かなかった理由) は送り主の CLI に返す。DR-0034 の「log に残すだけ」から変える

### 2. room と room に載っていた機能を削る

- 通常 room、broadcast room、room 系 op (`create_room` / `next_room` / `read` / `room_history` / `rooms` / `leave` / `invite` / `kick` / `archive_room` / `set_title`)、`to` の配信フィルタ、room id の mid、per-room `seq`、room storage を削る
- 順序は「直送の送り口を足す → 利用側 (CLI・webui の TL・dump・say) を移す → room を削る」。送り口より先に room を削ると、動いているセッション同士のやり取りが途切れる
- subscribe の stream は room の配送を持たなくなり、notify / net_online / keepalive だけになる

## Alternatives Considered

- 案 A: room を残し、1on1 だけ廃止する
  - 不採用理由: 使われていない仕組みの維持費 (daemon・webui・CLI の room 系と 55 本のテスト) を払い続けることになる。room の動機だったリレー問題は規約で解消済み
- 案 B: v1 で独自の直送の形 (v1 の op 名・mid 体系) を作る
  - 不採用理由: v1 の webui は v2 の直送封筒を既に読め、v2 へ戻る時に agent が覚える形を変えずに済む。独自形にする利点が無い

## Consequences

- 触る範囲は広い: protocol の room 系の型と op、daemon の `storage.ts` 全体と `server.ts` の room 系、CLI の room 系サブコマンド、webui の room 画面群と URL (`/r/<id>`、`docs/design/webui-url-grammar.md`)、room に言及するテスト 55 本、README
- `packages/protocol/src/ccmsg-direct-transcript.ts` の `classifyCcmsgSendResult` は、v1 CLI の `{"ok":…}` 応答を「room CLI の応答」として TL と dump から捨てている。直送の送り口の応答が同じ形だと消えるので、応答の形か判定を変える
- DR-0001 §3-§6、DR-0003 §2 / §4-§6、DR-0011、DR-0012、DR-0013、DR-0016、DR-0017 の room log 前提の部分、DR-0027 §1-§4 は本 DR が Accepted になった時点で置き換わる。DR-0034 は宛先が room member から sid 1 つになる
- v1 の plugin は SKILL を持たず、SessionStart hook も何も出力しない。agent が直送の使い方を知る手段は封筒の返信行と CLI の help になる。相手の探し方 (`ccmsg peers`) をどこで案内するかは実装時に決める

## 関連

- [DR-0035](./DR-0035-user-input-via-composer-fill.md) — 人の入力の composer 化と 1on1 の廃止 (本 DR の前段)
- [DR-0034](./DR-0034-peer-socket-injection.md) — peer 注入 (直送の手段としてそのまま使う)
- [DR-0027](./DR-0027-tl-ccmsg-canonical-lookup.md) §6 — 直送封筒の TL 表示と dump
- kawaz/ccmsg-protocol の DR-0006 / DR-0007 / DR-0008 / DR-0033、kawaz/ccmsg の DR-0008 — v2 の直送・inbox・返信行の設計
