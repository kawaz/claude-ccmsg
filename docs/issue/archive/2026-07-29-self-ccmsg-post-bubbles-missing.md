---
title: DR-0027 §2.2 の自 post/reply バブルが TL に出ていない (回帰疑い)
status: resolved
category: bug
created: 2026-07-29T12:09:43+09:00
last_read:
open_entered: 2026-07-29T12:09:43+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-07-30T21:00:00+09:00
discard_reason:
pending_reason:
close_reason: ["done:kawaz 裁定 (r76m74) で「バブル復活 vs supersede」の二択でなく設計の作り直しに (自 post の echo 抑制をやめ、本文なしの軽量ローカルエコー = msg_via + echo:true、reply_via なし、を配信する形へ変更)","dr/DR-0003-wire-protocol §5 Addendum","dr/DR-0027-tl-ccmsg-canonical-lookup","implemented"]
blocked_by:
origin: 自リポ TODO
---

# DR-0027 §2.2 の自 post/reply バブルが TL に出ていない (回帰疑い)

## 概要

自セッションが Bash tool で `ccmsg post/reply` した際に TL へ出るはずの ccmsg バブル (DR-0027 §2.2) が 1 件も表示されていない。実データ掃引で ccmsg 検出数が `resolveToolResults` 適用前 440 → 適用後 198 に落ち、差分 242 件がすべて自 post の ref。

## 背景

worker 実測 (2026-07-29, v0.82.0)。原因は特定済み: `resolveToolResults` (packages/webui/src/client/transcript-model.ts:342-353 付近) が Bash の `tool-result` を `bash-result` に書き換えるが、自 post 検出の `extractCcmsgToolResultRefs` (同 :1527 付近) は `tool-result` しか見ない。v0.80.0 の bash 一体カード実装 (1036a09e) で入った片面変更。

bash 一体カード表示で ccmsg post の実行自体は bash カードとして見える。DR-0027 §2.2 の専用バブル (会話として読める形) を復活させるべきか、bash カードで代替済みとして DR を supersede するかは kawaz 裁定が要る。復活させる場合は `extractCcmsgToolResultRefs` が `bash-result` も見るようにするだけで済む見込み。

## 受け入れ条件

- [ ] DR-0027 §2.2 の専用バブルを復活させるか、bash カードで代替済みとして DR を supersede するか裁定する
- [ ] 裁定に応じて `extractCcmsgToolResultRefs` の修正または DR-0027 の更新を行う
- [ ] DR の扱いを変える場合は decisions/ に追記する

## TODO

<!-- wip 時のみ -->

- [ ] {次に手を付けるサブタスク}
