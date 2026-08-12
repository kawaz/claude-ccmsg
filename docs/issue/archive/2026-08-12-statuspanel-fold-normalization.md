---
title: StatusPanel の details 4 箇所を Fold へ寄せる
status: resolved
category: task
created: 2026-08-12T03:34:56+09:00
last_read:
open_entered: 2026-08-12T03:34:56+09:00
wip_entered: 2026-08-12T15:08:22+09:00
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-08-12T15:15:25+09:00
discard_reason:
pending_reason:
close_reason: ["done: v0.102.3 で実装。StatusPanel の details 4 箇所 (完了/ENV/pending/completed) を Fold へ置換、Fold に optional onToggle prop を追加 (既存 6 利用箇所は挙動不変)。クラス名・summary・open・key は現状維持"]
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
