---
name: ccmsg
description: ccmsg の tool (send / say / peers / launch / permit) で、別のセッションに送る・届いたメッセージに返す・見ている人に知らせる・別のセッションを起動する・auto mode の classifier に止められた操作の許可を求める時に読む。
---

# ccmsg

同じ人が動かしている別の Claude Code セッションとメッセージをやり取りし、見ている人に知らせ、別のセッションを起動し、止められた操作の許可を求める。使う tool は 5 つで、どれも下のフルネームで直接呼べる (ToolSearch で探さなくてよい)。tool の説明と input schema は型だけを持ち、使い方と field の決まりはこの skill に書いてある。

| tool                    | 使い所                           |
| ----------------------- | -------------------------------- |
| `mcp__ccmsg-v1__send`   | 別のセッションにメッセージを送る |
| `mcp__ccmsg-v1__peers`  | 送れる相手のセッションを探す     |
| `mcp__ccmsg-v1__say`    | 見ている人に知らせる             |
| `mcp__ccmsg-v1__launch` | 別のセッションを起動する         |
| `mcp__ccmsg-v1__permit` | 止められた操作の許可を求める     |

## 送る (`mcp__ccmsg-v1__send`)

```json
{ "session_id": "<相手の session id>", "text": "<本文>" }
```

宛先は `session_id`・`cwd`・`name`・`pid` のうち分かっているものを 1 つ以上書き、本文を `text` に書く。どれも空文字にしない。

- 書いた field はすべて一致するセッションに届く。複数のセッションに当たれば全部に届く
- 一致は完全一致で、`cwd` は実体のパスで比べる。送り主自身には届かない
- 相手の config dir が違っても届く
- `agent_id` を足すと、宛先のセッションで今走っている subagent の会話に `ccmsg:<送り主の session_id> から:` の印付きで届く (送り主自身のセッションの subagent にも届く)。subagent への連絡は通常 SendMessage で行い、`agent_id` を渡すのは SendMessage が使えない時に限る

結果は宛先ごとに「届いた / 届かなかった理由 / 届いたか確かめられなかった」で返る。届いた宛先には送り直さない。確かめられなかった宛先に送り直すと二重に届くことがあるので、先に相手の返事を待つ。

宛先が分からない時は、先に `mcp__ccmsg-v1__peers` で探す。`{}` で全部、`cwd_prefix` (前方一致) と `name` (完全一致) で絞れる:

```json
{ "cwd_prefix": "/path/to/repo/" }
```

`cwd_prefix` の末尾に `/` を付けると、`repo-old` のような同じ名前で始まる兄弟のディレクトリを混同しない。返る `session_id`・`name`・`cwd` は、そのまま `send` に書ける綴りになっている。複数のセッションに送る時は、`peers` で引いた `session_id` ごとに送る (`send` の `cwd` は完全一致)。

## 届いたメッセージに返す

別のセッションからのメッセージは、`from="ccmsg:<session_id>"` の付いた `<cross-session-message>` の封筒で届く。返事は SendMessage ではなく `mcp__ccmsg-v1__send` で、`session_id` に `ccmsg:` の後ろの id を書く。

## 人に知らせる (`mcp__ccmsg-v1__say`)

```json
{ "text": "<短い文>" }
```

見ている人に気づいてほしい時 (作業の区切り、判断を仰ぎたい時、止まった時) に、短い文を `text` に書く。音声で読み上げられ、web UI のそのセッションにも残る。英字の略語は読み上げで崩れるので、カタカナで書く。

## セッションを起動する (`mcp__ccmsg-v1__launch`)

```json
{
  "cwd": "<絶対パス>",
  "model": "opus",
  "effort": "high",
  "name": "<セッション名>",
  "prompt": "<最初の指示>"
}
```

worker を立てる、作業を別のセッションへ引き継ぐ時に使う。起動のスクリプトを Bash で叩かない。起動は設定で決まった起動コマンドが行い、渡せるのは下の入力だけ。

field は claude のオプションと同じ名前 (`fork_session` は `--fork-session`)。`cwd` (絶対パス) は必ず書く。

