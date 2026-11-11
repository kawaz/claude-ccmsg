# tool `peers` / `send` が過去の transcript でどう呼ばれたか

- Date: 2026-11-11
- 対象: 手元の 2 つの config dir の `projects/` にある transcript (subagent の transcript を含む)。plugin は ccmsg-v1 (tool の名前が `mcp__ccmsg-v1__peers` / `mcp__ccmsg-v1__send` のもの)
- 動機: セッションの起動元 (`entrypoint`) を `peers` の出力にも足すかを決めるため、`peers` の出力の大きさと、絞り込みの引数が実際に使われているかを数えた
- 方法: assistant の行の `tool_use` を tool の名前で拾い、`input` の key の組み合わせで数えた。`peers` の結果は、同じ transcript の `tool_result` を `tool_use_id` で対応させて、文字数と載った session id の数を数えた。`send` の `session_id` は、同じ transcript でそれより前の `peers` の結果に出ていた id かどうかで分けた

## `peers` の呼び出し (64 回、32 本の transcript)

| 引数の形 | 回数 | 結果の文字数 (中央値 / 最大) | 載ったセッション数 (中央値 / 最大) |
|---|---|---|---|
| `cwd_prefix` | 40 | 224 / 4193 | 1 / 22 |
| 引数なし | 18 | 2415 / 4369 | 12.5 / 23 |
| `name` | 3 | 236 / 248 | 1 / 1 |
| `cwd` (`peers` の引数ではない) | 3 | 1721 / 2451 | 10 / 13 |

- 呼んだのは main が 63 回、subagent が 1 回
- 絞って呼んだのは 43 回 (67%)。ほぼ `cwd_prefix` で、`name` は 3 回
- `cwd_prefix` の 40 回のうち、末尾に `/` を付けたのは 29 回、付けなかったのは 11 回
- `cwd` を渡した 3 回は、絞られずに全セッションが返っていた。今の版はこの入力を「peers takes cwd_prefix, name; cwd is not its field」で断る (`PeersToolInputSchema` の `refusesFieldsOf`)
- 出力は 1 セッション 1 行 (`- session_id: <uuid>, name: "<name>", cwd: "<path>"`) で、引数なしの中央値から 1 行は約 190 文字

## `send` の宛先 (387 回、45 本の transcript)

| 宛先の形 | 回数 |
|---|---|
| `session_id` | 374 |
| `session_id` + `agent_id` | 7 |
| `cwd` | 5 |
| `name` | 1 |
| `pid` | 0 |

- `peers` を呼んだ transcript の中の `send` (348 回が `session_id` を指定) では、その `session_id` が前の `peers` の結果に出ていたものが 189 回、出ていなかったもの (届いた封筒の `from` への返信、引き継ぎの本文に書かれた id 等) が 159 回

## 読み取れること

- `peers` の絞り込みは使われている (3 回に 2 回)。使われているのは `cwd_prefix` で、`name` はほぼ使われていない
- 引数なしの呼び出しが 28% あり、その時は 12〜23 セッション分 (2.4〜4.4 KB) が会話に載る。1 行に欄を 1 つ足すと、その行数分だけ増える
- `send` はほぼ `session_id` で宛てられている。`peers` はその id を引くために使われ、`name` / `cwd` / `pid` で直接宛てる使い方は 387 回中 6 回

## 確かめていないこと

- `peers` の結果のうち、エージェントが実際に読んで使った欄 (name と cwd のどちらで相手を選んだか)
- 引数なしで呼んだ理由 (絞る条件が分からなかったのか、全体を見たかったのか)
