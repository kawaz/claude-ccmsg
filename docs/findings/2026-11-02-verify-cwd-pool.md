# 試験用の信頼済み cwd プール (`scripts/verify-cwd.ts`)

実 config dir (ログイン済み) で本物の claude を起こす試験は、config dir に seed を書けないので、信頼を登録済みの固定 cwd を使う。プールは `~/.local/state/ccmsg/tmp-test-trusted-dirs/NN` (`01`〜`50`)。名前は「テスト用に予約してあるだけで、消してよい」ことを示す。

## 観測 (claude v2.1.316、2026-11-02)

実機のプールを `acquire` で作り (root は存在しなかった)、`register` の出力を隔離 config dir に写して、初めての `NN` で `claude --model haiku` を tmux (`-x 120 -y 30`) で起動し `capture-pane` で見た。実 config dir の `.claude.json` には書いていない。

| # | cwd | 隔離 config dir の `.claude.json` | 画面 | `git rev-parse --show-toplevel` (cwd で) |
|---|---|---|---|---|
| 1 | `tmp-test-trusted-dirs/01` | `register` の出力 (seed `{theme, hasCompletedOnboarding}` + 50 個の `projects[...].hasTrustDialogAccepted`) | prompt 待ち (`❯`)、ダイアログ無し | `.../tmp-test-trusted-dirs/01` |
| 2 | `tmp-test-trusted-dirs/02` | seed のみ (projects 無し) | `Quick safety check` の信頼ダイアログ | `.../tmp-test-trusted-dirs/02` |
| 3 | `tmp-test-trusted-dirs/03` | #1 と同じ | prompt 待ち (`❯`)、ダイアログ無し | `.../tmp-test-trusted-dirs/03` |

- root (`tmp-test-trusted-dirs`) は commit の無い repo (`git init` のみ) で `.gitignore` が `*`。`rev-parse --show-toplevel` が root 自身、`git status --porcelain --untracked-files=all` は空 (配下の NN や lock が untracked に出ない)
- 起動後の `NN` の中身は `.git` のみ (claude は cwd にファイルを作らなかった)
- `~/.local/state` は symlink ではなく、realpath は `$HOME/.local/state/...` のまま

## 実 config 向けの `register`

`register` を実 config dir (`$CLAUDE_CONFIG_DIR/.claude.json`) に対して走らせ、元のファイルの md5 が前後で変わらないこと、出力は `projects` に 50 件足しただけで他の key と既存の project は同一であること (`jq -S` の diff) を確かめた。

実 config の `.claude.json` は動いているセッションが随時書き換えるので、出力は適用の直前に作る (古い出力を写すと、その間の書き込みを失う)。

## 並行 acquire

root が無い状態から 2 つ同時に `acquire` しても別番号が返り、root は 1 つの repo になる (`scripts/verify-cwd.test.ts`)。root の repo は scratch dir で作ってから `.git` を rename(2) で置くので、負けた側の rename は既存の `.git` で失敗し、半端な repo は見えない。
