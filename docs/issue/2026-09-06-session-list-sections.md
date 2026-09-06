---
title: セッション一覧のセクション再設計 (Paused / Disappeared / 生存統合)
status: open
category: design
created: 2026-09-06T19:57:35+09:00
last_read:
open_entered: 2026-09-06T19:57:35+09:00
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

# セッション一覧のセクション再設計 (Paused / Disappeared / 生存統合)

## 概要

kawaz 裁定 (2026-09-06 r278) を反映したセッション一覧のセクション構成:

1. **セクション名は英語**。意図して止めた行 (旧「Stopped」案、SS-Q1 = a+c) は
   **Paused**、daemon が見失った行 (旧「前回稼働中」) は **Disappeared** の
   2 セクション (Exited は「復帰予定」が伝わらないので不採用)。
2. **Busy と Idle は分けない**。「生きているセッション」1 セクションに混ぜ、
   最終活動順で並べる (SS-Q2 β = b)。処理中は行のマークで示す。
3. **「ccmsg 未起動」セクションは廃止**。ccmsg の有無は分類・並びに使わず
   行のマークで示す: 接続待ち (過去に接続を見ていない) / 途絶
   (`last-live-sessions.json` に居る)。ccmsg も hyoui も無い行は
   「Busy (管理外)」として生存セクションの直後。
4. **Busy/Idle (活動中か) の判定元**は llm-gateway の request/response
   イベント (issue `session-status-from-sessions-json` に依存)。

想定並び順: Pinned → Waiting (dialog/error) → 生存 (最終活動順、管理外は
その後) → Paused → Disappeared。

SS-Q1 の実装内容 (`last-live-sessions.json` への `stopped_at`、
`session_kill` の `retain: true`、前回稼働中→Paused ボタン) は維持。

## 受け入れ条件

- [ ] セクションを Pinned / Waiting / 生存 (Busy+Idle 統合、最終活動順) /
      Paused / Disappeared の構成に再設計
- [ ] 「ccmsg 未起動」セクションを廃止し、行マークに置き換え
      (接続待ち / 途絶 / 管理外)
- [ ] `last-live-sessions.json` のエントリに `stopped_at` フィールドを追加
- [ ] Busy の Status に一時停止ボタン (`session_kill` に `retain: true`) を追加
- [ ] 前回稼働中の行に「Paused へ移す」ボタンを追加
- [ ] Paused / Disappeared エントリが消える条件 (同 sid 再接続 / ✕) の実装
- [ ] Busy/Idle 判定は `session-status-from-sessions-json` の実装完了後に接続
