---
title: 詰まった翻訳が後続の翻訳を最大 240 s 止め、webui から取り消せない
status: open
category: design
created: 2026-10-18T18:25:44+09:00
last_read:
open_entered: 2026-10-18T18:25:44+09:00
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

# 詰まった翻訳が後続の翻訳を最大 240 s 止め、webui から取り消せない

## 概要

daemon の翻訳サービス (packages/daemon/src/translate-helper.ts) は helper に 1 件ずつ直列で request を送り (sendChain)、詰まった request は watchdog の期限 (60s + 1s/100 文字、上限 240s) で helper を kill して回復する。期限までの間、後ろに並んだ翻訳 (webui が段落ごとに送る op) はすべて待つ。

- 詰まりは実在する: 14.7k 文字の 1 段落が、推論を約 2 分で止めたまま 12 分返らなかった (docs/findings/2026-07-17-macos-translation-poc.md、2026-10-18)
- 期限を短くできないのは、OS 自身の文章解析が on-device モデルを使っている間は 1 文でも最大 30.6 s 待たされ、待ちと詰まりを外から見分けられないため (DR-0023 §7)
- webui には送った translate op を取り消す手段が無い。fold を閉じた・別の session に移ったなど、もう要らない翻訳も daemon の待ち行列に残り、helper の時間を使う

## 論点

- webui から op を取り消す (protocol に cancel を足す、または ws の切断・要求の世代で捨てる) と、daemon がまだ helper に送っていない request を待ち行列から外せる。送った後の request は helper を kill しないと止まらない
- 長い段落を先に送らない / 短い段落を先に処理する等、待ち行列の順序で後続への影響を減らす案
- 詰まりやすい長さ (数千文字以上) の段落を helper に送る前に分ける案 (分けると訳の文脈が切れる)

どれも未検証。採否は裏取りしてから決める。

## 関連

- archive の issue translate-watchdog-vs-os-model-contention (期限の決め直し)
- DR-0023 §5・§7
