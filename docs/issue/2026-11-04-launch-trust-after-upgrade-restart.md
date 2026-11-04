---
title: upgrade で起きた daemon を通した launch で、launch command の trust ダイアログ自動承認が効かない
status: open
category: bug
created: 2026-11-04T21:00:00+09:00
last_read:
open_entered: 2026-11-04T21:00:00+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered:
discard_reason:
pending_reason:
close_reason:
blocked_by:
origin: 自リポ TODO
---

# upgrade で起きた daemon を通した launch で、launch command の trust ダイアログ自動承認が効かない

## 概要

`launch` で初めての cwd にセッションを立てると、launch command (kawaz の `~/bin/itumono-run-claude.sh`) が `hyoui input` で行う trust ダイアログ (`Quick safety check`) の自動承認が効かず、ダイアログで止まることがある。11-04 に 3 回、10-28 に 2 回。どれも plugin 更新の upgrade で起きた daemon を通した launch で、`ccmsg daemon restart` で起こし直した直後の daemon を通すと通った。launch command は exit 0 で終わり、stderr は direnv の 2 行だけ。

観測と表は [findings](../findings/2026-11-04-upgrade-restart-launch-env.md)。

## 分かっていること

- 抜けたのはスクリプトの最後の段 (Yes 送信: `key:Down` → `wait:"❯ Yes, I trust"` を 2 秒 → Enter、stderr は捨てている)。罫線待ちは通っている。止まった回は通った回より launch が約 2 秒長く、ダイアログは描かれていたが `key:Down` で選択が動かなかった
- upgrade 経路と restart 経路は同じ `spawnDaemon` を通り、daemon が継ぐのは spawn した CLI の env だけ (stdio は `/dev/null`、自分の process group、制御端末なし)。隔離 daemon を シェル / upgrade / `just` の upgrade レシピの 3 経路で起こして計 18 回 (うち 6 回は起動 31 分後) 流し、すべて通った
- 止まった daemon と通った daemon は、どちらも同じ Claude Code セッションの Bash tool から起きている (`just push` の `_local-daemon-upgrade` と `ccmsg daemon restart`)
- 罫線の直後に送った `key:Down` は、claude が入力を受け付け始める前だと捨てられる (2 秒待っても `❯ No, exit` のまま)。隔離環境で罫線の直後に送ると、sandbox-exec ラッパー経由の claude で 15 回中 12 回、素の claude で 40 回中 3 回捨てられ、50 ms 置くと全部通った。止まった launch の画面はこれと同じ形
- `wait:"❯ No, exit"` を挟んでも防げない (15 回中 12 回捨てられた)。Down を送って `❯` が動くのを短く待ち、No のままなら送り直すと 15 回すべて通った
- 実データで失敗と成功を分けているのは daemon の起動からの経過時間だけ (失敗は 31〜88 分後、成功は 14〜18 秒後)。標本は失敗 5 回 / 成功 2 回

## 原因

仕組みは、launch command が罫線の出現を「キーを受け付ける」合図に使っていて、claude が入力を受け付け始める前に送った Down が捨てられること (観測で確認)。実 daemon で止まった回では罫線から送信まで 0.1〜0.2 秒空いていたのに捨てられており、なぜその daemon を通した時だけ入力の受け付けが遅れたのかは未特定。

「upgrade 経路で daemon の env / stdio / process group が fresh spawn と違う」は、経路を変えた再現で差が出ず、止まった daemon と通った daemon の起こし手も同じだったので支持されない。そのため daemon 側の修正 (upgrade 経路の env の正規化など) は入れていない。観測した差分の無い修正は、効いたかどうかを確かめられない。

## 次の観測

止まる daemon が出たら、restart する前にその daemon を通して:

1. launch command の Yes 送信の `hyoui input` の stderr と rc、送った直後と 2 秒後の screen dump を残す
2. その daemon の `ps -E`、`lsof -p`、起動からの経過時間を残す
3. 同じ daemon で何回か流して毎回止まるかを見る

経過時間の仮説は、restart 直後に通ることを確かめた daemon で、30 分以上経ってからもう一度流して確かめる。

## launch command 側への提案 (kawaz のスクリプト、リポ外)

- Yes 送信を「Down → `❯` が Yes に動くのを短く待つ → No のままなら Down を送り直す → 動いたら Enter」にする (隔離環境の sandbox-exec ラッパー経由で 15 回中 15 回通った)
- Yes 送信の `2>/dev/null` を外して stderr を launch の返事に残す (今は失敗の段が返事から分からない)
- 自動承認できずに `exit 0` する分岐で、その時の tail10 を stderr に出す
