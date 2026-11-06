# 人の `! <command>` (bash mode) を module から起こす経路を実機で確かめた

- Date: 2026-11-06
- 対象: Claude Code 2.1.319、hyoui 0.16.4
- 動機: permit バブルの「`!` で実行」(DR-0040) は、人が composer に `! <command>` と打って Enter したのと同じ結果 (出力が会話に入る) を、webui からそのセッションに起こす。mod の `$` に bash mode を直接起こす口は無い (`$.process.run` の結果は transcript に入らず、`$.session.append` は文字列が入るだけで実行されない) ので、`prompt.send` (DR-0035) と同じ composer + 端末のキーの組み合わせで起こせるか、どの組み合わせなら起きるか、受け付けを module が何で知れるかを見る
- 方法:
  - 一時ディレクトリの config home (`CLAUDE_CONFIG_DIR`、`.claude.json` に onboarding 済み・ダミー鍵の承認・作業ディレクトリの trust) と空の git の作業ディレクトリで、`env -i` から `hyoui run --detached` の中に `claude --plugin-dir <観測用の mod> --debug --model haiku --name "🤖ccmsg-verify-permit-bang-lab"` を起動した。`HYOUI_STATE_DIR` も一時ディレクトリに向けた
  - model には繋がない: `ANTHROPIC_BASE_URL` は閉じたポート (`http://127.0.0.1:9`) を指す。bash mode のコマンドの実行は model を要らない。model への request は `ECONNREFUSED` の再試行になり、その間は turn の実行中として扱った
  - 観測用の mod: event のうち `ui.render` / `prompt.section` / `prompt.attachment` 等の雑音を除いて全部を jsonl に書き、`prompt.submit` と `session.append` は `next` の結果も書く。外から置いたファイル (`{ seq, op: "read" | "fill", text, mode }`) を `$.clock.every(250)` で読み、`$.prompt.read` / `$.prompt.fill` の結果をファイルに返す
  - キーは `hyoui input <id> ...` で送り、画面は `hyoui screen dump --format text` で読んだ。transcript は config home の `projects/` の jsonl を読んだ

## 経路ごとの結果

| 経路 | 手順 | composer | Enter の後 | transcript |
|---|---|---|---|---|
| (a) fill に `!` ごと入れる | `$.prompt.fill({ text: "! echo bang-a1" })` → hyoui `key:Enter` | 通常の入力のまま `❯ ! echo bang-a1` (shell mode にならない) | 通常の prompt として送られ、`prompt.submit` (`text: "! echo bang-a1"`, `origin: composer`) と `classic.UserPromptSubmit` が起き、model に request が出た | `type:"user"`, `origin:{kind:"human"}`, `promptSource:"typed"`, 本文 `! echo bang-a1`。コマンドは実行されない |
| (b) `!` を打鍵し、shell mode に切り替わってからコマンドを fill | hyoui `text:!` → (切り替わりを待つ) → `$.prompt.fill({ text: "echo bang-b1", mode: "append" })` → hyoui `key:Enter` | `!` の打鍵で行頭の印が `❯` から `!` になり、足元の案内が `! for shell mode` になる。`$.prompt.read()` は `""` のまま (`!` は文字でなく mode)。append の後は `! echo bang-b1` | コマンドが実行され、画面に `⎿ bang-b1` | `<bash-input>echo bang-b1</bash-input>` の user 行と `<bash-stdout>bang-b1</bash-stdout><bash-stderr></bash-stderr>` の user 行。どちらも `origin` / `promptSource` は無い |
| (b) を待たずに続けて打つ | hyoui `text:!` `text:echo bang-c1` `key:Enter` (1 回の呼び出しで、spec を分けて) | — | `echo bang-c1!` が shell mode で実行された (`!` が末尾に付いた) | `<bash-input>echo bang-c1!</bash-input>` |
| `!` とコマンドを 1 つの塊で打つ | hyoui `text:!echo bang-e2` | shell mode で `! echo bang-e2`、`read()` は `echo bang-e2` | (Enter は送らず確認だけ) | — |
| fill の後に行頭へ `!` | `$.prompt.fill({ text: "echo bang-d1" })` → hyoui `key:Home` `text:!` | 通常の入力のまま `❯ !echo bang-d1` (`!` が文字として入る) | (送らず) | — |

