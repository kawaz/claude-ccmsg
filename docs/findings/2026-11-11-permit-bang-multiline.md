# 「! で実行」に複数行のコマンドを送った時の振る舞いを実機で確かめた

- Date: 2026-11-11
- 対象: Claude Code 2.1.322、hyoui 0.16.4、ccmsg の作業コピー (daemon は 0.241.0 を名乗った)、`$SHELL` は `/bin/zsh`
- 動機: permit バブルの「! で実行」は今 `command` が 1 行の時だけ出る (DR-0040 §11)。複数行にも出すかを決める材料として、(A) 今の module の経路に複数行をそのまま送ると何が起きるか、(B) hyoui の web から `!` に続く複数行を送ると「スクリプトとしては実行できない」と見えた件、(C) 複数行を一時ファイルに書いて 1 行のコマンドで走らせる案 (`t={tmpfile}; cat "$t"; echo; echo; "$SHELL" < "$t"; rm -f "$t"`) を見る
- 方法:
  - 一時ディレクトリの中に config home (`CLAUDE_CONFIG_DIR`、`.claude.json` に onboarding 済み・ダミー鍵の承認・作業ディレクトリの trust)、空の git の作業ディレクトリ、`HOME`、`XDG_*_HOME`、`TMPDIR`、`HYOUI_STATE_DIR`、ccmsg の state / config / data を置いた。`HOME` の `.zshrc` には観測用に alias (`vbm_alias`)・関数 (`vbm_func`)・`setopt EXTENDED_GLOB`・`export VBM_RC_VAR=…` を書いた
  - 隔離 daemon: 作業コピーの `packages/daemon/src/index.ts --foreground`、`CCMSG_HTTP_BIND=127.0.0.1:18652`、`CCMSG_CLAUDE_CONFIG_DIRS` は試験用の config home だけ
  - 試験用セッション: `env -i` から `hyoui run --detached --size 100x60` の中に `claude --plugin-dir <作業コピー> --debug --model haiku --name "🤖ccmsg-verify-bang-multiline"`。`ANTHROPIC_BASE_URL` は閉じたポート (`http://127.0.0.1:9`)。起動の環境に `VBM_LAUNCH_VAR=from-launch-env` を足した
  - A と C は、daemon の socket に user role で hello し、`user_prompt` (`mode: "bash"`、`text` はケースのファイルの中身をそのまま) を送った。別の接続で user role の `subscribe` を張り、`ev:"bash_command_ended"` を記録した
  - 各ケースの後、bash mode の出力の行が書かれると model への request が始まり (`ECONNREFUSED` の再試行)、turn の実行中になる。transcript に `<bash-stdout>` の行が来たのを待って画面を取り、`Escape` で止めて足元の案内から `esc to interrupt` が消えるのを `wait:` で待ってから次を送った
  - B は `hyoui input <id> …` で、hyoui の web の入力欄 (`session.js` の `submitFromTextarea`) が作るのと同じ spec の並びを送った

## A. module の経路で複数行をそのまま送る

どのケースも `user_prompt` の返事は `accepted` (所要 233〜266 ms)、daemon.log は `session-input -> <sid> (bash): accepted`。

| ケース | 送った文字列の要点 | 実際に走ったもの | `<bash-input>` の中身 | `bash_command_ended` |
|---|---|---|---|---|
| 1 | `echo A1-line1` / `echo A1-line2` の 2 行 | 2 行とも。出力 `A1-line1\nA1-line2` | 送った文字列と同じ | 届いた。`command` は送った文字列と同じ |
| 2 | 行末 `\` の継続行 3 行 | 1 つのコマンドとして。出力 `A2-start A2-part2 A2-part3` | 同じ | 同じ |
| 3 | 行末 `&&` で整形した 3 行 | 3 つとも。出力 `A3-a\nA3-b\nA3-c` | 同じ | 同じ |
| 4 | `cat <<'EOF'` 〜 `EOF` の後に `echo A4-after` | ヒアドキュメントが展開されずに出た (`A4 $HOME literal`)。後ろの行も走った | 同じ | 同じ |
| 5 | `if … fi` と `for … done` の複数行ブロック | 両方。出力 `A5-if-true\nA5-for-1\nA5-for-2\nA5-for-3` | 同じ | 同じ |
| 6 | コメントの行、空行、行末コメント | コメントは飛ばされ `A6-a\nA6-b` | 同じ (空行・コメントも残る) | 同じ |
| 7 | 2 行目が `false`、4 行目が `ls /nonexistent-A7` | 全行が走った (`false` の次の行も、`ls` の失敗の次の行も)。`ls` のエラー文も出力に入った | 同じ | 同じ |
| 8 | 1 行目と 6 行目で `$$`、2 行目で代入し 3 行目で参照、4 行目 `cd /tmp`、5 行目 `pwd` | 1 つのシェルで走った: `pid1` と `pid2` が同じ値、`x=A8-var`、`pwd` は `/tmp`。`<bash-stderr>` に `Shell cwd was reset to <作業ディレクトリ>` | 同じ | 同じ |
| 9 | `read line; echo "A9 got:[$line]"` の次に 2 行 | `got:[]` (何も読まない)。次の行は食われずに走った | 同じ | 同じ |
| 10 | 31 行、2713 バイト | 31 行とも。画面にも全行出た (貼り付けの折り畳み表示にならない) | 同じ | 同じ |
| 11 | 先頭に空行 2 つ、タブと空白 4 つのインデント、末尾に空行 3 つ | 2 行とも | 先頭の空行とインデントは残り、末尾の改行は落ちた (`\n\n\techo A11-tab\n    echo A11-spaces`) | `command` は `<bash-input>` と同じ。送った文字列の `trimEnd()` と一致 |
| 12 | `'` と `"` の入れ子、`$'A12\ttab-ansi-c'`、日本語、`'…!…'`、`"…!x"` | 全行がそのまま。`$'…'` はタブに展開、`!` は履歴展開されない | 同じ | 同じ |