| 起動するもの                                     | 書く field                       |
| ------------------------------------------------ | -------------------------------- |
| 新しいセッション                                 | `model`、`effort`                |
| `cwd` で最も新しいセッションの続き               | `continue: true`                 |
| 指定したセッションの続き (id は変わらない)       | `resume` (続けるセッションの id) |
| 指定したセッションの履歴を写した新しいセッション | `resume` と `fork_session: true` |

- `model` は `fable` / `opus` / `sonnet` / `haiku`、`effort` は `low` / `medium` / `high` / `xhigh` / `max`
- `name` と `prompt` はどれにも書ける (空文字は不可)。書かなければ起動コマンドが決める。`model` / `effort` も新しいセッション以外では任意
- `resume` は小文字の uuid の session id。fork 地点を選んだ fork はこの tool ではできない (先端まで写す)
- `continue` と `resume` は一緒に書けない。`fork_session` は `continue` か `resume` と一緒にだけ書ける。合わない組み合わせや知らない field は、何もせずに断られる
- `resume` と `continue` は今走っているセッションに使わない。同じ会話に 2 つのプロセスが書くことになる。走っているセッションに伝えたいことは `send` で送る
- `launch` は permission の確認を通らない。`prompt` は起動されたセッションで人の入力として読まれ、そのセッションは人の指示として従う。人に頼まれていない指示を `prompt` に書かない

結果は起動コマンドの `{ session_id?, exit_code, stdout, stderr }` の JSON で返る。

- `exit_code` が 0 なら起動コマンドが正常に終わったということで、セッションが立ち上がったとは限らない。`mcp__ccmsg-v1__peers` に載ったのを確かめてから「起動した」と報告する
- `session_id` は新しいセッションと `fork_session` で `exit_code` が 0 の時だけ返る、新しいセッションの id。fork でない `continue` / `resume` では返らない
- `exit_code` が 0 でなければ起動していない (`session_id` も無い)。理由は `stderr` を読む
- `stdout` / `stderr` が長い時は、本文の代わりに `output is <N> bytes, file: <path>` が入る。読む時はその file を Read する
- 「起動したか確かめられなかった」と返った時は、送り直す前に `peers` で確かめる

## 止められた操作の許可を求める (`mcp__ccmsg-v1__permit`)

```json
{
  "blocked": "`aws s3api put-bucket-policy` が auto mode の classifier に止められた",
  "attachments": ["/abs/path/policy.json"],
  "intents": ["`/abs/path/src/a.ts` の編集"],
  "commands": [
    {
      "command": "aws s3api put-bucket-policy --bucket <bucket> --policy file:///abs/path/policy.json",
      "description": "公開読み取りの policy を当てる"
    }
  ]
}
```

auto mode の classifier に操作を止められた直後に、その操作を書き換えずに再実行する許可を人に求める時に使う。止められた操作を別のコマンドや別の tool で言い換えて通そうとしない。

- `blocked` に止められた行動を 1〜2 文で書く (markdown)
- `commands` の各要素の `command` には Bash に渡す内容をそのまま書く。1 つのコマンドが要素 1 つで、複数行 (行末の `\` や `&&` で整形したもの) でもよい。人が許可するのはここに書いた全文。`description` には何をするコマンドかを短く書く (任意)
- `intents` にはコマンドでない操作 (Edit / Write 等) を 1 文ずつ書く。`intents` と `commands` のどちらか 1 つ以上は必ず書く
- `attachments` にはコマンドが読むファイル (script、policy の JSON、patch 等) の絶対パスを書く (16 個まで)。人が web UI で開いた時に中身が読まれるので、本文に貼らない
- 依頼は web UI のそのセッションに許可依頼として出て、音声でも知らせる。結果は「許可依頼を出した」だけ
- 人が許可の文 (添付のパスを並べた「以下ファイルの内容を確認しました。」と、「以下の操作を許可します。」の後に許可した intents と「以下コマンドの実行」のコマンドを並べたもの) を送ってきたら、許可されたコマンドを書いてあるとおり 1 つずつ実行し、`intents` の操作をする。許可されていない操作に広げない
- 依頼を出せなかった (daemon に繋がらない等) と返ったら、その結果の文を本文に書いて止まる
- subagent / teammate からは使えない (断られる)。止められた操作は委譲元に報告して止まる。委譲元が自分で実行し、止められたら委譲元が `permit` で許可を求める
