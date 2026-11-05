---
title: webui の Timeline がライブ更新されない (daemon は transcript relay で gave up を出す)
status: open
category: bug
created: 2026-11-05T15:30:00+09:00
last_read:
open_entered: 2026-11-05T15:30:00+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered:
discard_reason:
pending_reason:
close_reason:
blocked_by:
origin: kawaz 2026-11-05
---

# webui の Timeline がライブ更新されない (daemon は transcript relay で gave up を出す)

## 概要

module のあるセッションの Timeline で、新しい prompt もその返事も、別の URL へ移って戻るか reload するまで出ない (kawaz 2026-11-05)。同じ頃の実 daemon の log に `transcript relay: gave up waiting sid=<sid> rows=N after 5000ms` が多数出ていた。

## 分かっていること

調べた記録: [findings](../findings/2026-11-05-relay-gave-up.md)

- gave up の原因: Claude Code (2.1.318) は response の content block を完了ごとに `session.append` に流し、jsonl には response の stream の終わりにまとめて書く。後ろに長い block が続く block の行は 5 秒を超えて書かれず、daemon が待ちを止める。行は response の最後の block の push で読まれるので、webui に届く時刻はファイルに書かれた時刻と同じで、行は失われない
- TL がライブ更新されない件は隔離環境で再現していない (findings §4 の 6 条件で全部 live だった)。実 daemon の trace では、購読のある間は行を欠けなく送っていて、欠けは購読者 0 の区間だけ (7ab56c6d の 05:27:44〜05:28:45、ws は閉じていない、その後 kawaz が reload)

## 残っていること

- kawaz の再現条件 (見ていたセッション、ブラウザ、直前の操作、止まっている間に TL の下のミニパネルは動いていたか)
- daemon が `transcript_subscribe` / `transcript_unsubscribe` を log に残さないので、購読の欠けとタブの画面を突き合わせられない
- webui は `transcript_subscribe` の失敗を握りつぶし、接続か画面が変わるまで再試行しない
- gave up の log の扱い (待った uuid を書くか、水準を下げるか)