1 つのケースで結論しないように、次も足した。

| ケース | 送った文字列の要点 | 結果 |
|---|---|---|
| 13 | 改行が CRLF (`echo A13-crlf-a\r\necho A13-crlf-b\r\n`) | 2 行とも走ったが、`<bash-input>` と `command` は `echo A13-crlf-a\necho A13-crlf-b` (`\r` が落ちた)。送った文字列の `trimEnd()` とは一致しない |
| 20 | 改行が単独の CR (`echo lonecr-1\recho lonecr-2`)。別の試験用セッション (Messages API の代役が固定の文を返す) で 1 回 | 2 行とも走り、`<bash-input>` は `echo lonecr-1\necho lonecr-2` (CR が LF になった) |
| 14 | turn の実行中に 3 行を送った | 画面では 3 行が待ちの列に並び、`ctrl+x ctrl+s to send now` の案内。transcript は `queue-operation` (`enqueue`、`content` は 3 行のまま)。`Escape` で turn を止めると `dequeue` の後に `<bash-input>` (3 行) と出力の行が入り、`command` も 3 行のまま届いた |
| 18 | 201 行、15613 バイト | 全行が走り、`<bash-input>` と `command` は送った文字列と同じ |
| 19 | composer に書きかけ `draft 下書き` を置いて 2 行を送った | 2 行とも走り、composer は `❯ draft 下書き` (通常の入力) に戻った |
| 8c → 8d | 複数行で `mkdir` / `cd sub-A8c` / `export A8C_EXPORTED=yes` → 次の 1 行で `pwd` と `$A8C_EXPORTED` | `pwd` は `…/ws/sub-A8c` (cwd は次のコマンドに持ち越した)。`A8C_EXPORTED` は空 (変数は持ち越さない) |
| 8e → 8f | 複数行で `cd ..` / `pwd` / `false` → 次の 1 行で `pwd` | 次の `pwd` は `…/ws/sub-A8c` のまま (最後が失敗したコマンドの `cd` は持ち越さない)。1 行の `cd ..; pwd` (成功) の後は `…/ws` に変わった |

### bash mode のコマンドの走り方

bash mode で `ps -o pid=,ppid=,args= -p $$` を走らせると、シェルの引数は次の形だった (パスは伏せた、`\012` は ps の表記で改行):

```text
/bin/zsh -c source <config home>/shell-snapshots/snapshot-zsh-….sh 2>/dev/null || true && setopt NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL 2>/dev/null || true && { \builtin unalias -- 'which'; … } … && eval 'echo "0=$0 SHELL=$SHELL"\012ps -o …\012…\012pwd' < /dev/null && pwd -P >| /tmp/claude-….-cwd
```

- コマンドの文字列全体が 1 つの `$SHELL -c` の中の `eval '…'` に入る。複数行が 1 つのシェルで走ること (ケース 8 の `$$` と変数)、行ごとの失敗で止まらないこと (ケース 7) はこの形と合う
- stdin は `/dev/null`。ケース 9 の `read` が何も読まなかったことと合う
- `eval` の後の `&& pwd -P >| …` で cwd を書き出す。コマンドの終了コードが 0 でない時は書かれないので、ケース 8e の `cd` が持ち越さなかったことと合う
- 親の pid は claude の pid

