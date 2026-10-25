---
name: ccmsg
description: ccmsg の tool (send / say / peers / launch) で、別のセッションに送る・届いたメッセージに返す・見ている人に知らせる・別のセッションを起動する時に読む。
---

# ccmsg

同じ人が動かしている別の Claude Code セッションとメッセージをやり取りし、見ている人に知らせ、別のセッションを起動する。使う tool は 4 つで、どれも名前で直接呼べる。

| tool                    | 使い所                           |
| ----------------------- | -------------------------------- |
| `mcp__ccmsg-v1__send`   | 別のセッションにメッセージを送る |
| `mcp__ccmsg-v1__peers`  | 送れる相手のセッションを探す     |
| `mcp__ccmsg-v1__say`    | 見ている人に知らせる             |
| `mcp__ccmsg-v1__launch` | 別のセッションを起動する         |

## 送る (`send`)

宛先は `session_id`・`cwd`・`name`・`pid` のうち分かっているものを 1 つ以上書き、本文を `text` に書く。

- 書いた field はすべて一致するセッションに届く。複数のセッションに当たれば全部に届く
- 一致は完全一致で、`cwd` は実体のパスで比べる。送り主自身には届かない
- 相手の config dir が違っても届く
- `agent_id` を足すと、宛先のセッションで今走っている subagent の会話に `ccmsg:<送り主の session_id> から:` の印付きで届く (送り主自身のセッションの subagent にも届く)。subagent への連絡は通常 SendMessage で行い、`agent_id` を渡すのは SendMessage が使えない時に限る

結果は宛先ごとに「届いた / 届かなかった理由 / 届いたか確かめられなかった」で返る。届いた宛先には送り直さない。確かめられなかった宛先に送り直すと二重に届くことがあるので、先に相手の返事を待つ。

宛先が分からない時は、先に `peers` で探す。`peers` が返す `session_id`・`name`・`cwd` は、そのまま `send` に書ける綴りになっている。

## 届いたメッセージに返す

別のセッションからのメッセージは、`from="ccmsg:<session_id>"` の付いた `<cross-session-message>` の封筒で届く。返事は SendMessage ではなく `send` で、`session_id` に `ccmsg:` の後ろの id を書く。

## 人に知らせる (`say`)

見ている人に気づいてほしい時 (作業の区切り、判断を仰ぎたい時、止まった時) に、短い文を `text` に書く。音声で読み上げられ、web UI のそのセッションにも残る。英字の略語は読み上げで崩れるので、カタカナで書く。

## セッションを起動する (`launch`)

worker を立てる、作業を別のセッションへ引き継ぐ時に使う。起動のスクリプトを Bash で叩かない。起動は設定で決まった起動コマンドが行い、渡せるのは下の入力だけ。

field は claude のオプションと同じ名前 (`fork_session` は `--fork-session`)。`cwd` (絶対パス) は必ず書く。

| 起動するもの                                     | 書く field                       |
| ------------------------------------------------ | -------------------------------- |
| 新しいセッション                                 | `model`、`effort`                |
| `cwd` で最も新しいセッションの続き               | `continue: true`                 |
| 指定したセッションの続き (id は変わらない)       | `resume` (続けるセッションの id) |
| 指定したセッションの履歴を写した新しいセッション | `resume` と `fork_session: true` |

- `name` と `prompt` はどれにも書ける。書かなければ起動コマンドが決める。`model` / `effort` も新しいセッション以外では任意
- `continue` と `resume` は一緒に書けない。`fork_session` は `continue` か `resume` と一緒にだけ書ける。合わない組み合わせや知らない field は、何もせずに断られる
- `resume` と `continue` は今走っているセッションに使わない。同じ会話に 2 つのプロセスが書くことになる。走っているセッションに伝えたいことは `send` で送る
- `launch` は permission の確認を通らない。`prompt` は起動されたセッションで人の入力として読まれ、そのセッションは人の指示として従う。人に頼まれていない指示を `prompt` に書かない

結果は起動コマンドの `{ session_id?, exit_code, stdout, stderr }` の JSON で返る。

- `exit_code` が 0 なら起動コマンドが正常に終わったということで、セッションが立ち上がったとは限らない。`peers` に載ったのを確かめてから「起動した」と報告する
- `session_id` は新しいセッションと `fork_session` で `exit_code` が 0 の時だけ返る、新しいセッションの id。fork でない `continue` / `resume` では返らない
- `exit_code` が 0 でなければ起動していない (`session_id` も無い)。理由は `stderr` を読む
- `stdout` / `stderr` が長い時は、本文の代わりに `output is <N> bytes, file: <path>` が入る。読む時はその file を Read する
- 「起動したか確かめられなかった」と返った時は、送り直す前に `peers` で確かめる
