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