### 出力のタグ (`<bash-stdout>` / `<bash-stderr>`)

複数行に限らない観測として記録する。2.1.322 では、出力が stdout と stderr のどちらに書かれたかでなく、コマンドの終了コードでタグが分かれた:

| コマンド | 終了コード | 行の `message.content` |
|---|---|---|
| `echo A15-out; echo A15-err >&2` | 0 | `<bash-stdout>A15-out\nA15-err</bash-stdout><bash-stderr></bash-stderr>` |
| ケース 7 (最後が `echo`、途中の `ls` が stderr に書く) | 0 | `ls` のエラー文も `<bash-stdout>` |
| `echo A16-out; false` | 1 | `<bash-stdout></bash-stdout><bash-stderr>A16-out\n</bash-stderr>` |
| `echo A17-ml-out` / `echo A17-ml-err >&2` / `false` の 3 行 | 1 | `<bash-stdout></bash-stdout><bash-stderr>A17-ml-out\nA17-ml-err\n</bash-stderr>` |
| `echo …; pwd; echo …; ls /nonexistent-A8b` (1 行) | 非 0 | 全部が `<bash-stderr>` |

出力が空のコマンドでは区別がつかないこと (2026-11-06 の findings の `false` / `exit 3`) は変わらない。2.1.319 で同じ分かれ方だったかは確かめていない。

## B. hyoui の入力で `!` に続く複数行を一度に送る

hyoui の web の入力欄は、中身を `\n` で行に分け、「Enter/行」(既定で on) なら各行を `text:<行>` と `key:Enter` の組で送る。off なら行の間に `hex:0a` を挟み、最後に Enter を送らない。

### B1: 既定 (各行の後に Enter)

`hyoui input <id> 'text:!echo B1-line1' key:Enter 'text:echo B1-line2' key:Enter 'text:echo B1-line3' key:Enter` を送った。

transcript の行 (順に):

```text
{"type":"queue-operation","operation":"enqueue"}
{"type":"queue-operation","operation":"enqueue"}
{"type":"user","message":{"content":"<bash-input>echo B1-line1</bash-input>"}}
{"type":"user","message":{"content":"<bash-stdout>B1-line1</bash-stdout><bash-stderr></bash-stderr>"}}
{"type":"queue-operation","operation":"dequeue"}
{"type":"user","message":{"content":[{"type":"text","text":"[Request interrupted by user]"}]}}
{"type":"user","message":{"content":"echo B1-line2"},"origin":{"kind":"human"},"promptSource":"queued"}
{"type":"queue-operation","operation":"dequeue"}
{"type":"user","message":{"content":[{"type":"text","text":"[Request interrupted by user]"}]}}
{"type":"user","message":{"content":"echo B1-line3"},"origin":{"kind":"human"},"promptSource":"queued"}
```

- 1 行目だけが bash mode で走った。2 行目と 3 行目は、1 行目の Enter で bash mode を抜けた後の通常の入力として 1 行ずつ Enter され、待ちの列 (画面では `❯ echo B1-line2` / `❯ echo B1-line3`) に入り、turn を止めるたびに通常の prompt (`promptSource: "queued"`) として model に送られた
- 改行の打鍵が行ごとの Enter になったのではなく、web の入力欄が行ごとに `key:Enter` を送っている (上の spec の並びがそれ)

### B2: 「Enter/行」off (行の間に `hex:0a`、最後に Enter を 1 回)

`'text:!echo B2r1-line1' hex:0a 'text:echo B2r1-line2' hex:0a 'text:echo B2r1-line3'` を 1 回の `hyoui input` で送り、composer を見てから `key:Enter` を送った。

- 続けて 3 回送り、3 回とも composer が `! !echo B2r1-line1` / `echo B2r1-line2` / `echo B2r1-line3` (shell mode に入った上に、`!` が文字としても残った) になり、`<bash-input>!echo B2r1-line1\necho B2r1-line2\necho B2r1-line3</bash-input>`、出力 `(eval):1: command not found: !echo\nB2r1-line2\nB2r1-line3`。その前に同じ形 (2 行・3 行) で送った 3 回では、2 回が同じ形、1 回は `!` が残らなかった (composer の後片付けが不完全だった 1 回は数えていない)。合わせて 6 回中 5 回
- 同じ spec を `hyoui input` の呼び出しを分けて 1 つずつ送り、間に画面を見た時は `!` が残らず、`<bash-input>echo Bt-1\necho Bt-1-b</bash-input>` で 2 行とも走った
- 1 行を `text:!echo …` と `key:Enter` で送った 6 回は、どれも `<bash-input>echo Bs-N</bash-input>` (`!` は残らない)
- `!` が文字として残る条件は特定していない (spec を続けて送った時の時機に依るように見えるが、裏付けは上の観測だけ)