採るのは (b)。(a) は通常の prompt として model に送られる。`!` の打鍵とコマンドの書き込みの間に shell mode への切り替わりを待たないと、上の 3 行目のように `!` の位置がずれた。

## shell mode と composer の振る舞い

| 確かめたこと | 結果 |
|---|---|
| shell mode で `$.prompt.fill({ text: "", mode: "replace" })` | 通常の入力 (`❯`) に戻る |
| shell mode で `$.prompt.fill({ text: "echo bang-f1", mode: "replace" })` | 通常の入力に戻り `❯ echo bang-f1` |
| shell mode で `$.prompt.fill({ text, mode: "append" })` | shell mode のまま |
| 空の shell mode でさらに `!` を打つ | shell mode のまま、`read()` は `""` |
| 空の shell mode で `Escape` | 通常の入力に戻る |
| shell mode に複数行 (`echo bang-m1\necho bang-m2`) を append して Enter | 2 行とも実行された。`<bash-input>echo bang-m1\necho bang-m2</bash-input>` |
| bash mode の実行中に `Escape` | 実行が止まり、コマンドが composer に戻った |

## 受け付けを module が知る手がかり

| 確かめたこと | 結果 |
|---|---|
| bash mode の Enter で `prompt.submit` / `classic.UserPromptSubmit` | どちらも起きない (idle でも turn の実行中でも) |
| Enter の直後の event | `prompt.change` (`{ text: "", cursor: 0, origin: { kind: "clear" } }`)。Enter の 58〜59 ms 後 (3 回) |
| `<bash-input>` の `session.append` の時機 | コマンドが終わった後。`sleep 4; echo bang-j2` では Enter の 4095 ms 後、`sleep 3; echo bang-k1` では 3091 ms 後。Enter の後、終わるまでの間に起きた event は `prompt.change` (`clear`) だけだった |
| `session.append` の形 (idle) | `door: "command"`, `origin: { kind: "unclassified" }`, `message.content[0].text` が `<bash-input>{コマンド}</bash-input>`。続いて `<bash-stdout>…</bash-stdout><bash-stderr>…</bash-stderr>` |
| turn の実行中に送った時 | 画面では `! echo bang-h1-busy` が待ちの列に並び、composer は `Press up to edit queued messages` の薄字。`session.append` は `door: "queue"`、本文はコマンドそのまま (`<bash-input>` で包まない)。transcript には `queue-operation` (`enqueue`, `content: "echo bang-h1-busy"`)。turn を `Escape` で止めると、その後で `<bash-input>` と `<bash-stdout>` の行が入った |
| `<bash-input>` の中の文字 | コマンドのまま (`<` `&` を escape しない)。`<bash-stdout>` の中は `&lt;a&amp;b&gt;` と escape される |
| 前後の空白 | `  echo   bang-i1  ` は `<bash-input>  echo   bang-i1</bash-input>`: 末尾の空白が落ち、先頭と中の空白は残る |
| bash mode の後の model | 出力の行の後に `turn.start` (`text` は `<bash-stdout>…`) と `prompt.compose` が起き、model に request が出た (idle の時) |
| `prompt.change` の型定義 (2.1.319 の `claude-code.d.ts`) | 「Fires after the main prompt box's text changed and no `prompt.edit` carried it」「Observe only」「One per batch of changes, one at a time」。`clear` は「The box was emptied by something other than an edit or an undo: a submit took the draft, a clear, a stash」 |
| Enter の後の書きかけの戻し | bash の実行中 (`sleep 2`) に `$.prompt.fill({ text: "my draft 下書き" })` で戻すと、コマンドが終わった後も composer に残り、通常の入力のまま |

## shell mode への切り替わりを待つ

