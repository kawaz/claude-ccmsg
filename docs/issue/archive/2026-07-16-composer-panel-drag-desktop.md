---
title: floating composer panel をデスクトップ限定でドラッグ移動可能にする
status: discarded
category: request
created: 2026-07-16T16:38:08+09:00
last_read:
open_entered: 2026-07-16T16:38:08+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered: 2026-07-16T16:41:21+09:00
resolved_entered:
discard_reason: ["kawaz 裁定 (r26 mid=18+19): D&D 移動は「とりあえず無しでよい」。viewer 末尾余白 (commit 1d0b9970) で対応、D&D は実装コスト大のため見送り確定。"]
pending_reason:
close_reason: ["discarded"]
blocked_by:
origin: 自リポ TODO
---

# floating composer panel をデスクトップ限定でドラッグ移動可能にする

## 概要

Room / 1on1 の floating composer panel (メッセージ入力フォーム) を、デスクトップ環境限定でドラッグ移動できるようにする。

## 背景

kawaz のレビュー (r26 mid=16+17) より: コードを見ながらメッセージを書く際、floating な composer panel が確認したい対象を隠してしまう。ドラッグで一時的に退避できると解消する。

- **スマホは対象外**: mid=17 で「動かれても困る」との指摘あり。タッチ操作でドラッグは不採用
- 実装は `pointer: fine` (mouse 系デバイス) 限定で判定する
- 移動後の位置を session 中だけ保持するか、`localStorage` で永続化するかは設計時に判断する
- 関連: viewer 末尾の余白を 12rem に広げる対応 (commit 1d0b9970) が既に入っており、これで panel の被り問題がどこまで緩和されるか実機評価してから、本 issue の優先度を判断する

## 受け入れ条件

- [ ] `pointer: fine` なデスクトップ環境で composer panel をドラッグして任意位置に移動できる
- [ ] タッチ操作 (スマホ等) ではドラッグ機能が無効化されている
- [ ] 移動後の位置保持方式 (session 揮発 / localStorage) を設計時に決定し実装
- [ ] commit 1d0b9970 (viewer 末尾余白 12rem) の効果を実機評価し、本対応の優先度を再判断済み
