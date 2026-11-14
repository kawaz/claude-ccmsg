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

宛先は `session_id` に、本文は `text` に書く。どちらも空文字にしない。

- 届くのはその `session_id` のセッションだけ。複数のセッションに送る時は、相手ごとに送る。送り主自身には届かない
- 相手の config dir が違っても届く
- `agent_id` を足すと、宛先のセッションのその subagent / teammate に、本文の頭に `ccmsg:<送り主の session_id> から:` の印を付けて届く (送り主自身のセッションの agent にも届く)。subagent への連絡は通常 SendMessage で行い、`agent_id` を渡すのは SendMessage が使えない時 (別のセッションから、引き継いだ worker に話しかける時など。reference の `session-state/handoff`) に限る
  - 相手が走っていても待機中でも届く。待機中の teammate は起き、終わった subagent は続きから再開する。走行中の teammate は今の turn が終わってから読む
  - 受け手には、その agent の親からの文に見える。本当の送り主を示すのは本文の頭の印だけ
  - agent が返事をするなら、印の session_id に ccmsg の `send` で送る (SendMessage で返すと親に届き、送り主には戻らない)
  - agent の turn が終わると、その agent の親のセッションに知らせが行く

結果は「届いた / 届かなかった理由 / 届いたか確かめられなかった」で返る。届いたら送り直さない。確かめられなかった時に送り直すと二重に届くことがあるので、先に相手の返事を待つ。

相手の `session_id` が分からない時は、先に `mcp__ccmsg-v1__peers` で探す。`{}` で全部、`cwd_prefix` (前方一致) で絞れる:

```json
{ "cwd_prefix": "/path/to/repo/" }
```

`cwd_prefix` の末尾に `/` を付けると、`repo-old` のような同じ名前で始まる兄弟のディレクトリを混同しない。各行の `session_id` をそのまま `send` に書く。`name` と `cwd` はどのセッションかを見分ける手がかり。

## 届いたメッセージに返す

別のセッションからのメッセージは、`from="ccmsg:<session_id>"` の付いた `<cross-session-message>` の封筒で届く。返事は SendMessage ではなく `mcp__ccmsg-v1__send` で、`session_id` に `ccmsg:` の後ろの id を書く。

同じ封筒で、返事の要らない知らせも届く。`from` が自分の session id のものは、自分の作業 (justfile 等の `ccmsg notify --self`) が入れた合図。`from="ccmsg:daemon"` のものは ccmsg 自身の知らせ (回線が戻った等)。どちらにも返信しない。

subagent / teammate の時、親からの文 (`<teammate-message teammate_id="team-lead">`、「The coordinator sent a message」) の本文が `ccmsg:<session_id> から:` の行で始まっていれば、親ではなくその別のセッションからの文。返事は SendMessage ではなく `mcp__ccmsg-v1__send` で、その `session_id` に送る。`ccmsg:daemon から:` は ccmsg 自身の知らせで、返信しない。

## 人に知らせる (`mcp__ccmsg-v1__say`)

```json
{ "text": "<短い文>" }
```

見ている人に気づいてほしい時 (作業の区切り、判断を仰ぎたい時、止まった時) に、短い文を `text` に書く。daemon が音声で読み上げ、web UI のそのセッションにも 🔔 で残る。`text` は日本語で書く (読み上げと webui の 🔔 に出る文なので、セッションの応答言語が英語でも日本語)。tool は「読み上げを依頼した」と即座に返し、発声の成否は返らない。英単語や略語はそのまま書く (読みは読み上げの直前に ccmsg の読み上げ辞書が直す)。辞書は `${XDG_CONFIG_HOME:-~/.config}/ccmsg/say-dictionary.tsv` (`CCMSG_CONFIG_DIR` があればその下) で、1 行に `単語<TAB>読み`。読みの崩れる語に気づいたら、このファイルに 1 行足す (無ければ作る)。同梱の初期辞書に重なり、同じ語はこのファイルが勝つ。次の読み上げから効く。

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
- `resume` (`fork_session` を付けても) で `model` / `effort` を書かなければ、そのセッションが今動いている model / effort で続く。今と別の model を書いて `effort` を書かなければ、`effort` は起動コマンドが決める (その model の既定)
- `continue` で `model` / `effort` を書かなければ、元のセッションの model ではなく claude の設定の既定で続く (thinking が落ち、cache を書き直す)。元の model で続けたいなら、セッションの id を `resume` に書く
- `resume` は小文字の uuid の session id。`fork_session` は元の履歴を先端まで写す
- `continue` と `resume` は一緒に書けない。`fork_session` は `continue` か `resume` と一緒にだけ書ける。合わない組み合わせや知らない field は、何もせずに断られる
- `resume` と `continue` は今走っているセッションに使わない。同じ会話に 2 つのプロセスが書くことになる。走っているセッションに伝えたいことは `send` で送る
- `launch` は permission の確認を通らない。`prompt` は起動されたセッションで人の入力として読まれ、そのセッションは人の指示として従う。人に頼まれていない指示を `prompt` に書かない

