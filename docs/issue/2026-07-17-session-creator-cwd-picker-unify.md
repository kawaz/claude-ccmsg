---
title: SessionCreator の cwd 選択 UI を統合
status: open
category: task
created: 2026-07-17T22:21:34+09:00
last_read:
open_entered: 2026-07-17T22:21:34+09:00
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

# SessionCreator の cwd 選択 UI を統合

## 概要

SessionCreator の cwd 選択 UI で「cwd 手入力欄」と「CwdTree の検索フィルタ欄」が別々に存在し冗長。選択済みでもツリーが常に表示されっぱなしになっている。以下の統合を行う (kawaz 裁定 2026-07-17):

1. 入力欄を 1 つに統合し、入力すると部分一致でツリーが絞り込まれる (検索兼用)
2. リストから選択したら確定し、ツリーを畳んで cwd を確定テキスト表示に切替
3. 確定表示の横に編集ボタン (✎ 等) を置き、押すと選択モード (入力 + ツリー) に戻る
4. 選択済み状態をフォームのデフォルト表示にする (ツリーは選択モード中のみ表示)

## 背景

現状の UI は入力欄が二重で、選択後もツリーが出っぱなしのため画面が冗長になっている。SessionCreator.tsx / CwdTree.tsx の UI 状態遷移の整理が必要。

コマンドプレビュー workflow (wf_89c77eac、SessionCreator 編集中、docs/issue/2026-07-17-session-creator-command-preview.md) と同一ファイルを触るため衝突を避け、その完了後に着手する。

## 受け入れ条件

- [ ] cwd 入力欄が 1 つに統合され、部分一致でツリーが絞り込まれる
- [ ] ツリーから選択すると確定表示 (テキスト + 編集ボタン) に切り替わる
- [ ] 編集ボタンで選択モード (入力 + ツリー) に戻れる
- [ ] フォームの初期表示は確定表示 (デフォルトで選択済み cwd がある場合)
- [ ] コマンドプレビュー workflow (wf_89c77eac) 完了後に着手する
