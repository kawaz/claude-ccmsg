---
title: verify の隔離 daemon に実行中の実セッションが繋がる
status: open
category: bug
created: 2026-10-10T12:47:26+09:00
last_read:
open_entered: 2026-10-10T12:47:26+09:00
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

# verify の隔離 daemon に実行中の実セッションが繋がる

## 概要

`/verify` skill (`.claude/skills/verify`) の手順で隔離 daemon (`CCMSG_STATE_DIR` 等を一時ベースに向け `CCMSG_HTTP_BIND=127.0.0.1:18642`) を立てると、実行中の実セッション (claude-ccmsg、hyoui 等) が connected として現れる。隔離が完全でない。原因を特定し、隔離 daemon には擬似セッションだけが繋がるようにする。

## 背景

2026-10-10 に transcript スキーマの段 A・B の worker が観測した。hooks module か CLI が socket のパスを state dir 以外から解決している可能性がある (未確認の仮説)。害の有無も未確認 (実セッションへ隔離 daemon 経由のメッセージが届く / 実 daemon 側の状態が汚れる等)。

## 受け入れ条件

- [ ] 実セッションが隔離 daemon に繋がる原因を特定する (socket パス解決の経路を hooks module / CLI の両方で確認)
- [ ] 隔離 daemon には擬似セッションだけが繋がる
- [ ] 害の有無 (実セッションへの誤配、実 daemon の状態汚染) を確認して記録する
- [ ] 再発防止の検証手順 (verify skill) を更新する
