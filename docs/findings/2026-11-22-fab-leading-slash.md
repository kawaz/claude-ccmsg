# 頭が `/` の文は composer で slash コマンドとして読まれる (実測)

- Date: 2026-11-22
- 対象: Claude Code 2.1.330 (macOS)
- 動機: webui の入力欄から `/ 1文字のときは…` のように頭に `/` を置いた文を送ると、TUI に `Commands are in the form /command [args]` が出てプロンプトとして届かなかった。送り方 (fill + Enter) の問題か TUI の仕様かを切り分け、プロンプトとして届ける手を決める ([DR-0035](../decisions/DR-0035-user-input-via-composer-fill.md) §1)
- 方法:
  - 認証のある普段使いの config dir で、リポの外の一時ディレクトリ (`git init` だけした空のディレクトリ) を cwd に、使い捨てのセッションを hyoui の中で `--model haiku` で起動した。計測するセッション自身の環境変数のうち子の claude を計測するセッションの子として扱わせるもの (`CLAUDE_CODE_CHILD_SESSION` / `CLAUDE_CODE_SESSION_ID` / `CLAUDE_CODE_MESSAGING_SOCKET` / `CLAUDE_CODE_MESSAGING_TOKEN` / `CLAUDE_CODE_ENTRYPOINT` / `CLAUDE_CODE_SESSION_ATTENDED` / `CLAUDE_CODE_EXECPATH`) は `env -u` で落とした
  - 観測用の小さな mod を `--plugin-dir` で読み込んだ。ファイルで受けた依頼で `$.prompt.fill({ text, mode: "replace" })` / `$.prompt.submit(...)` を呼び、`prompt.submit` と `command.run` の `e` と結果を記録する
  - 3 つの入れ方を比べた: 打鍵 (`hyoui input <id> "text:<文>"` → `key:Enter`)、fill + Enter (mod の fill の後に `hyoui input <id> key:Enter`。hooks/prompt-send.ts のプロンプトの経路と同じ手順)、貼り付け (`hyoui input <id> "paste:<文>"` → `key:Enter`)
  - 判定は TUI の画面、`prompt.submit` / `command.run` が起きたか、transcript の人の行
  - ccmsg の daemon と webui を通した経路は回していない。module の中で起きることは上の fill + Enter と同じ

## 判明した事実

### 入れ方による違いは無い

打鍵・fill + Enter・貼り付けで、同じ文は同じ扱いになった (下の表で入れ方を書いていない行は fill + Enter で測った)。頭が `/` の文が届かないのは送り方の問題ではなく、composer が文を slash コマンドとして読む仕様による。

### 頭が `/` の文の扱い (セッションが idle の時)

| 入力 | 結果 | `prompt.submit` / `command.run` |
|---|---|---|
| `/ abc` (打鍵・fill・貼り付け) | `Commands are in the form /command [args]` (人の行として残り、composer は空になる) | どちらも起きない |
| `/ 1文字のときは検索すべきではないですね` | `Commands are in the form /command [args]` | どちらも起きない |
| `/foo bar` (打鍵・fill・貼り付け) | `Unknown command: /foo. Did you mean /loop?` と `Args from unknown skill: bar` | どちらも起きない |
| `/abc` | `Unknown command: /abc. Did you mean /bg?` | どちらも起きない |
| `/foo-bar x` | `Unknown command: /foo-bar` と `Args from unknown skill: x` | どちらも起きない |
| `/a:b x` | `Unknown command: /a:b` と `Args from unknown skill: x` | どちらも起きない |
| `/123` | `Unknown command: /123` | どちらも起きない |
| `/abc` + 改行 + `続き` (打鍵・fill) | `Unknown command: /abc` と `Args from unknown skill: 続き` (2 行目以降も引数になる) | どちらも起きない |
| `/context` (打鍵・fill・貼り付け) | コマンドとして走る | `command.run` (`origin.kind: "composer"`)。`prompt.submit` は起きない |
| `/context は何を表示する` | コマンドとして走り、残りは引数 | `command.run` (`args: "は何を表示する"`) |
| `/設計の話` | プロンプトとして届く | `prompt.submit` (`text: "/設計の話"`) |
| `/1文字は検索しない` | プロンプトとして届く | `prompt.submit` |
| `/.x` | プロンプトとして届く | `prompt.submit` |
| `/color/red` | プロンプトとして届く | `prompt.submit` (webui の入力欄から、書き換えを入れる前の版でも同じくプロンプトとして届いた) |
| `// abc` | プロンプトとして届く | `prompt.submit` |
| `／abc` (全角の斜線、打鍵・fill) | プロンプトとして届く | `prompt.submit` |
| "`/rename` red" (頭をバッククォートにした文) | プロンプトとして届き、セッションの名前は変わらない | `prompt.submit` (`text` はバッククォートのまま) |

