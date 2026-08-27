---
title: idle 通知購読機能 (notify_when_idle 相当) の ccmsg 導入検討
status: idea
category: design
created: 2026-08-27T11:31:51+09:00
last_read:
open_entered:
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

# idle 通知購読機能 (notify_when_idle 相当) の ccmsg 導入検討

## 概要

ネイティブ SendMessage の `notify_when_idle` 相当を ccmsg にも導入する検討。
kawaz r151m28「idle通知に関してはhookとかと連動させてccmsg側でも取り入れられそう」。

## 背景

案: Stop hook (ターン終了) を「セッションが idle になった」シグナルとして
daemon に上げ、`ccmsg notify --on-idle <sid>` のような一回限り購読 op を作る。
購読者には subscribe stream (または SendMessage 経由) で 1 回だけ通知する。

ネイティブ側の仕様 (one-shot、寿命付き、exit でも発火) は
`docs/findings/2026-08-27-native-cross-session-messaging-vs-ccmsg.md` を参照。

面越え (別 CLAUDE_CONFIG_DIR) でも効くのが ccmsg 版の存在意義。

## 受け入れ条件

- [ ] Stop hook 連動の idle シグナル送出方式を決定
- [ ] 購読 API (one-shot / 寿命 / exit 時発火) の仕様を DR 化
- [ ] 面越え動作を実機検証

## TODO

優先度低・アイデア段階、着手時期未定。
