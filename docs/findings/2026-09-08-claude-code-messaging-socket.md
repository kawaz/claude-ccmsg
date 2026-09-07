# Claude Code の cross-session messaging socket (ccmsg の配送経路候補)

- 日付: 2026-09-08
- 対象: Claude Code 2.1.263 (`peerProtocol: 1`) の bundle 静的解析 + `sessions/<pid>.json` の実測
- 目的: ccmsg daemon がセッションへメッセージを届ける経路を、`ccmsg subscribe` の Monitor 経由の
  注入から、Claude Code 本体が cross-session メッセージ (ListAgents / SendMessage) に使う
  セッションごとの UDS への直接配送に置き換えられるかの判定材料
- 方法: codex (gpt-5.6-sol) による bundle の文字列 / 制御フロー解析。**実機送信は未実施**
  (隔離用の使い捨て `claude` 起動が permission で止まった)。本番 socket には接続していない

## 判明した事実

1. **socket**: `net.Server.listen(path)` の Unix domain socket。既定パスは `XDG_RUNTIME_DIR` /
   `CLAUDE_CODE_TMPDIR` 系の `cc-socks/<pid>.sock` (長すぎれば `/tmp/cc-socks-<uid>/<pid>.sock`)。
   実測: `sessions/54509.json` の `messagingSocketPath` は `/tmp/cc-socks/54509.sock`、
   `peerProtocol: 1`、`peerFeatures: [notify_idle, reply_across_default_dirs, artifact_yield]`
2. **framing**: UTF-8 の改行区切り JSON。1 行の上限 1,048,576 文字。最初の完全な行までの
   期限 30 秒
3. **認証必須**: 最初の frame は `{"type":"auth","token":"<32 hex>"}`。token は
   `<config home>/sessions/<pid>.<sha256(socket path)>.key` (mode 0600) の `peerToken`。
   認証前の user / control / 空行 / 不正 JSON は接続 destroy。peer の pid は
   `Bun.ant.getPeerPid(fd)` で検証され、受信 origin に `verifiedPeerPid` が付く
4. **user frame の最低形**: `{"type":"user","message":{"content":"<非空 string>"}}`。任意で
   `session_id` (指定時は受信セッションと完全一致必須)、`uuid`、`msg_id`、`from`、
   `priority` (`now` / `next` / `later`、既定 `next`)、`file_attachments`。
   `skipSlashCommands: true`、`isMeta: true` として prompt queue に入る (queue origin は
   `kind: "peer"`、`from` は frame の値か `unknown`)
5. **busy でも queue に積まれる**。`priority: "now"` は処理中の chain を待たず非同期に処理、
   それ以外は chain 順。= 「次の tool round」で見える設計
6. **流量制御**: token bucket (容量 30、0.5/秒)、同一本文の 30 秒 dedup、hop 上限 10、chain 上限 28、
   queue 上限 256。drop 理由は `rate-limited` / `duplicate` / `hop-loop` / `hop-runaway` / `queue-full`
7. **socket 不在**: connect が ENOENT / ECONNREFUSED。受信側の終了時に socket と key file は unlink
8. **経路の安全検査**: socket path の全祖先 dir の owner / sticky / world-writable / symlink を検査。
   permission-mode の parity gate (held / denied / expired …) があり、正規の SendMessage は
   受信側の mode 差で held になり得る。raw な外部 client がこの gate をどう通るかは未確認
9. **`from` は暗号的な identity ではない**。任意の user frame で表示名を文字列として与えられる。
   正規の peer reply / control 用の `from` は `uds:<socket address>` 形式で、同一 socket namespace・
   owner uid・verified peer pid で検査される

## 実用的な示唆 (ccmsg への適用)

- **技術的には daemon から直接配送できる見込み**: registry (`sessions/<pid>.json`) で socket path を
  読み、対応する key file の `peerToken` で認証し、同じ接続に user frame を書けば queue に入る
- 認証境界は「同一 uid で config home の 0600 key を読めること」。instance = config home の設計
  (DR-0032 §2.3) と一致する。別 uid / 別マシンからは届かない
- **非公式プロトコル**への依存。`peerProtocol === 1` と feature で gate し、失敗時は Monitor 経由に
  フォールバック、1 行 1Mi 文字未満、応答 timeout を持つこと
- `from` は利用者入力にせず ccmsg 固定の origin にする (spoof 防止)
- 正規の reply / idle 通知の意味論 (notify_idle 等) を使うには、送信側も受信 socket と key を公開して
  「verified な live session」相当になる必要があり、単方向注入より重い

## 未確認 (実機で確かめること)

- 外部 client から 1 通送った時の受信側 transcript (jsonl) の形 (`<cross-session-message from=…>` で
  user turn に入るか)
- raw な user frame が permission parity gate を通る条件
- ack / status frame の完全な schema と、正規 SendMessage との返信相関
- 隔離手順 (案): `CLAUDE_CONFIG_DIR=/private/tmp/cc-spike-<x>` の使い捨て `claude` を 2 つ起動し、
  片方の socket へ bun スクリプトから `auth` → `user` を書く。最小 wire:
  `{"type":"auth","token":"<peerToken>"}` / `{"type":"user","from":"ccmsg","message":{"content":"…"},
  "priority":"now","session_id":"<sid>","msg_id":"<uuid>"}`

## 検証の詳細

bundle 内の該当箇所 (byte offset、`~/.local/share/claude/versions/2.1.263`): socket path 決定
~128,023,000、framing ~128,021,000、上限定義 ~110,613,338、auth token 生成 ~109,759,240、
key file / peer 検査 ~109,763,031、user frame 受付 ~128,013,000〜128,015,500、流量制御
~110,613,338 以降、peer pid 検証 ~110,613,000 / ~128,011,000。
