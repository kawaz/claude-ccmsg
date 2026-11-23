# 公式ドキュメント「Message your other Claude Code sessions」の内容と、既存の findings との差分

- 日付: 2026-11-23
- 対象: <https://code.claude.com/docs/en/cross-session-messaging> (2026-11-23 取得)、Claude Code 2.1.330
- 関連: `2026-08-27-native-cross-session-messaging-vs-ccmsg.md` (実機の比較)、`2026-09-08-claude-code-messaging-socket.md` (bundle の静的解析)

## 判明した事実

実機で確かめたもの (2.1.330、personal 面のセッション 1 つ):

- ListAgents は同じマシンの peer を 17 件返した
- Bash に `CLAUDE_CODE_MESSAGING_SOCKET=/tmp/cc-socks/<pid>.sock` と `CLAUDE_CODE_MESSAGING_TOKEN` が export されている
- user settings に `crossSessionInbound: "accept"` が入っている

ドキュメントの記述 (実機では未確認):

- 受信ソケットは「script や hook がセッションへ投稿する口」として文書化された。パスは `/status` の `Peer address` 行と `CLAUDE_CODE_MESSAGING_SOCKET`、token は `CLAUDE_CODE_MESSAGING_TOKEN`
- 接続の 1 行目の `{"type":"auth","token":"<token>"}` は macOS / Linux では任意、native Windows では必須。完全な 1 行を 30 秒以内に送らない接続は閉じられる
- 自分の子プロセス (hook、Bash) からの投稿は `crossSessionInbound` が未設定でも届く。macOS は投稿したプロセスが生きている間だけプロセスの証拠で確かめ、終了後は auth 行の token で確かめる。どちらも無ければ permission class を名乗らない普通の投稿として扱い、bypass のセッションでは承認待ちになる
- 受信の制御は `crossSessionInbound` (`accept` / `hold` / `refuse`)。未設定時は両セッションの permission mode の組で決まる (bypass の組とそれ以外の組。auto / acceptEdits / dontAsk は「それ以外」)。hold の保持は 100 通まで、承認ダイアログの期限は `dialogExpiry` (既定 5 分)
- 届いたメッセージは承認の代わりにならず、設定を変えさせず、`/compact` 等のコマンドは実行されない
- 別マシンとクラウドのセッションへは Remote Control 接続時に Anthropic のサーバ経由で届く (2.1.225 以降)。`isolatePeerMachines: true` でマシン外への送信に承認を要求できる。コンテナとホスト、WSL 2 と native Windows の間は届かない
- `notify_when_idle` は 2.1.236 以降、main の会話から同じマシンのセッションにだけ使え、12 時間で失効する
- `@<セッション名>` の mention で宛先を指定できる (2.1.232 以降)
- `claude -p` もソケットを bind する。bare mode は bind しない
- 上限: 同一マシンは直列化後で約 100 万文字、受信側は送り主ごとの rate limit、短時間の同文の drop、Claude が読む待ち行列は 50 通

## 既存の findings との食い違い

| 項目 | 既存の findings | ドキュメント | 状態 |
|---|---|---|---|
| auth 行 | 必須 (2.1.263 の静的解析) | macOS / Linux は任意 | 実機未確認 |
| 受け付けた待ち行列の上限 | 256 (同上) | 50 | 実機未確認 |
| token の入手 | `sessions/<pid>.<hash>.key` の `peerToken` | 環境変数 `CLAUDE_CODE_MESSAGING_TOKEN` | 環境変数は実機で確認。key ファイルとの同一性は未確認 |
| `CLAUDE_CONFIG_DIR` をまたぐ到達 | 不可 (2026-08-27 実測) | 記述なし | 再確認していない |

## 文書化されていないもの

- メッセージ本体の frame の形 (`{"type":"user","message":{…}}`、`priority`、`from` 等)。ページにあるのは auth 行と 30 秒の期限だけで、本体の形は静的解析の知見のまま
- 送達確認 (ack) の形
