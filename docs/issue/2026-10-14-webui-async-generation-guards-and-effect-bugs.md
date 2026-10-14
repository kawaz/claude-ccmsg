---
title: webui の非同期応答の世代ガードと Effect 起因の bug 群
status: open
category: bug
created: 2026-10-14T13:51:28+09:00
last_read: 2026-10-14T14:51:25+09:00
open_entered: 2026-10-14T13:51:28+09:00
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

# webui の非同期応答の世代ガードと Effect 起因の bug 群

## 概要

`docs/findings/2026-10-14-webui-hooks-review-react-guidance.md` の high 6 件と medium 3 件をまとめて直す。

high:

1. `FileTree.tsx:627-640`: お気に入りが初回 mount の空配列保存で消える。保存を handler へ移し、root 境界は key で分ける。
2. `App.tsx:331` / RoomView / Composer: room 切替時に下書きが残り誤送信しうる。`room.id` を key にする。DR-0036 段 C で room の書き込みが消えるなら段 C で解消する。
3. Timeline / store: agent A から B へ切り替えた時、A の古い transcriptRead 応答が B を上書きする。
4. FileViewer / store: fs_read 応答に世代が無く、古い応答が現表示を上書きする。
5. RoomView: `#room-mNN` 直リンクが初回ロードで着地しない。
6. CwdTree: lazy dirTree 応答に世代ガードが無く、フィルタ変更後に旧 children が混入する。

(3)(4)(6) は非同期応答の世代ガードを 1 つの helper (AbortController か generation token) に共通化して直す。

medium:

- 時刻ベース (0/60/300/1000ms) の自動スクロール反復を、CSS scroll anchoring + ResizeObserver に置き換える。
- Composer の親通知 Effect を handler へ移す。
- UsageStats の period 切替を keyed component にする。

## 背景

webui client の第三者レビュー (findings 参照) で、Effect の使い方と非同期応答の競合に起因する bug が見つかった。

## 受け入れ条件

- [ ] (1)〜(6) がそれぞれ再現手順で再現しなくなっている
- [ ] (3)(4)(6) が共通の世代ガード helper を使っている
- [ ] medium 3 件が反映されている
