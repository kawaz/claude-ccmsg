---
title: "DR の本文の食い違いの残り (DR どうしの食い違い 2 件と、古いままの記述)"
status: open
category: task
created: 2026-11-25
origin: "自リポ TODO (DR の本文を実装に合わせた作業で残ったもの)"
---

# DR の本文の食い違いの残り

DR-0002・DR-0029・DR-0035・DR-0039 の本文を実装に合わせた時に、範囲の外として残したもの。

## DR どうしの食い違い (どちらが正しいかを決める必要がある)

- **tool `permit` が daemon を起こすか**: DR-0046 §6 は「tool は daemon を起こさない。起こすのはセッションの開始と人の CLI だけ」と書く。DR-0040 §1 と実装 (`hooks/tools.ts` の `PERMIT_TIMEOUT_MS`、`sidecar permit` は ensureDaemon を通る) では、tool `permit` が daemon を起こし、古ければ置き換える。DR-0002 の本文は実装のとおりに書いてある
- **tool の field の説明**: DR-0040 §1 は「field の説明は付けない」と書くが、同じ DR の §6 (voice「日本語」) と §12 (project_permissions)、実装は説明を付けている

## 古いままの記述

- DR-0039 Consequences「daemon が立つ契機は module の `session.start` と人の CLI」に、`/clear`・`/resume` と permit が抜けている
- DR-0039 Consequences の transcript path の項が「今は SessionStart の command hook が…state file に書き」のまま
- DR-0039 §2 の表の「実装時に確認する」が 3 か所残っている (daemon start の所要、stream の最中の Enter、error 欄の語彙と retry)。答えは「前提の確認」の後の段にある
- DR-0039 §2 の表の 1 行目の「ws / branch は bump-semver」。今の state file に ws は無い
- DR-0039 §4「サブコマンドごとの最終の振り分けは実装時に行い」、§5「文面は実装時に決める」がそのまま
- DR-0035 §4「SessionStart の案内」: 案内は今は `prompt.submit` の時の append (DR-0039 §5)
- DR-0035 §5 の中の食い違い: 「`queued_command` 行は model に届いた時点で現れる」と書く一方で、照合の段は「queued_command の時刻は enqueue の時」と書く
- DR-0029 の本文 (追補の前の段) に文中の改行が残っている
- コードのコメント: `hooks/register.ts` の concern 一覧の「tools.ts the send / say / peers / launch tools」に permit / comment_reply が無い。`packages/cli/src/index.ts` の 3 行目「Every command except `daemon run` goes through ensure-daemon」は、status / stop / secret / サイドカーと合わない
- README は btw の説明にだけ Claude Code の最低版 (2.1.330) を書く。DR-0060 では、それより古い版では module ごと読み込まれない

## 別件 (上流のツール)

kawaz 製の `docs-lint` が、issue を archive へ移した直後・commit の前に走らせると、`KeyError: PosixPath('docs/issue/<移す前のパス>')` (`kind_for`) で exit 1 になった。追跡しているファイルの一覧を `git ls-files` と `jj file list` のうち長い方から採るので、jj の workspace の git の index に移す前のパスが残っていると、そちらが採られる。commit して index が更新された後は通った。上流への起票は未了。