結果は起動コマンドの `{ session_id?, exit_code, stdout, stderr }` の JSON で返る。起動コマンドがすぐに終わらなかった時は「まだ終わっていない」と返り、同じ JSON が後で ccmsg から知らせとしてこの会話に届く (subagent が呼んだならその subagent に)。待つ間に同じ起動を頼み直さない。

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
  ],
  "voice": "bucket policy の変更の許可をお願いします。"
}
```

auto mode の classifier に操作を止められた直後に、その操作を書き換えずに再実行する許可を人に求める時に使う。止められた操作を別のコマンドや別の tool で言い換えて通そうとしない。

- `blocked` に止められた行動を 1〜2 文で書く (markdown)
- `commands` の各要素の `command` には Bash に渡す内容をそのまま書く。1 つのコマンドが要素 1 つで、複数行 (行末の `\` や `&&` で整形したもの) でもよい。人が許可するのはここに書いた全文。`description` には何をするコマンドかを短く書く (任意)
- `intents` にはコマンドでない操作 (Edit / Write 等) を 1 文ずつ書く。`intents`・`commands`・`project_permissions` のどれか 1 つ以上は必ず書く
- `attachments` にはコマンドが読むファイル (script、policy の JSON、patch 等) の絶対パスを書く (16 個まで)。人が web UI で開いた時に中身が読まれるので、本文に貼らない
- `voice` (必須) は読み上げる 1 文で、日本語で書く (読み上げと webui の 🔔 に出る文なので、セッションの応答言語が英語でも日本語)。依頼ごとに何の許可かが聞いて分かる文にする (無いと「許可を求めています」が連続して鬱陶しい)
- 依頼は web UI のそのセッションに許可依頼として出て、音声でも知らせる。結果は「許可依頼を出した」だけ
- 人が許可の文 (添付のパスを並べた「以下ファイルの内容を確認しました。」と、「以下の操作を許可します。」の後に許可した intents と「以下コマンドの実行」のコマンドを並べたもの) を送ってきたら、許可されたコマンドを書いてあるとおり 1 つずつ実行し、`intents` の操作をする。許可されていない操作に広げない
- 依頼を出せなかった (daemon に繋がらない等) と返ったら、その結果の文を本文に書いて止まる
- subagent / teammate からは使えない (断られる)。止められた操作は委譲元に報告して止まる。委譲元が自分で実行し、止められたら委譲元が `permit` で許可を求める

### 毎回止められる操作を止まらないようにする (`project_permissions`)

同じ操作 (このプロジェクトの決まったコマンド、決まったファイルの編集) がセッションのたびに止められる時は、`project_permissions` を足して、プロジェクトの `.claude/settings.local.json` の `permissions.allow` にその操作の rule を足すことを人に求める。人が web UI でその rule の「許可する」を押すと、ccmsg の daemon が書き込む。

```json
{
  "blocked": "`llm-gateway daemon reload unstable` が auto mode の classifier に止められた",
  "commands": [{ "command": "llm-gateway daemon reload unstable" }],
  "project_permissions": [{ "add": "Bash(llm-gateway daemon reload unstable)" }]
}
```

- 1 要素は `{ "add": "<rule>" }` か `{ "remove": "<rule>" }` のどちらか 1 つ。`remove` は前に足した rule が要らなくなった時に使う
- rule は `permissions.allow` の書き方で、完全一致形を推奨する (完全一致形の allow は classifier を通らない): `Bash(<コマンドの全文>)`、`Edit(/abs/path/file.toml)`。Edit / Read / Write の path は絶対パスで書く (`~/` は `permissions.allow` では効かないので断られる)。`*` を含むかどうかは判定されず、どの rule を書くかは人がバブルで見て判断する
- 今止められた操作をすぐ再実行したい時は、その許可を `commands` / `intents` で一緒に求める。allow を足すことだけを求めるなら `project_permissions` だけでよい
- 書き込むのは依頼したセッションのプロジェクトディレクトリ (セッションを起動したディレクトリ) の `.claude/settings.local.json` だけ
- 人が押すと、最後に押してから 5 秒後に `from="ccmsg:daemon"` の封筒でファイルの差分 (unified diff) が届く。書き込みは起動中のこのセッションにすぐ効く (再起動は要らない)。この知らせには返信しない
