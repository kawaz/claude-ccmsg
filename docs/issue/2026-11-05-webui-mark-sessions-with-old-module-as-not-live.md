---
title: push を持たない古い module のセッションを webui で「ライブ更新なし」と分からせる
status: open
category: request
created: 2026-11-05T15:20:41+09:00
last_read:
open_entered: 2026-11-05T15:20:41+09:00
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

# push を持たない古い module のセッションを webui で「ライブ更新なし」と分からせる

## 概要

push を持たない古い module (0.211 より前) のセッションを webui で「ライブ更新なし」と分からせる。

## 背景

DR-0045 で daemon は module の `transcript_push` を合図に jsonl を読む (tail / fs.watch 無し)。plugin を更新しても起動中のセッションの module は古いままなので、0.211 より前の module で動くセッションは push が無く、daemon は jsonl を読まず TL はライブ更新されない。

2026-11-05 に kawaz が「TL に新規 prompt も返事も反映されない」と見たのはこれ (新 module のセッションでは即時反映を確認、解決扱い)。webui はこのセッションを他と同じ見せ方にしているので、利用者には「壊れている」と見える。

## 提案

module の hello にあるバージョン (無ければ push 能力の有無) を daemon が session_status に載せ、webui は push を持たないセッションを `no_module` と同じ「ライブでない」印で見せる (再起動を促す文言付き)。

## 補足

古い module の判定を version 比較にするか、hello に「push する」能力フラグを足すかは実装側で判断。

## 関連

- DR-0045
- findings `2026-11-05-relay-gave-up.md` (worker 作成予定)

## 受け入れ条件

- [ ] push を持たない module のセッションが webui で「ライブでない」印と再起動を促す文言付きで表示される