- **頭をバッククォートにした文はプロンプトとして届き、transcript の人の行の本文もバッククォートのまま** ("`/rename` red"、`promptSource: "typed"`、`origin.kind: "human"`)。TUI の画面ではバッククォートの部分がコードとして描かれ、`/rename red` と見える
- コマンドとして走った文と、`Commands are in the form` / `Unknown command` になった文では、`prompt.submit` が起きない。webui の入力欄から送ると、受け付けを確かめる材料が無く、結果は未確認になる (hooks/prompt-send.ts のコードから読んだ帰結。ccmsg の経路では測っていない)

### 頭の空白・全角空白・改行

| 入力 | 結果 |
|---|---|
| ` /context`、` /context は何を表示する` (頭に半角空白、fill) | コマンドとして走る |
| 頭に半角空白を置いた `/rename red` (TUI に打鍵) | コマンドとして走り、セッションの名前が変わった |
| 頭に全角空白 (U+3000) を置いた `/` で始まる文 (TUI に打鍵) | コマンドとして走った |
| ` /abc`、` / abc`、` /foo bar` (頭に半角空白、idle の時、打鍵・fill) | プロンプトとして届いた (`text` は頭の空白付き) |
| ` / abc` (頭に半角空白、turn の実行中に fill) | turn の後に `Commands are in the form /command [args]`。`prompt.submit` は起きない |

- **頭の空白は slash コマンドの読みを止めない**。ある名前のコマンドは頭に空白があっても走る。idle の時に頭の空白付きの ` /abc` 等がプロンプトとして届いたのは、無いコマンドの時だけ見えた振る舞いで、turn の実行中は届かない (turn の実行中に入れた文は頭の空白が落ちる)。下の「実装」の読みでは ` /abc` も `Unknown command` になるはずで、idle の時に届く仕組みは特定していない
- 打鍵の 2 行 (半角空白の `/rename red`、全角空白) は、ユーザが自分の TUI で打った観測

### plugin の API

| 呼び出し | 結果 |
|---|---|
| `$.prompt.submit({ text: "/ abc" })` | reject: `prompt.submit: submits a prompt to the model; a text beginning with / would run a command as the user; run one with $.command.run({ command }) (host check)` |
| `$.prompt.submit({ text: "/ abc", asUser: true })` | 同じ reject |
| `$.prompt.submit({ text: " / abc" })` | 同じ reject |

`$.prompt.submit` は頭の空白を除いて `/` で始まる文を拒む。型定義と実機で、slash コマンドの読みを通らずに `/` で始まる文をプロンプトとして入れる口は見つからなかった。`Commands are in the form` になる文では `prompt.submit` も `command.run` も起きないので、hook で Enter の後に拾うこともできない。

### 実装と changelog

- バイナリに入っている 2.1.330 の JS を読んだ。slash コマンドかの判定は文を `trim()` してから `/` で始まるかを見る。コマンド名は `/` の後から最初の空白の手前まで。名前が空なら `Commands are in the form` を返して model に送らない (headless では送る)。名前が `^[a-zA-Z0-9_][a-zA-Z0-9:_-]*$` に合わなければプロンプトとして送る。名前の形は合うが無いコマンドなら `Unknown command` で、`/<名前>` がファイルとして在ればプロンプトとして送る
- 上の表の `/foo-bar`・`/a:b`・`/123` (形が合う、無い → `Unknown command`) と `/設計の話`・`/.x`・`/color/red`・`//` (形が合わない → プロンプト) は、この規則と一致する
- 名前が空の時の処理と判定の形は、手元に残る 2.1.321 と 2.1.326 でも同じだった。それより前の版は確かめていない
- changelog の関係しそうな記述: 2.1.319 `Fixed slash commands typed after a leading space, tab or newline being sent to Claude as plain text instead of running`、2.1.246 `Fixed prompts beginning with /-- (e.g. Lean doc comments) being rejected as an unknown slash command instead of being sent to Claude`、2.1.132 `Fixed pasting text starting with / silently swallowing the input or triggering an unknown-command reply`。名前が空 (`/ `) の扱いを変えた記述は無い

## 実用的な示唆

- 人の文を頭が `/` のまま composer に入れると、名前の形次第でコマンドの実行・エラー・プロンプトのどれかになり、人には予測できない。頭の空白で避ける手は効かない (ある名前のコマンドは走り、turn の実行中は無い名前も届かない)
- 頭をバッククォートにすると、どの名前でもプロンプトとして届き、transcript の行の本文も入れた文のまま残るので、送った文との照合に使える。ccmsg は prompt の頭 (空白の後) の `/` と直後の ASCII の語の文字をバッククォートで囲んで入れる ([DR-0035](../decisions/DR-0035-user-input-via-composer-fill.md) §1)
- 本物のコマンドを人の入力として走らせる手は、plugin なら `$.command.run({ command, args })`

## 確かめていないこと

- ゼロ幅の文字 (U+200B / U+2060 / U+FEFF) を頭に置いた文の扱い。`$.prompt.fill` は端末で何も描かれない code point を除いて入れる (型定義の記述) ので、fill の経路では残らない見込み
- 頭をバッククォートにした文を turn の実行中に入れた時の扱い (頭の文字が空白でないので、頭の空白が落ちることの影響は受けない見込み)
- webui の入力欄から daemon を通した経路での一巡
