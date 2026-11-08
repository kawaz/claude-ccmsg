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

- 手順: 書きかけを読む → `$.prompt.fill({ text: "", mode: "replace" })` (空にし、shell mode なら通常に戻す。ダイアログ中ならここで断られる) → hyoui `text:!` と `wait:─\n!\x{a0}` (`!` の後の NBSP で履歴の行を外す。下の 2026-11-08 の節) → `$.prompt.fill({ text: コマンド, mode: "append" })` → hyoui `key:Enter`
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

## 2026-11-08: 実環境で「! で実行」が素の prompt として入った件

### 実環境の観測 (読むだけで取ったもの)

kawaz の hyoui の下のセッション (Claude Code 2.1.318) に 2026-11-07 に「! で実行」を 3 回押した。daemon.log はどれも `session-input -> <sid> (bash): accepted`。

| 時刻 (UTC) | セッションの状態 | transcript |
|---|---|---|
| 23:53:28 | idle | user 行 `llm-gateway daemon reload unstable` (`promptSource: typed`、`origin: human`)。`!` 無し、`<bash-input>` 無し |
| 23:53:30 | 上の prompt の turn の実行中 | `queue-operation` (`enqueue`) と、turn に差し込まれた `queued_command` の attachment (`commandMode: "prompt"`) |
| 23:58:42 | idle | user 行 `perl -0pi -e '…'` (`promptSource: typed`)。`!` 無し |

- そのセッションの claude は 2026-11-06 12:04:38 JST に起動していた (`ps -o lstart`)。bash mode を入れた ccmsg 0.217.0 の公開は同日 14:42 JST
- 同じセッションの transcript で、0.217.1 の導入後 (2026-11-07T01:30Z) に読まれた ccmsg skill の base dir は `plugins/cache/ccmsg-v1/ccmsg-v1/0.215.1/skills/ccmsg`。plugin root は起動時の 0.215.1 のままだった
- 0.215.1 の `prompt.send` の args の schema は `{ text, override }` で、知らない欄 (`mode`) を拒まず落とす。module は fill (`replace`) と `key:Enter` だけを行い、`!` を打つ処理を持たない
- daemon.log の `(bash)` は全期間でこの 3 件だけ
- 同じ日の 23:58:07 に入った `!実行依頼を…` は webui からの通常の送信 (bash でない)。0.215.1 の module は `!` を打たないので module 由来ではない。先頭の `!` の出どころは特定していない

### 隔離環境での再現

隔離 daemon (0.217.1) と、hyoui の下で 58 桁 × 50 行の試験セッション (`--name "🤖ccmsg-verify-bang-*"`、Messages API は閉じたポート) で確かめた。`user_prompt` は daemon の socket に user role で直接送った。

| module | Claude Code | `mode: "bash"` の `user_prompt` の結果 |
|---|---|---|
| 0.215.1 (plugin cache の写しを `--plugin-dir`) | 2.1.318 | `accepted`。transcript は `promptSource: typed` の user 行 `echo oldmod-bang-1`、画面は `❯ echo oldmod-bang-1`。実環境と同じ形 |
| 作業コピー (0.217.1) | 2.1.318 | bash mode で実行された (`! echo newmod-bang-1` と `⎿ newmod-bang-1`) |


### `wait:` の照合の範囲

| 画面の行 | 先頭のバイト |
|---|---|
| bash mode の composer (idle、turn の実行中で待ちの列の薄字がある時の両方) | `21 c2 a0` (`!` と NBSP) |
| 会話に入った bash mode のコマンドの行 (`! echo …`) | `21 20` (`!` と ASCII の空白) |

- 通常の入力の時、`wait:─\n!\x{a0}` は timeout、`wait:(?m)^! ` は履歴の行に当たり、`wait:(?m)^!\x{a0}` は当たらない (2.1.318)
- 履歴の bash の行の上は空行で、`─` で終わる行の直下ではなかった。`─\n!` が履歴の行に当たる画面は作れていないが、照合が composer の行に限られていないので、`!` の後の NBSP まで含めて composer の行に絞った

