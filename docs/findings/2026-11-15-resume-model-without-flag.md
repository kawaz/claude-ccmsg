# `--model` の無い `claude --resume` / `--fork-session` はどの model で続くか

- Date: 2026-11-15
- 対象: Claude Code 2.1.325
- 動機: webui の再起動・fork ([DR-0028](../decisions/DR-0028-session-kill.md) の webui) は、セッションが今動いている model で続く必要がある (kawaz 2026-11-15: model が変わると thinking が全て落ち、cache も書き直しになる)。起動コマンドが model を claude に渡さない時に、claude 自身が元のセッションの model を継ぐなら、webui・daemon は model を省いてよい。継がないなら、名指して起動コマンドに渡す必要がある
- 方法: 空の一時ディレクトリを cwd にし、認証のある config dir (settings.json の `"model": "fable"`) で `claude -p --output-format json` を 5 回走らせた。元のセッションは `--model haiku --effort low` の 1 ターンで作った。各ターンの model は、transcript (`projects/<cwd の slug>/<id>.jsonl`) の assistant 行の `message.model` と、出力の `usage` (cache の作成・読み) で判定した。確かめた後に transcript は消した

## 判明した事実

| 起動 | 続きのターンの model | cache (作成 / 読み) |
|---|---|---|
| 新規 `--model haiku --effort low` | `claude-haiku-5-5` | 60137 / 0 |
| `--resume <id>` | `claude-fable-5-2` | 60220 / 0 |
| `--resume <id> --fork-session` | `claude-fable-5-2` | 83 / 60151 |
| `--resume <id> --model haiku` | `claude-haiku-5-5` | 455 / 60137 |
| `--resume <id> --fork-session --model haiku` | `claude-haiku-5-5` | 56 / 60592 |

- **`--model` の無い `--resume` は、元のセッションの model ではなく settings の model で続く**。haiku のセッションが fable で続き、cache は全部書き直しになった (読み 0)
- **`--fork-session` を付けても同じ**。fork が cache を読めたのは、直前の `--resume` が同じ履歴を fable で書いていたため
- **`--model` を名指すと、その model で続き、元の cache に当たる**
- `--model` の無い 2 回では、stderr に `[claude-code:unrecognized_model] {"model":"fable[1m]","query_source":"sdk"}` が出た (settings の `fable` に claude が `[1m]` を付けた名前)。ターンは `claude-fable-5-2` で走った

## 実用的な示唆

- 再起動・fork で同じ model を保つには、起動コマンドが入力の `model` / `effort` を `--resume` でも claude に渡す ([launch-command](../design/launch-command.md) の「claude の引数への写し方」)。組み込みの起動コマンドは渡す
- daemon の `session_restart` は依頼に無い model / effort をセッションの今の値で埋めて起動の入力に入れるので、webui は人が選んでいない欄を省いてよい。`session_launch` (fork) は埋めないので、webui がセッションの今の値を名指す
- 未確認: 起動の入力は model の `[1m]` を落とす (`opus[1m]` → `opus`)。`[1m]` で始めたセッションを `--model opus` で resume した時に cache が同じに続くかは確かめていない

## 実際の再起動の記録との突き合わせ (2026-11-15)

上の実測は `-p` のものなので、対話のセッションでも同じかを、本番の daemon.log の `session_restart` の記録と、そのセッションの transcript の assistant の行の `message.model` / `version` で確かめた。どれも起動コマンドが `--model` を付けずに `claude --resume` した再起動。

| 面の settings の既定 | Claude Code の版 (後) | 再起動の前 | 再起動の後 | 備考 |
|---|---|---|---|---|
| fable | 2.1.322 | opus | fable | 最初の行から opus のセッション |
| fable | 2.1.325 | opus | fable | 最初の行から opus のセッション |
| fable | 2.1.325 | opus | fable | 途中で opus に切り替えたセッション |
| fable | 2.1.325 | opus | fable | fable のセッションを通しの上書き (DR-0041) で opus にしていたもの。元の model に戻ったとも読めるので、判定の材料にならない |
| opus | 2.1.319 | fable | fable | 既定が opus の面で fable のまま続いた (元の model を継いだ) |
| opus | 2.1.319 | opus | opus | 既定と同じなので、判定の材料にならない |

- 2.1.322 と 2.1.325 の対話のセッションでも、`--model` の無い resume は元の model を継がず、settings の既定で続いた (上の 3 行と `-p` の実測)
- 2.1.319 では継いだ記録が 1 件ある。ただし面と起動の経路 (包んだ claude を使う) が違うので、版の違いだけが理由かは分からない。いつから・なぜ変わったかは未特定
- 起動コマンドが入力の model / effort をそのまま claude に渡せば、どちらの挙動の版でも同じ model で続く