- `hyoui input <id> 'text:!' 'wait:─\n!'` で待てる。`wait:` は画面の見える範囲を行でつないだ文字列に正規表現を当てる。composer の上の枠の行は `─` で終わり (行末の空白は落ちる)、shell mode ではその次の行が `!` で始まる。通常の入力では `❯` で始まる
- `!` の直後の桁は NBSP (U+00A0) で、`! ` (ASCII の空白) には当たらない。`(?m)^!` は履歴の `! echo …` の行にも当たる
- 陽性と陰性を確かめた: composer を空にした後、`!` を打たずに `wait:─\n!` だけを 1 秒待つと timeout (exit 1)、`!` を打ってから待つと exit 0。idle と turn の実行中 (待ちの列があり薄字が出ている時) のどちらでも同じ
- 打鍵から切り替わりを告げる event は、足元の案内の `ui.render` (`component: "PromptHint"`, `props.hint: "! for shell mode"`) だけで、`prompt.edit` / `prompt.change` は起きなかった

## 実装への示唆

- 手順: 書きかけを読む → `$.prompt.fill({ text: "", mode: "replace" })` (空にし、shell mode なら通常に戻す。ダイアログ中ならここで断られる) → hyoui `text:!` と `wait:─\n!` → `$.prompt.fill({ text: コマンド, mode: "append" })` → hyoui `key:Enter`
- 受け付けは `prompt.change` の `origin.kind === "clear"`。`<bash-input>` の `session.append` はコマンドが終わるまで来ないので、長いコマンドでは受け付けの待ちに間に合わない
- 書きかけは `clear` の後に fill で戻せる。fill (replace) は shell mode を抜けるので、書きかけは通常の入力として戻る

## 実装 (permit バブルの「! で実行」) を通した確認

隔離 daemon (作業コピーの `packages/daemon/src/index.ts --foreground`、`CCMSG_*` / `HOME` を一時ディレクトリに向け、`CCMSG_CLAUDE_CONFIG_DIRS` に試験用の config home だけを名指した) と、作業コピーを `--plugin-dir` にした試験セッション `🤖ccmsg-verify-permit-bang` (hyoui の下、Messages API の代役が固定の文を返す) で、`ccmsg sidecar permit --sid <試験セッション>` に 1 行のコマンド (`echo permit-bang-ok; ls -la`) と 3 行のコマンドを出し、webui を `playwright-cli` で開いた。

| 確かめたこと | 結果 |
|---|---|
| ボタンの出し分け | 1 行のコマンドの下にだけ `button.permit-bang` (`aria-label` 「! で実行」、`::before` の content 「! で実行」)。3 行のコマンドには無い |
| 押した時 (composer に書きかけ `draft 書きかけ` を置いた状態) | 試験セッションで `! echo permit-bang-ok; ls -la` が実行され出力が出た。その後 composer は `❯ draft 書きかけ` (通常の入力) に戻った |
| daemon.log | `session-input -> <sid> (bash): accepted tries=[… accepted]` |
| transcript | `<bash-input>echo permit-bang-ok; ls -la</bash-input>` と `<bash-stdout>permit-bang-ok\ntotal 0…` の user 行 (どちらも `origin` 無し) |
| webui の TL | 実行が `shell` の塊 (コマンドと出力) として出た。押した直後にボタンの横へ「HH:MM に送りました。出力はコマンドが終わると Timeline に出ます」 |
| 押した後の表示の持続 | 依頼のバブルが TL の末尾にある時に押すと、その後に行が足された時点でバブルが作り直され (印を付けたボタンの要素が別のものに替わった)、送った時刻の表示が消えた。末尾でない (後ろに行がある) バブルで押した時は要素が替わらず、表示が残った |

## 確かめていないこと

- ダイアログ中に `!` の打鍵が届いた時の振る舞い (手順では、その前の fill がダイアログで断られる)
- transcript の閲覧 (ctrl+o) 等で composer が画面に無い時。`wait:` が当たらず timeout になると考えているが、見ていない
- (b) を待たずに続けて打った時に `!` が末尾に付いた理由
