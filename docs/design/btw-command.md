# btw-command: btw コマンドの契約

## コンテキスト

webui の FAB の btw ([DR-0060](../decisions/DR-0060-btw-mode.md)) は、走っているセッションを fork して横道の質問・依頼に応えさせ、そのやりとりを本体の会話に残さない。fork を起こすのは config の `btw_command` で指定された 1 つのコマンド (以下、btw コマンド) で、無ければ ccmsg に同梱の組み込みの btw コマンドが `claude -p --resume <sid> --fork-session --no-session-persistence` を走らせる。この文書は daemon と btw コマンドの間の取り決めの正本で、btw コマンドを書く人と daemon を実装する人の両方が読む。

取り決めの芯は「daemon は型の決まった入力を btw 1 つにつき 1 回渡し、標準出力の claude の stream-json を読んで答えにするだけで、どの環境でどの claude をどう起こすかは btw コマンドが全部持つ」こと。

## config

| キー | 既定 | 内容 |
|---|---|---|
| `btw_command` | 組み込み | btw コマンドの argv (空でない文字列の配列)。先頭は絶対パス、`~/` で始まるパス、または daemon の `PATH` で探す名前。daemon の起動時に実行できるファイルの絶対パスに固定し、見つからなければ daemon は起動しない (`launch_command` と同じ読み方、[launch-command](./launch-command.md)) |

```json
{
  "btw_command": ["~/bin/ccmsg-btw"]
}
```

## 呼ばれ方

| 項目 | 内容 |
|---|---|
| argv | `btw_command` の配列そのまま。daemon は引数を足さず、shell を介さない |
| cwd | 入力の `cwd` (セッションの cwd) |
| 環境 | daemon の環境に、起動コマンドと同じ TMPDIR (daemon のユーザの一時ディレクトリ) を重ねたもの。掃除は btw コマンドがする |
| stdin | 入力の JSON (UTF-8) を 1 つ書いて閉じる。末尾に改行は付かない。`cat` や `jq` で全部を読む |
| stdout | claude の `--output-format stream-json --verbose --include-partial-messages` の行 (下の「戻り方」) |
| stderr | 失敗の理由。daemon は末尾の 2 行を btw の失敗の文に使う |
| process group | btw コマンドは自分の process group を持って起こされる (setsid)。取り消し (op `btw_cancel`) と daemon の停止は group に SIGTERM を送る |
| 回数 | btw 1 つにつき 1 回。daemon 全体で同時に `BTW_MAX_CONCURRENCY` (4) まで |
| 待ち | 期限は無い。止めるのは人の取り消しと daemon の停止 |

## 入力

形は `packages/protocol` の `BtwCommandInputSchema`。

| field | 型 | 意味 |
|---|---|---|
| `cwd` | 文字列 | セッションの cwd (agents の行の `cwd`、無ければ hello の cwd) |
| `config_dir` | 文字列 | セッションの CLAUDE_CONFIG_DIR (agents の行の `config_dir`、無ければ hello の config dir、無ければ transcript の在り処の config dir) |
| `resume` | 文字列 | fork するセッションの id |
| `model` | 文字列 (任意) | セッションが今走っている model を、セッションの綴りのまま (`opus[1m]`、`claude-opus-5-5[1m]`)。daemon が分からない時は無い |
| `effort` | 文字列 (任意) | 人が FAB の ⏱️ で選んだ effort、無ければセッションが今走っている effort。どちらも無ければ無い |
| `prompt` | 文字列 | 前置き (`BTW_PROMPT_PREFIX`) を付けた全文 |

```json
{"cwd":"/work/claude-ccmsg","config_dir":"/work/claude-config","resume":"5a900000-0000-4000-8000-000000000001","model":"opus[1m]","effort":"high","prompt":"<btw>\n...\n</btw>\n\nこの関数は何をしている?"}
```

- btw コマンドは使う欄だけを読み、知らない欄は無視する
- `model` は綴りのまま claude に渡す。launch の語彙 (`opus`) に写すと `[1m]` が落ち、元のセッションの prompt cache に当たらず、context が 200k を超えたセッションでは入らない

## 戻り方

daemon は標準出力を 1 行ずつ JSON として読み、`type` で次のものだけを使う。読めない行と知らない `type` は読み捨てる。

| 行 | 使い方 |
|---|---|
| `stream_event` (`parent_tool_use_id` が null) | `message_start` で新しい応答、`content_block_start` の `text` で新しい文のブロック、`content_block_delta` の `text_delta` で文を伸ばす。`content_block_start` の `tool_use` の `name` を今走っている tool として出す |
| `assistant` (`parent_tool_use_id` が null) | 差分の来なかった応答 (`message.id` で突き合わせる) の text のブロックを答えに足す。`tool_use` の `name` を今走っている tool にする |
| `result` | 終わり。`is_error` が false なら答えた (done)、true なら失敗 (`result` の文、無ければ `subtype`) |

- `parent_tool_use_id` のある行 (fork の中の subagent) は答えにしない
- `result` を書かずに終わったら失敗で、終了コードと stderr の末尾 2 行を失敗の文にする
- 自前の btw コマンドで `claude` 以外を起こす時も、この形の行を書く。差分の行を書かない (partial messages の無い) 出力も読める

## 組み込みの btw コマンド

config に `btw_command` が無い時、daemon は同梱の zsh スクリプト `packages/daemon/src/default-btw-command.sh` を `zsh -f <スクリプト>` で起こす (`zsh` は daemon の `PATH` で探す)。スクリプトがすることは次のとおり。

- `jq` と `claude` が `PATH` に無ければ理由を stderr に書いて 2 で終わる。入力に `cwd` / `config_dir` / `resume` が無い時も同じ
- `cwd` に移り、組み込みの起動コマンドと同じく `CLAUDECODE` と `(CLAUDE|ANTHROPIC|HYOUI|CCMSG)_*` を消す
- `direnv` があれば `direnv exec .` を通す (cwd の `.envrc` の鍵・アカウントが fork の tool に効くように)。`CLAUDE_CONFIG_DIR` はその内側で入力の `config_dir` にする (`.envrc` が別の値にしても、セッションの config dir で走る)
- `claude -p --resume <resume> --fork-session --no-session-persistence [--model <model>] [--effort <effort>] --permission-prompts none --output-format stream-json --verbose --include-partial-messages` を exec し、`prompt` を claude の標準入力に渡す (argv と ps に出さない)
- tool の集合を変える引数 (`--tools`、`--disallowedTools`、`--restricted`、`--bare` 等) は付けない。request の tools が元のセッションと変わると、prompt cache の前方一致がそこで切れる

## テストの daemon

テストの run の lifeline (`CCMSG_TEST_LIFELINE`) の下で起きた daemon は、config に `btw_command` が無ければ btw コマンドを起こさず、`btw_ask` は `btw_command_unavailable` で断る (組み込みは本物のセッションを fork し、model の request を出す)。btw を確かめるテストは、入力を記録して決まった stream-json を書く btw コマンドを config の `btw_command` に書く。発声コマンド ([say-command](./say-command.md)) の「テストの daemon」と同じ形。

## 関連

- [DR-0060](../decisions/DR-0060-btw-mode.md) — btw の全体
- [launch-command](./launch-command.md) — 同じ形の起動コマンドの契約
- [say-command](./say-command.md) — 同じ形の発声コマンドの契約
