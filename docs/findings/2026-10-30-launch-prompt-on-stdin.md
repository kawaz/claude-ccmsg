# 起動の prompt を claude の stdin で渡す

- Date: 2026-10-30
- 対象: Claude Code 2.1.314、hyoui 0.16.4、bun 1.4.2
- 動機: 起動コマンドの契約 ([launch-command](../design/launch-command.md)) で `prompt` を claude の位置引数でなく stdin に書くことにした (位置引数は `ps` に見え、長さの上限に当たり、option として読まれうる)。`hyoui run --detached` を通した対話の claude が stdin の中身を最初の prompt として受け取るか、組み込みの起動コマンドがどう stdin を渡せば欠けないかを確かめる
- 方法: cwd は trust 済みのリポの作業コピー、`CLAUDE_CONFIG_DIR` は実 config dir、model は haiku。起動したセッションは `--name 🤖ccmsg-verify-launch` で、確かめた後に `/exit` した。判定は `ps` の引数、`lsof` の fd 0、hyoui の画面、transcript の user 行の `message.content`

## 判明した事実

- **`hyoui run` は端末でない stdin の fd をそのまま claude の stdin にする**。`--help` の STDIN の節のとおりで、起動した claude の fd 0 は起動コマンドが開いた一時ファイル (`REG`) だった
- **対話の claude (`-p` なし) は端末でない stdin を読み切り、その中身を最初の prompt として送信する**。キーは PTY から読むので、その後も端末から操作できる
- **stdin の中身は本文のまま 1 つの prompt になる**。`--version` で始まり、途中と末尾に改行のある prompt が、user 行 `"--version Reply with only the word PONGSTDIN2.\nDo not use any tools.\n"` になった (option として読まれず、末尾の改行も残る)
- **stdin が `/dev/null` なら prompt 無しで起動し、入力を待つ**
- **pipe で渡した stdin は、渡した側と端末 proxy が先に終わると欠ける**。bun の `Bun.spawn` に `stdin: new Blob([…])` を渡し、子 (`sh`) は stdin を背景のプロセスに継いですぐ終わり、親も子の終わりを待ってすぐ `process.exit` した。背景のプロセスが 1 秒後に読むと、下の表のとおり大きい prompt は欠けた
- 組み込みの起動コマンド (一時ファイルに書いて読み取りで開き、ファイルを消してから fd を hyoui に渡す) を隔離 daemon から起動すると、`ps` の hyoui と claude の引数に prompt は無く、prompt は上のとおり届き、`$TMPDIR` に一時ファイルは残らなかった

| 渡し方 | 書いた bytes | 背景のプロセスが読んだ bytes |
|---|---|---|
| pipe (Blob) | 100 | 100 |
| pipe (Blob) | 60000 | 60000 |
| pipe (Blob) | 200000 | 200000 |
| pipe (Blob) | 5000000 | 524288 |
| 一時ファイルの fd (組み込みのテスト) | 1048581 | 1048581 |

| 起動 | `ps` の claude の引数 | 最初の prompt |
|---|---|---|
| 組み込み、`prompt` あり | `claude --session-id <id> --model haiku --effort low --name 🤖ccmsg-verify-launch` | stdin の本文のまま |
| 組み込み、`prompt` なし | `claude --session-id <id> --model haiku --effort low --name 🤖ccmsg-verify-launch-noprompt` | 無し (入力待ち) |
| `hyoui run --detached -- claude … < file` を手で | prompt 無し | file の本文のまま |

## 実用的な示唆

- 起動コマンドは `prompt` を claude の stdin に書き、位置引数にしない。端末 proxy は stdin を claude にそのまま継ぐものを使う
- detach する端末 proxy に pipe で渡すと、起動コマンドが終わった後に claude が読む分が欠けうる。一時ファイルに書いて開いた fd を渡す (開いた後にファイルを消してよい)。zsh の here-string (`<<<`) も一時ファイルになるが、末尾に改行を 1 つ足す

## 未観測

- fork 地点のある fork の二段目 (`claude --resume <新しい id>`) に stdin で渡した prompt。組み込みは同じ渡し方をする (単体テストは mock の hyoui で stdin を確かめた)
- `continue` / `resume` の対話の起動に stdin で渡した prompt
