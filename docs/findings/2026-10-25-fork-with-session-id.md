# fork に `--session-id` を併用して、新しいセッションの id を起動する側が先に決められるか

- Date: 2026-10-25
- 対象: Claude Code 2.1.309
- 動機: MCP tool `launch` ([DR-0018](../decisions/DR-0018-session-launcher.md)) は `new` と `fork` で daemon が UUID を生成して起動コマンドに渡し、その id を response で返す。`fork` で `--resume <sid> --fork-session` に `--session-id <uuid>` を足して効くか、`--resume-session-at` と併用できるかで、fork の id を hello 待ちにせず返せるかが決まる
- 方法: 一時ディレクトリに `CLAUDE_CONFIG_DIR` / `HOME` / `TMPDIR` / cwd を置き、`env -i` で `PATH` / `TERM` / `DISABLE_AUTOUPDATER` 以外の環境変数を落として `claude` を起動した。認証情報は無いので、model の応答が要る prompt は `Not logged in · Please run /login` の assistant 行で終わり、API の呼び出しは起きない (`duration_api_ms: 0`)。`-p` は `--output-format json` の `session_id` と、config dir の `projects/<cwd の slug>/` に増えた transcript のファイル名・中の行の `sessionId` で判定した。対話は端末の proxy の下で起動し、画面のダンプと transcript で判定した。元のセッションは `-p --session-id <S> 'hi'` で作った (user 行 1 つ + `Not logged in` の assistant 行 1 つ)

## 判明した事実

- **`--resume <sid> --fork-session --session-id <uuid>` は効く**。`-p` でも対話でも、新しいセッションの id は指定した uuid になり、transcript は `<uuid>.jsonl` で作られ、中の行の `sessionId` もすべてその uuid。元のセッションの transcript は変わらない
- **`--resume-session-at <record uuid>` も併用できる (`-p` のみ)**。`-p` では指定した record までで切り詰めた fork が指定した uuid で作られた。対話では `--resume-session-at` は黙って無視され、先端までの全部が fork された (エラーにはならない)
- **`--continue --fork-session --session-id <uuid>` も効く** (`-p`)。fork 元はその cwd の最も新しいセッション
- **fork でない `--resume` / `--continue` に `--session-id` を付けると起動しない**: `Error: --session-id can only be used with --continue or --resume if --fork-session is also specified.` (exit 1、transcript は作られない)
- **既に使われている id を `--session-id` に渡すと起動しない**: 新規でも fork でも `Error: Session ID <uuid> is already in use.` (exit 1)。uuid の形でない値は `Error: Invalid session ID. Must be a valid UUID.` (exit 1)
- **新規の対話起動 `claude --session-id <uuid> <prompt>` も指定した uuid で transcript を作る**
- 末尾が user 行の transcript (user 行で切り詰めた fork を含む) を resume すると、claude は `model: "<synthetic>"` の assistant 行 `No response requested.` を足してから続ける

## 実用的な示唆

- `fork` の新しい id は daemon が先に決めて起動コマンドに渡せる。hello を待って id を知る必要は無い
- fork 地点 (`resume_at`) を指定する fork は対話の一段では成り立たない。`-p` の一段目で `--resume <元> --fork-session --session-id <新> --resume-session-at <地点>` に prompt `/exit` を渡して切り詰め済みのセッションを作り、二段目で `--resume <新>` を対話で起動する。`/exit` は `-p` では `/exit isn't available in this environment.` を返すだけで API を呼ばず (`num_turns: 0`、`total_cost_usd: 0`)、この一段目の所要は 0.6〜0.7 秒だった (3/3、plugin も settings も無い config dir での値)。二段目の `--resume <新>` は fork でないので `--session-id` を付けない (付けると上のエラー)
- fork 地点を指定しない fork は、対話の一段 `--resume <元> --fork-session --session-id <新>` で足りる
- `continue` / `resume` には `--session-id` を渡さない。`resume` の id は元の id のまま変わらない (`-p --resume <id>` の `session_id` は `<id>`、transcript は増えない)
- id の衝突は claude 自身が `already in use` で拒むので、起動コマンドの非零 exit として呼び手に返る。UUID v4 を毎回生成する限り実用上は起きない

## 検証の詳細

### `-p` のマトリクス

元のセッション `S` (user 行 `U` と assistant 行 `A`)。prompt は `/exit`、`--output-format json`。

| 引数 | exit | stdout の `session_id` | 増えた transcript | 中身 |
|---|---|---|---|---|
| `--resume S --fork-session --session-id N1` | 0 | N1 | `N1.jsonl` | `U`, `A` と system 行。全行の `sessionId` が N1 |
| `--resume S --fork-session --session-id N2 --resume-session-at U` | 0 | N2 | `N2.jsonl` | `U` と system 行 (`A` は無い)。全行の `sessionId` が N2 |
| `--continue --fork-session --session-id N3` | 0 | N3 | `N3.jsonl` | 直前に作られた N2 の中身 + synthetic assistant 行 |
| `--resume S --session-id N4` (fork なし) | 1 | (なし) | なし | stderr `Error: --session-id can only be used with --continue or --resume if --fork-session is also specified.` |
| `--resume S --fork-session` (対照) | 0 | 新しい uuid | `<その uuid>.jsonl` | `U`, `A` と system 行 |
| `--session-id S` (新規、既存 id) | 1 | (なし) | なし | stderr `Error: Session ID S is already in use.` |
| `--resume S --fork-session --session-id N1` (N1 は既存) | 1 | (なし) | なし | stderr `Error: Session ID N1 is already in use.` |
| `--resume S --fork-session --session-id not-a-uuid` | 1 | (なし) | なし | stderr `Error: Invalid session ID. Must be a valid UUID.` |
| `--resume N2` (fork なし、id 指定なし) | 0 | N2 | なし | N2 に synthetic assistant 行が足された |

`S` の transcript の user / assistant 行は、fork の前後とも 2 行のままだった。

### 対話

prompt `hi` を位置引数で渡した。fresh な config dir なので theme の選択と workspace の trust ダイアログが出た (前者は `.claude.json` の `hasCompletedOnboarding` で飛ばし、後者は Yes を選んだ)。

| 引数 | transcript | 中身 |
|---|---|---|
| `--session-id N6 hi` | `N6.jsonl` | user `hi` と `Not logged in` の assistant 行。`sessionId` は N6 |
| `--resume S --fork-session --session-id N7 --resume-session-at U hi` | `N7.jsonl` | `U`, `A` (切り詰められていない)、新しい user `hi` と assistant 行。`sessionId` は N7 |

### 観測の外にあるもの

- 認証のある環境で model が応答した後の id の扱いは見ていない。id の割り当てと transcript の作成は応答の前に確定していた
- 一時の `HOME` で起動した対話の claude は、その `HOME` に更新を入れ、URL handler の app を作って LaunchServices に登録した (どちらも一時ディレクトリの中。登録は検証の後で外した)。以降の対話は `DISABLE_AUTOUPDATER=1` で起動した
