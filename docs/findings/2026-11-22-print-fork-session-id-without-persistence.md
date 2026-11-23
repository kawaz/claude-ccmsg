# 保存しない print の fork (`--no-session-persistence`) に `--session-id` を渡せるか (実測)

- Date: 2026-11-22
- 対象: Claude Code 2.1.330
- 動機: [DR-0064](../decisions/archive/DR-0064-btw-through-launch-command.md) の U4。btw の fork を起動コマンドの print の起動で起こす時、起動の入力の検査 (`launchMakesSession` と `session_id` の有無が一致する) を変えずに `fork_session` の起動に `session_id` を渡せるかは、`claude -p --resume <sid> --fork-session --session-id <新> --no-session-persistence` を claude が受け、stream の `init` の `session_id` が渡した id になるかで決まる。`--fork-session --session-id` の併用は [findings 2026-10-25](./2026-10-25-fork-with-session-id.md) で確かめ済みで、`--no-session-persistence` と合わせた時は測っていなかった
- 方法:
  - 認証のある普段使いの config dir で、リポの外の一時ディレクトリ (`git init` だけした空のディレクトリ) を cwd にして走らせた。計測するセッション自身の環境変数のうち、子の claude を計測するセッションの子として扱わせるもの (`CLAUDE_CODE_CHILD_SESSION` / `CLAUDE_CODE_SESSION_ID` / `CLAUDE_CODE_MESSAGING_SOCKET` / `CLAUDE_CODE_MESSAGING_TOKEN` / `CLAUDE_CODE_ENTRYPOINT` / `CLAUDE_CODE_SESSION_ATTENDED` / `CLAUDE_CODE_EXECPATH`) は `env -u` で落とした
  - fork 元 S は `echo "1 と答えて" | claude -p --model haiku --output-format json` で作った (答えは `1`、transcript は 28 行)
  - fork はどれも `echo "<n> と答えて" | claude -p --resume S --fork-session [--session-id <id>] --no-session-persistence --model haiku --output-format stream-json --verbose`。`<id>` は `uuidgen` の出力を小文字にしたもの
  - 判定は、終了コード、stderr、標準出力の各行の `session_id`、config dir の中の fork の id を名前か中身に持つファイルの有無 (計測するセッション自身の transcript を除く)、S の transcript の大きさ・更新時刻・行数・中の prompt の文

## 判明した事実

### 結果の表

| # | `--session-id` | 終了 | stderr | `init` の `session_id` | `assistant` / `result` の `session_id` | 答え | fork の transcript | S の transcript |
|---|---|---|---|---|---|---|---|---|
| F1 | 新しい uuid N | 0 | 空 | N | N | `2` | 無い | 変わらない |
| F2 | 無し | 0 | 空 | claude が決めた uuid | `init` と同じ | `3` | 無い | 変わらない |
| F3 | F1 と同じ N (2 回目) | 0 | 空 | N | N | `4` | 無い | 変わらない |
| F4 | 元の S | 0 | 空 | S | S | `5` | 無い | 変わらない |

- **`--resume --fork-session --session-id --no-session-persistence` の組は起動を受け、stream の全ての行 (`system` / `init`、`assistant`、`result`) の `session_id` が渡した id になる** (F1)
- **保存しない fork は、渡した id でも claude が決めた id でも transcript を作らない** (F1〜F4)。config dir の `projects/<cwd の slug>/` には S の transcript だけが残り、config dir の中に fork の id を名前や中身に持つファイルは無かった
- **S の transcript は fork で変わらない**: 大きさ・更新時刻・28 行のまま、中の prompt の文は `1 と答えて` だけ (F4 で S を `--session-id` に渡した時も)
- **保存しない時は、使われている id の確かめが無い**: 同じ N を 2 回渡しても (F3)、元の S を渡しても (F4) 起動する。保存する時は、使われている id を `--session-id` に渡すと `Error: Session ID <uuid> is already in use.` で起動しない ([findings 2026-10-25](./2026-10-25-fork-with-session-id.md))
- fork の cache は S のものを読んだ。S の request は `cache_creation_input_tokens` 61,026、F1 は `cache_read_input_tokens` 61,026 / `cache_creation_input_tokens` 333、F2〜F4 は 61,351 / 8 (F1 の書いた cache の読み)。`--session-id` の有無で cache の読み方は変わらなかった

## 実用的な示唆

- DR-0064 の U4 は (a)「渡す」が使える。btw の起動の入力は `fork_session` に `session_id` を持ち、起動の入力の検査 (`launchMakesSession` と `session_id` の有無の一致) は今のままで読める
- daemon は fork の id を前もって知り、stream の `init` の `session_id` と照らせる
- 保存しない fork では claude が id の重なりを断らないので、id を重ねない責任は id を作る側 (daemon の乱数の uuid) にある。重なっても transcript は作られず、元のセッションの transcript も変わらない
