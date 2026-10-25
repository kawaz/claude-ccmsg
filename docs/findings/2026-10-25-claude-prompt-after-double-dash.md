# claude の `--` の後ろに置いた prompt は option として読まれないか

- Date: 2026-10-25
- 対象: Claude Code 2.1.309
- 動機: 起動コマンドの例 ([runbook session-launcher-setup](../runbooks/session-launcher-setup.md)) と契約 ([launch-command](../design/launch-command.md)) は、起動の入力の `prompt` を `claude … -- "<prompt>"` の形で渡す。`-` で始まる prompt (`--version`、`-p hi`) が claude の option として読まれず、本文のまま最初の prompt になるかを確かめる
- 方法: 一時ディレクトリに `CLAUDE_CONFIG_DIR` / `HOME` / `TMPDIR` / cwd を置き、`env -i` で `PATH` / `TERM` / `DISABLE_AUTOUPDATER` 以外の環境変数を落として `claude -p --output-format json <args> </dev/null` を起動した。認証情報は無いので、model の応答が要る prompt は API を呼ばずに終わる (`duration_api_ms: 0`)。判定は stdout の `session_id` と、config dir の `projects/<cwd の slug>/<session_id>.jsonl` の user 行の `message.content`

## 判明した事実

- **`--` の後ろの引数は、`-` で始まっても option として読まれず、prompt になる**。`-- --version` は user 行 `"--version"` のセッションになり、version を出して終わらない (`--` の無い `--version` は `2.1.309 (Claude Code)` を出して終わる)
- **`--` の後ろの 1 つの引数が、空白や改行を含めてそのまま prompt になる**。`-- "-p hi"` は `"-p hi"`、末尾に改行のある複数行の引数は `"line1\nline2\n"` (末尾の改行も残る)
- **`--` の後ろに引数を 2 つ以上並べると、prompt になるのは最初の 1 つだけ**。`-- --name x` は user 行 `"--name"` で、`x` は prompt に入らない。prompt は 1 つの引数にまとめて渡す

| 引数 (`-p --output-format json` の後) | 結果 |
|---|---|
| `-- --version` | セッションができ、user 行は `"--version"` |
| `-- "-p hi"` | user 行は `"-p hi"` |
| `-- --name x` | user 行は `"--name"` |
| `--version` (`--` なし) | `2.1.309 (Claude Code)` を出して終わる (セッションは無い) |
| `-- "line1<改行>line2<改行>"` | user 行は `"line1\nline2\n"` |

## 実用的な示唆

- 起動コマンドは `prompt` を `--` の後ろに 1 つの引数で置く。`-` で始まる prompt も本文のまま届く
- 末尾の改行は claude まで残るので、起動コマンドが prompt を shell の変数に取り出す時に `$(…)` で末尾の改行を落とさない (runbook の例は `printf x` を足して取り出す)

## 未観測

- 対話の起動 (`-p` なし) での `--` の扱い。runbook の例は対話の claude に同じ形で渡す
