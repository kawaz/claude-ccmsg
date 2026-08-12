---
title: 📁 OFF の [N/M] が thinking/items 単体の details 開閉を拾わない
status: resolved
category: bug
created: 2026-08-12T14:17:09+09:00
last_read:
open_entered: 2026-08-12T14:17:09+09:00
wip_entered: 2026-08-12T14:19:23+09:00
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-08-12T15:06:32+09:00
discard_reason:
pending_reason:
close_reason: ["done:v0.102.2 で解決。当初診断(details 開閉が非反映)は誤報で実測では正しく再計算されていた。実在したのは同族の別バグ(thinking の original/ja タブ切替が fold を動かさず再計算 trigger が無い件)で、notifyDisplayChange を追加して修正、ハイライト再塗りの同じ穴も解消"]
blocked_by:
origin: w-search-i18n
---

# 📁 OFF の [N/M] が thinking/items 単体の details 開閉を拾わない

## 概要

TL 検索スコープ (📁 OFF = 画面に出ているものだけ) の [N/M] が、thinking / items 単体の
`<details>` を開閉しても再計算されず 1/1 のまま止まる。

## 背景

w-search-i18n の実測で発見 (v0.102.1 以前から、原文表示・原文クエリでも再現)。
📁 OFF で thinking 単体の `<details>` を閉じても M が再計算されない。
foldRevision / foldMountRevision が fold group 単位で管理されており、thinking / items の
details 開閉イベントを拾っていないためと見られる。

修正候補:
- 単体 details の toggle も revision に反映する
- 可視判定を FoldOpenStore ベースに寄せる (D2 の fold 状態持ち上げの延長)

小粒の修正と見込まれる。

着手 (2026-08-12)。

## 受け入れ条件

- [ ] thinking / items 単体の details 開閉が 📁 OFF の [N/M] 再計算に反映される
