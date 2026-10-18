---
title: sidecar が hello して名乗る形で harness 死亡後に幽霊 peer が残るおそれ
status: resolved
category: bug
created: 2026-10-14T17:40:26+09:00
last_read: 2026-10-18T15:30:20+09:00
open_entered: 2026-10-14T17:40:26+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-10-18T16:11:13+09:00
discard_reason:
pending_reason:
close_reason: ["done: 実機で再現。daemon 停止中に harness が死ぬと sidecar が次の daemon に死んだ sid を名乗り直し、peers に no_module の幽霊行が残った。sidecar が stdout の socket の EOF で harness の死を知って去る形に修正 (commit nuwytorn)。(1) の last_activity_at 更新は実害が小さいと判断し変更なし"]
blocked_by:
origin: 自リポ TODO
---

# sidecar が hello して名乗る形で harness 死亡後に幽霊 peer が残るおそれ

## 概要

sidecar が session として hello して名乗る形 (v0.169.0、sidecar_hello) の副作用 2 つ (sidecar-announce worker が未検証と報告)。

1. daemon を再起動すると sidecar が繋ぎ直して名乗り直すので、全セッションの `last_activity_at` が再起動時刻になる (subscribe の再接続と同じ挙動)。
2. harness (claude) だけが死んで sidecar プロセスが残った場合、daemon 再起動後に名乗り直してそのセッションが幽霊の peer 行として残るおそれ。

(2) は agents poll が「harness が gone」と判定して run を外す経路 (`dropped: its harness is gone`) で回収されるはずだが、config_dir 無しの run や poll 間隔の間は残る。

## 背景

DR-0035 §3 のサイドカー名乗り実装 (sidecar_hello、run id、接続の生存) の未検証事項。

## 受け入れ条件

- [x] 実機で (1) (2) を再現し、残るかを確認する
- [x] 残るなら sidecar 側で親プロセスの死を検知して自分で終了する (stdin の EOF 等) 形を足す
- [ ] (1) が問題なら `last_activity_at` を名乗り直しで更新しない形を検討する
