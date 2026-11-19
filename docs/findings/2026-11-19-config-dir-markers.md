# HOME の直下の `.claude*` のうち、どれが config dir かを中身で見分ける (実測)

- Date: 2026-11-19
- 対象: Claude Code 2.1.328 (一時 HOME での観測)。開発機の HOME の偽物は 2.1.273〜2.1.296 が作ったもの (中の `.claude.json` の `firstStartVersion`)
- 動機: daemon の `detectConfigDirs` (`packages/daemon/src/agents.ts`) は「名前が `.claude` で始まり、ディレクトリである」だけで config dir とみなしていて、config dir でないディレクトリも返していた ([issue](../issue/archive/2026-11-12-config-dir-detect-returns-non-config-dirs.md))。何を config dir の証拠にするかを実物で決める
- 方法:
  - 開発機の HOME の直下の `.claude*` を全部、`ls` / `stat` / `jq` で読むだけで調べた (書き換えない・消さない)
  - 一時 HOME (`mktemp -d`) で `env -i PATH=... HOME=<一時 HOME> CLAUDE_CONFIG_DIR=<一時 HOME>/.claude-<x>` を付けて次を走らせ、config dir に作られる物を `find` で見た
    - `claude --version`
    - `claude agents --json`
    - `claude` の対話起動 (python の `pty.spawn` で端末を与え、`timeout 10` で止めた。未ログインなので最初の設定画面で止まっていて、入力も API の呼び出しもしていない)

## 開発機の HOME の `.claude*`

| 名前 | 種類 | `sessions/` | `projects/` | `settings.json` | `.claude.json` | `backups/` | その他 |
|---|---|---|---|---|---|---|---|
| `~/.claude` | 通常のファイル (0 byte) | - | - | - | - | - | |
| `~/.claude-personal` | config dir | あり | あり | あり | あり | あり | `history.jsonl`、`plugins/` 等多数 |
| `~/.claude-emrd` | config dir | あり | あり | あり | あり | あり | 同上 |
| `~/.claude-bare` | config dir | あり | あり | あり | あり | あり | 同上 |
| `~/.claude.json` | ディレクトリ | 無し | 無し | 無し | あり | あり | 無し |
| `~/.claude.json.lock` | ディレクトリ | 無し | 無し | 無し | あり | あり | 無し |
| `~/.claude-personal.lock` | ディレクトリ | 無し | 無し | 無し | あり | あり | 無し |
| `~/.claude-emrd.lock.bak-<数字>` | ディレクトリ | 無し | 無し | 無し | あり | あり | 無し |
| `~/.claude-<面の名前>` (1 つ) | ディレクトリ | 無し | 無し | 無し | あり | あり | 無し |

- 偽物 5 つは中身が同じ形: `.claude.json` (343 byte、key は `firstStartTime` / `firstStartVersion` / `machineID` / `migrationVersion` 等の初回起動の記録だけ) と、`backups/` の中に `.claude.json.backup.<数字>` 1 つ。ディレクトリと中のファイルの時刻は同じ秒で、その後に書かれていない
- 最後の行は面の名前をした dir だが、中身は偽物と同じ形で、セッションが使った跡が無い

## 一時 HOME で Claude Code が config dir に作る物

| 走らせたもの | config dir に作られた物 |
|---|---|
| `claude --version` | 何も作らない (config dir 自体も作らない) |
| `claude agents --json` | `.claude.json`、`backups/.claude.json.backup.<数字>` |
| `claude` の対話起動 (入力前) | `.claude.json`、`backups/`、`sessions/` (空)、`cache/changelog.md` |

- `claude agents --json` が残す物は、開発機の偽物の中身と同じ形
- 対話起動は入力の前に `sessions/` を作る。中の `<pid>.json` は終了時に消えたが、`sessions/` 自体は残った
- `projects/` は transcript の置き場で、この観測の範囲 (入力前) では作られなかった

## 結論

- config dir の証拠は「`sessions/` か `projects/` がディレクトリとしてある」とする
  - 本物 3 つには両方ある。偽物 5 つにはどちらも無い
  - 起動したばかりで入力前のセッションの config dir にも `sessions/` はある (中身の少ない config dir を落とさない)
  - daemon が config dir から読むのはこの 2 つだけ (`sessions/<pid>.json` を登録簿として、`projects/` を transcript の置き場として)。どちらも無い dir は、daemon が受け持っても読む物が無い
- `.claude.json` と `backups/` は証拠にならない: `CLAUDE_CONFIG_DIR` が指すディレクトリに Claude Code のどのコマンドでも作られ、偽物もこれを持つ
- `settings.json` は証拠にならない: 使っている config dir に必ずあるとは限らない (ユーザが何も設定していなければ作られない。対話起動の入力前の観測でも無かった)
- 名前の形 (`.lock` / `.json` / `.bak-<数字>` で終わる) で外す案は採らない: 上の表の最後の行のように、名前が config dir の形でも中身が偽物と同じ形の dir があり、名前では見分けられない
- 偽物の dir が作られた経緯 (何が `CLAUDE_CONFIG_DIR` をそこに向けたか) は分かっていない。`claude agents --json` が同じ形を作ることだけを観測した

## `detectConfigDirs` の結果を使う所 (判定を絞って落ちる物が無いかの確認)

- 登録簿の読み出し (`agents.ts`、`servedConfigDirs` 経由): `sessions/` を読む。`sessions/` の無い dir は読む物が無い。印は毎回探し直すので、後から `sessions/` が現れた dir は次の回で拾われる
- transcript の探索 (`server.ts` の `homeConfigDirs` → `transcript.ts`、`session-status.ts` の `virtualConfigDirs`): `projects/` を読む
- 接続していないセッションの fs_list / fs_read の root (`server.ts` の `fsVirtualOf` → `fs-access.ts` → `virtual-sessions.ts`): transcript を `projects/` から引いて cwd を得る
- セッションの検索 (`session-search.ts`): `projects/` を読む。選べる config dir は検出した物に限られるので、偽物は選択肢から消える
- セッションの終了・再起動 (`session-kill.ts`): 受け持つ config dir (`servedConfigDirs` 経由) の `sessions/` を読む
- CLI の `dump` (`packages/cli/src/index.ts`): `projects/` を読む