### B3〜B5: 1 つのコマンドとして入った送り方

| 送った spec | composer | `<bash-input>` |
|---|---|---|
| `text:` 1 つに改行ごと (`!echo B3-a` LF `echo B3-b`) → `key:Enter` | `! echo B3-a` / `echo B3-b` | `echo B3-a\necho B3-b` (2 行とも走った) |
| `text:!` → `wait:─\n!\x{a0}` → `paste:` (bracketed paste) に `echo B4-a` LF `echo B4-b` → `key:Enter` | `! echo B4-a` / `echo B4-b` | `echo B4-a\necho B4-b` |
| `paste:` に `!echo B5-a` LF `echo B5-b` (`!` も貼り付けの中) → `key:Enter` | `! echo B5-a` / `echo B5-b` (貼り付けの先頭の `!` で shell mode に入った) | `echo B5-a\necho B5-b` |

## C. 一時ファイルに書いて 1 行で走らせる案

スクリプトのファイルを一時ディレクトリに置き、A と同じ経路で `t=<file>; cat "$t"; echo; echo; "$SHELL" < "$t"; rm -f "$t"` を送った。

### C1: 期待どおり走るか

スクリプト (7 行: `echo`、変数の代入と参照、ヒアドキュメント、`echo C1-end`) は全部走り、ファイルは消えた。

- `<bash-input>` は 1 行のコマンドそのもの (`t=<file>; cat "$t"; echo; echo; "$SHELL" < "$t"; rm -f "$t"`)。スクリプトの中身は `<bash-input>` に入らない
- `<bash-stdout>` は `cat` の出力 (スクリプトの中身、`<` は `&lt;` に escape される) → 空行 2 つ → 実行の出力: `echo C1-line1\nX=C1-var\n…\necho C1-end\n\n\nC1-line1\nC1 x=C1-var\nC1 heredoc body\nC1-end`
- 画面も同じ並び (コマンドの行は画面の幅で 2 行に折り返し、その下にスクリプト、空行 2 つ、出力)
- `bash_command_ended` の `command` は 1 行のコマンドと同じ
- コマンドの最後が `rm -f` なので、スクリプトが失敗しても終了コードは 0 になる (上の「出力のタグ」の分かれ方はこの形では常に `<bash-stdout>`)。同じコマンドをもう一度送ると、ファイルが無いので `cat: <file>: No such file or directory` と `(eval):1: no such file or directory: <file>` が出た (webui の「実行済み」を押して戻し、もう一度押した時がこれに当たる)

### C2: stdin を読むコマンド

スクリプト `read line; echo "C2 got:[$line]"` / `echo C2-next-line` / `echo C2-end`:

| 起動の形 | 出力 (実行の部分) |
|---|---|
| `"$SHELL" < "$t"` | `C2 got:[echo C2-next-line]` / `C2-end`。`read` がスクリプトの次の行を読み、その行は走らなかった |
| `"$SHELL" "$t"` | `C2 got:[]` / `C2-next-line` / `C2-end`。stdin は bash mode の `/dev/null` を受け継ぐ |
| bash mode で直接 (A のケース 9) | `got:[]`、次の行も走った |

### C3: シェルと環境の違い

同じ確かめのスクリプト (`$0`、`ps` での引数、`type vbm_alias vbm_func`、`[[ -o extendedglob / interactive / login ]]`、`$VBM_RC_VAR` / `$VBM_LAUNCH_VAR`、`pwd`) を 3 通りで走らせた。

| 項目 | bash mode で直接 | `"$SHELL" < "$t"` | `"$SHELL" "$t"` |
|---|---|---|---|
| `$0` / `$SHELL` | `/bin/zsh` / `/bin/zsh` | `/bin/zsh` / `/bin/zsh` | `<file>` / `/bin/zsh` |
| 引数 (`ps`) | `/bin/zsh -c source <snapshot> … && eval '…' < /dev/null && pwd -P >| …` | `/bin/zsh` | `/bin/zsh <file>` |
| `.zshrc` の alias・関数 | ある (`vbm_func is a shell function from <snapshot>`)。snapshot から | 無い (`vbm_alias not found`、`command not found`) | 無い |
| `extendedglob` | off (`.zshrc` は on。snapshot は `setopt extendedglob` を持つが、その後で `setopt NO_EXTENDED_GLOB`) | off | off |
| interactive / login | non-interactive / login (snapshot に `setopt login`) | non-interactive / non-login | non-interactive / non-login |
| `.zshrc` の `export` (`VBM_RC_VAR`) | 空 (snapshot は `PATH` だけを `export` する) | 空 | 空 |
| 起動の環境の変数 (`VBM_LAUNCH_VAR`) | ある | ある | ある |
| cwd | セッションの cwd (前のコマンドからの持ち越しを含む) | 同じ | 同じ |