### 結論と扱い

- 実環境の失敗の原因は、plugin の更新前に起動して 0.215.1 の module のまま動いていたセッションに `mode: "bash"` を送り、その module が `mode` を落として通常の prompt として入れ、`accepted` を返したこと (上の表で再現済み)。hyoui の `wait:` の偽陽性は観測していない
- 前の版の module 向けの分岐は置かない (kawaz 2026-11-08)。plugin を更新したら、そのセッションを起動し直す (DR-0040 §11)
- module の `wait:` は `─\n!\x{a0}` にした (上の「照合の範囲」)。2.1.319 の作業コピーの module で、composer に書きかけ `draft 書きかけ` を置いて 2 回送り、1 回目 (idle) は `<bash-input>echo new319-bang-1</bash-input>` と出力、2 回目は 1 回目の後に始まった turn の実行中で、画面に履歴の `! echo new319-bang-1` がある状態で `! echo new319-bang-2` として待ちの列に入った (transcript は `queue-operation` の `enqueue`)。書きかけは戻った

## 2026-11-08: bash mode の行は終了コードを持たない

「! で実行」に成功 / 失敗を出せるかを見るため、bash mode で終了コードの違うコマンドを走らせ、transcript の行を読んだ。Claude Code 2.1.319、hyoui 0.16.4、一時ディレクトリの config home (`CLAUDE_CONFIG_DIR`、onboarding 済み・ダミー鍵の承認・作業ディレクトリの trust)、`ANTHROPIC_BASE_URL` は閉じたポート、`--name "🤖ccmsg-verify-bang-exitcode"`。plugin は載せず、キーは `hyoui input <id> 'text:!' 'wait:─\n!\x{a0}' 'text:<command>' key:Enter` で送った。各コマンドの後に model への request が始まるので、`Escape` で止めてから次を実行させた。

| コマンド | `<bash-input>` の行の `message.content` | 続く行の `message.content` | 画面 |
|---|---|---|---|
| `echo ok-0` | `<bash-input>echo ok-0</bash-input>` | `<bash-stdout>ok-0</bash-stdout><bash-stderr></bash-stderr>` | `⎿ ok-0` |
| `false` | `<bash-input>false</bash-input>` | `<bash-stdout></bash-stdout><bash-stderr></bash-stderr>` | `⎿ (No output)` |
| `exit 3` | `<bash-input>exit 3</bash-input>` | `<bash-stdout></bash-stdout><bash-stderr></bash-stderr>` | `⎿ (No output)` |
| `sh -c 'exit 3'` | `<bash-input>sh -c 'exit 3'</bash-input>` | `<bash-stdout></bash-stdout><bash-stderr></bash-stderr>` | `⎿ (No output)` |
| `ls /nonexistent` | `<bash-input>ls /nonexistent</bash-input>` | `<bash-stdout></bash-stdout><bash-stderr>ls: cannot access '/nonexistent': No such file or directory\n</bash-stderr>` | `⎿ ls: cannot access …` |

- どの行も、終了コードを表す欄は無かった。行の欄は `parentUuid` / `isSidechain` / `promptId` / `type` / `message` / `uuid` / `timestamp` / `userType` / `entrypoint` / `cwd` / `sessionId` / `version` / `gitBranch` と、出力の行の `turnOrigin` / `turnPosition`
- `false` / `exit 3` / `sh -c 'exit 3'` の行は、出力の無い成功したコマンドの行と区別できない。画面の表示も同じ (`(No output)`)
- 同じ transcript の `api-request` の行 (model に送る内容) にも、終了コードの文は無かった (`Exit code` の文字列は 0 件)
- 実環境の config dir の transcript の `<bash-stderr>` が空でない行 (2.1.50〜2.1.317) にも、終了コードの欄は無かった (`python` が無いファイルを開けなかった行など)
- mod の event (`session.append` 等) に終了コードが載るかは見ていない。`session.append` の `<bash-input>` の本文は transcript の行と同じ (上の 2026-11-06 の節)
