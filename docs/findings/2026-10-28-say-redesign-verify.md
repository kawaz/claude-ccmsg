# say を tool の発声・transcript の表示・daemon の未読に分けた形を実機で確かめた (不採用の案 B の実装での観測)

**この記録は不採用になった案 B の実装での観測**。その形は、module が発声して、hook が `ccmsg sidecar say-mark` で未読のマーカーを daemon に知らせるもの。kawaz 2026-10-28 の裁定で DR-0045 は次の構造に変わり、この実装は作業コピーから戻した。
- module は会話の行を daemon に流すだけ
- daemon が行を正本として発声・既読を持つ

残しておくのは、構造に依らず生きる事実のため:
- `/usr/bin/say` の `--`
- 辞書の適用と、読めない行の扱い
- TL の 🔔 を transcript から描くこと
- 既読の集合を state dir に持って再起動を越えること
- 旧版 CLI の op `say` が断られても音は鳴ること
- tool から daemon を起こす副作用

- Date: 2026-10-28
- 対象: Claude Code 2.1.312、ccmsg の作業コピー (v0.205.0 の上の DR-0045 の実装)
- 動機: DR-0045 の案 B の経路を本物の claude で通して、次を見る
  - module が発声と辞書の適用をすること
  - TL の 🔔 が transcript の tool_use から描かれること
  - マーカー (`ccmsg sidecar say-mark` → op `say_mark`) と既読 (`say_read`) が daemon の再起動を越えて残ること
- 方法:
  - daemon: 作業コピーの `packages/daemon/src/index.ts --foreground` を起動した。`CCMSG_STATE_DIR` / `CCMSG_CONFIG_DIR` / `CCMSG_DATA_DIR` / `HOME` は一時ディレクトリに向け、`CCMSG_CLAUDE_CONFIG_DIRS` では試験用の config home だけを名指した (verify skill の手順)
  - 試験セッション: 一時ディレクトリの config home と空の作業ディレクトリで起動した
    - 起動オプション: `--name "🤖ccmsg-verify-say" --plugin-dir <このリポ> --model sonnet --permission-mode default`
    - 環境: daemon と同じ `CCMSG_*` と、発声を記録する `CCMSG_SAY_BIN` を渡した。継いだセッションの変数は `env -i` で落とした
    - 起動の場所: 専用 socket の tmux の中
  - model の応答: Messages API の代役 (reference `claude-mods/lab-setup`) が返した
    - prompt に `SAYTOOL<<本文>>` があれば `mcp__ccmsg-v1__say` の tool_use (`{ text: 本文 }`) を返す
    - `PERMITTOOL` があれば `mcp__ccmsg-v1__permit` の tool_use を返す
    - tool_result の後は `done` を返す
  - 発声の binary: 引数を 1 行ずつファイルに足すだけの shell script (`CCMSG_SAY_BIN`)。音は鳴らしていない
  - 読み上げ辞書: `<config dir>/say-dictionary.tsv` に `Fable<TAB>フェイブル` と、タブの無い行 `broken line` を置いた
  - webui: daemon の HTTP を `playwright-cli` の 1 つのブラウザ session の 2 つのタブで開き、同じセッションの Timeline を見た

## 判明した事実

| 場面 | 操作 | 結果 |
|---|---|---|
| say の発声と辞書 | `SAYTOOL<<Fable の daemon が終わった 1 件目>>` | 発声の binary の引数は `-- フェイブル の デーモン が終わった 1 件目`。ファイルの語 (Fable) と同梱の語 (daemon) が置き換わり、本文は `--` の後 |
| 読めない辞書の行 | 同上 | tool の結果は `伝えた (音声)` の後に「読み上げ辞書の次の行を飛ばした」と `<file>:2: an entry is \`word<TAB>reading\`, one tab between them — line skipped` |
| `-` で始まる本文 | `SAYTOOL<<-v は声の指定、2 件目>>` | 引数は `-- -v は声の指定、2 件目` (say のオプションとして読まれない) |
| マーカー | 上の 2 回 | `<state dir>/say-marks.json` に `markers` が 2 件 (session_id、tool_use_id、daemon が受けた ts)、`read` は空 |
| TL の 🔔 | Timeline を開く | 書かれた原文 (`Fable の daemon …`、辞書の置き換えの前) の 🔔 バブルが 2 つ。古い方は「既読」、新しい方は「2 件すべて既読」。Sessions 一覧の行は `🔔2` |
| 1 件だけ既読 | 2 つ目のタブで古い方の「既読」 | 両方のタブで古い方が 🔕 と「既読」(押せない表示) に、新しい方のボタンが「既読」に、Sessions 一覧が `🔔` に変わった。ファイルの `read` に古い方の id が入った |
| daemon の再起動 | `daemon stop` → 起動し直す | 再読み込みしたタブでは、古い方が 🔕、新しい方が 🔔 のままで、Sessions 一覧も `🔔`。再読み込みしていないタブも繋ぎ直して同じ表示だった |
| 再起動の後の既読 | 再読み込みしていないタブで「既読」 | 両方のタブで 🔕 に変わり、Sessions 一覧の印が消えた |
| すべて既読 | 新たに 2 件言わせ、新しい方の「2 件すべて既読」 | 2 件とも 🔕 に変わり、Sessions 一覧の印が消えた |
| 許可依頼の音声 | `PERMITTOOL` | tool の結果は `許可依頼を出した` (と、飛ばした辞書の行)。発声の binary の引数は `-- 許可を求めています` |
| daemon が居ない時の say | daemon を止めて `SAYTOOL<<daemon 無しの 6 件目>>` | 発声された (`-- デーモン 無しの 6 件目`)。tool の結果は `伝えた (音声)`。debug log に `ccmsg: say-mark exited 3: ccmsg sidecar say-mark: no daemon is running`。daemon は起きていない (state dir に `daemon.sock` が無い) |
| 旧版 (v0.202.0) の CLI の `ccmsg say` | 新しい daemon に対して起こす | 発声された (exit 0)。daemon.log に `request say from <sid> refused: op: unknown op: say` |

## 実装を変えた所見

最初の実装の `sidecar say-mark` は、他の tool の内部コマンドと同じ `ensureDaemon` で daemon を起こしていた。daemon を止めた状態で say を呼ぶと、CLI が daemon を起こした。起きた daemon は試験セッションの環境で立ち、既定の HTTP の port (8642) を bind できずに `failed to bind http 127.0.0.1:8642` を出した。

発声に添える印のために daemon を起こさないよう、動いている daemon にだけ送る形 (`connectIfRunning`、居なければ exit 3) に変えた。上の表の「daemon が居ない時の say」は変えた後の観測。

## 未検証

- 本物の `/usr/bin/say` の音 (この試験の発声は記録用の script)。`/usr/bin/say -o <file> -- "-v テスト"` が本文を音声のファイルに書くことは別に確かめた (DR-0045 §1)
- subagent からの say (印を付けない分岐)。module の単体テスト (`hooks/register.test.ts`) でだけ確かめた
- model が本物の時の tool_use の id の形。試験の id は代役が付けた `toolu_t<epoch ms>`。実 transcript の id は `toolu_01…` の形で、照合は id の形に依らない

## 再現の材料 (docs-lint、統括への報告用)

colocated の jj リポで、commit 前にファイルを `mv` (例: `docs/decisions/DR-X.md` を `archive/` へ) して `just docs-lint` を走らせると、`git ls-files` に旧パスが残る。そのため docs-lint は `KeyError: PosixPath('docs/decisions/DR-X.md')` (`texts[path]` の行) で落ちる。`jj commit` の後は出ない。