snapshot (`<config home>/shell-snapshots/snapshot-zsh-….sh`) の中身は、関数、`setopt` の並び、alias、`rg` / `find` / `grep` / `pkill` の差し替え、`export PATH=…`。

### C4: 書いてから走るまでに中身を書き換える

1. 1 行のコマンドを bash mode で走らせ、その後の turn の実行中にした
2. スクリプトのファイルに `echo C4-content-as-approved` を書いた
3. `t=<file>; cat "$t"; echo; echo; "$SHELL" < "$t"; rm -f "$t"` を送った (`accepted`、transcript に `queue-operation` の `enqueue`)
4. ファイルを `echo C4-content-REPLACED` に書き換えた
5. `Escape` で turn を止めた

走ったのは書き換えた方だった: `<bash-stdout>echo C4-content-REPLACED\n\n\nC4-content-REPLACED</bash-stdout>`。`<bash-input>` と `enqueue` の `content` は 1 行のコマンドだけで、送った時のスクリプトの中身はどこにも残っていない。

- 待ちの列に入らない時 (idle) も、ファイルを書いてから Enter の後にシェルが読むまでの間は同じように書き換えられる。その間の長さは測っていない
- `cat "$t"` と `"$SHELL" < "$t"` はファイルを別々に読むので、見せた中身と走った中身がずれることもありうる。これは実際には起こしていない (未検証)

## 結論の材料

- 1 行の制限を外すだけで、module の経路 (`$.prompt.fill` の append) は複数行を 1 つのコマンドとして走らせた。上の 12 ケースと追加のケース 14・18・19・8c〜8f (継続行、`&&`、ヒアドキュメント、ブロック、コメント・空行、失敗する行、変数と cwd、stdin、201 行・15 KB、前後の空行とインデント、引用符・`$'…'`・日本語・`!`、待ちの列、書きかけ) で、`<bash-input>` は送った文字列 (末尾の空白・改行を除く) と同じで、`bash_command_ended` も届き、webui の一致の条件 (`asked.trimEnd() === ended`) を満たした
- 通らなかった・形が変わったもの:
  - CRLF の改行は `\r` が落ちて `<bash-input>` に入り、webui の一致の条件を満たさない (ボタンは「実行中…」のままになる)。コマンドは走る
  - 末尾の空白・改行は落ちる (1 行の時と同じで、一致の条件は満たす)
  - stdin を読むコマンドは何も読まない (stdin は `/dev/null`)。これは 1 行でも同じ bash mode の性質
- B の「スクリプトとして実行できない」は、hyoui の web の入力欄が行ごとに Enter を送るためで (B1)、module の経路には当てはまらない。1 行目だけが bash mode で走り、残りの行は通常の prompt として model に送られる。「Enter/行」off の入れ方でも、`!` が文字として残り 1 行目が `command not found` になることが多かった (B2)
- kawaz の案 (一時ファイル + 1 行) が要る場面は、上の観測の範囲では見つからなかった。採るなら直すべき点として観測したもの:
  - `"$SHELL" < "$t"` はスクリプトの中の stdin を読むコマンドにスクリプトの残りを読ませる (C2)。`"$SHELL" "$t"` ならそれは起きない
  - 別のシェルで走るので、bash mode で直接走らせた時と違い、`.zshrc` 由来の alias・関数・`setopt login` が無い (C3)
  - 中身が `<bash-input>` に入らず、ファイルを書いてから読むまでの間に書き換えられた中身が走る (C4)。会話の記録に残るのは `cat` の出力だけ
  - 最後の `rm -f` で終了コードが常に 0 になり、出力のタグで成否が分かれる性質が使えなくなる。もう一度送るとファイルが無く失敗する (C1)
  - 中断や待ちの列からの削除で走らなかった時に、一時ファイルが残る (起こしてはいない。`rm -f` がコマンドの最後にあることからの推測)

## 確かめていないこと

- `$SHELL` が bash の時の振る舞い (今回は zsh だけ)
- composer にダイアログが出ている時、transcript の閲覧中の時の複数行
- B2 で `!` が文字として残る条件
- 2.1.319 以前で出力のタグが終了コードで分かれていたか

## 上流への還元

上流に起票済み: hyoui docs/issue/2026-11-11-request-web-input-multiline-bang.md (B の観測)
