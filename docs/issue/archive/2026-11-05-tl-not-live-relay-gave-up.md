---
title: webui の Timeline がライブ更新されない (daemon は transcript relay で gave up を出す)
status: resolved
category: bug
created: 2026-11-05T15:30:00+09:00
last_read:
open_entered: 2026-11-05T15:30:00+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-11-05T17:00:00+09:00
discard_reason:
pending_reason:
close_reason: ["done: kawaz 2026-11-05 裁定。TL 不更新は module が 0.211 より前 (push 無し) のセッションのもので、新 module のセッションでは即時に反映されることを kawaz が確認。gave up は debug に下げ、購読の増減の log と断られた購読の再試行を足した"]
blocked_by:
origin: kawaz 2026-11-05
---

# webui の Timeline がライブ更新されない (daemon は transcript relay で gave up を出す)

## 概要

module のあるセッションの Timeline で、新しい prompt もその返事も、別の URL へ移って戻るか reload するまで出ない (kawaz 2026-11-05)。同じ頃の実 daemon の log に `transcript relay: gave up waiting sid=<sid> rows=N after 5000ms` が多数出ていた。

## 分かっていること

調べた記録: [findings](../../findings/2026-11-05-relay-gave-up.md)

- gave up の原因: Claude Code (2.1.318) は response の content block を完了ごとに `session.append` に流し、jsonl には response の stream の終わりにまとめて書く。後ろに長い block が続く block の行は 5 秒を超えて書かれず、daemon が待ちを止める。行は response の最後の block の push で読まれるので、webui に届く時刻はファイルに書かれた時刻と同じで、行は失われない
- TL がライブ更新されない件は隔離環境で再現していない (findings §4 の 6 条件で全部 live だった)。実 daemon の trace では、購読のある間は行を欠けなく送っていて、欠けは購読者 0 の区間だけ (7ab56c6d の 05:27:44〜05:28:45、ws は閉じていない、その後 kawaz が reload)

## 結論 (kawaz 2026-11-05)

- TL が更新されなかったのは、module が 0.211 より前で push の無いセッション (relay は push を合図に読むので、そのセッションの TL は live にならない)。新 module のセッションでは即時に反映されることを kawaz が確認した
- gave up は Claude Code の書き込みの時機によるもので TL に影響しない

## 入れた変更

- daemon: gave up の log を debug に下げ、待った uuid を書く。`transcript_subscribe` / `transcript_unsubscribe` (接続が閉じた時を含む) を、接続 id・sid・結果・増減後の購読者数で info に書く
- webui: daemon に断られた購読を、そのセッションの peer の行が変わった (登録された、transcript を名乗った) のを合図にもう一度出す
- テスト: response の最後の block の push で、待ちを過ぎて書かれた先の行も欠けも重複も無く届くこと、待ちが止まっても読んだ uuid が残ること (daemon)。断られた購読を peer の行の変化で出し直すこと (webui)
