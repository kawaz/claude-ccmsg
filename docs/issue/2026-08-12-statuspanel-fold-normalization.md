---
title: StatusPanel の details 4 箇所を Fold へ寄せる
status: wip
category: task
created: 2026-08-12T03:34:56+09:00
last_read:
open_entered: 2026-08-12T03:34:56+09:00
wip_entered: 2026-08-12T15:08:22+09:00
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

# StatusPanel の details 4 箇所を Fold へ寄せる

## 概要

StatusPanel.tsx 内の `<details>` 4 箇所 (完了 / ENV / pending / completed) を、他コンポーネントと同じ Fold コンポーネントへ統一する。

## 背景

W3 の Fold 正規化 (v0.99.0) で SessionList / RoomList / SessionRooms / UsageStats は Fold に統一済みだが、StatusPanel.tsx の 4 箇所はスコープ外で未着手のまま残っている。うち ENV の 1 箇所は `onToggle` を持つため、Fold 側に prop 追加が必要になる。

## 受け入れ条件

- [ ] StatusPanel.tsx の 4 箇所 (完了 / ENV / pending / completed) が全て Fold コンポーネントに置き換わっている
- [ ] ENV 箇所の `onToggle` 相当の挙動が Fold で維持されている (必要なら Fold に prop 追加)

## TODO

<!-- wip 時のみ -->

着手 (2026-08-12)。
