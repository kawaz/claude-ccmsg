---
title: SessionView Timeline tab で離席中の live tail 更新が反映されず、再訪時に最新ログが抜ける
status: resolved
category: design
created: 2026-07-14T20:27:04+09:00
last_read:
open_entered:
wip_entered: 2026-07-14T23:10:51+09:00
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-07-14T23:31:06+09:00
discard_reason:
pending_reason:
close_reason: ["implemented:v0.30.0 (546acacb)", "Timeline.tsx に mount/sid/connStatus 変化時の auto-refresh useEffect を追加、既存の refresh() 経路 (transcript_read mode:replace) を再利用", "tlr-impl worker 実装、team-lead 監査済み", "DR-0009 の transcript_read には after パラメータがないため append merge は不採用、全 tail 再取得となるが個人スケールで実害なし", "既存 refresh() 手動ボタンは残置 (edge case 用途)"]
blocked_by:
origin: 自リポ TODO
---

# SessionView Timeline tab で離席中の live tail 更新が反映されず、再訪時に最新ログが抜ける

## 概要

kawaz の r12 mid=12 (2026-07-14) 観測: SessionView の Timeline tab で最新が読まれておらず、中身が空だったりする残 fix。ROOM 選択時の過去ログ空バグは v0.26.x で fix 済みだが、これは別問題。

## 背景

webui-history-fix worker の調査による原因判明: `Timeline.tsx` が `SessionTreeState` cache を session/tab 切替時に「loaded」状態のまま保持する設計になっている (`packages/webui/src/client/store.ts` 60-66 行目のコメントに明記された意図的挙動: 「session/tab 切替でも discard しない」)。この cache 保持中、当該 session を離席している間に来た live tail 更新は `transcript_unsubscribe` 済みのため反映されない。結果として tab に戻った時点で cache が古いまま = 最新ログが抜けて見える。

既存の意図的な cache 設計とのトレードオフのため、fix 候補は複数あった:

- (a) 常時 `transcript_subscribe` を維持し unsubscribe しない — 複数 session 同時購読で帯域負荷が増える
- (b) tab 復帰時に自動 refresh (`transcript_read` で最新を取り直す)
- (c) cache に TTL を導入する
- (d) UI 側に手動「更新」ボタンを設け、明示的リフレッシュに倒す

## 裁定 (TLR-Q1)

kawaz r15 mid=4 (2026-07-14) で **(b) tab 復帰時に自動 refresh** を選択。
(a) は帯域負荷増、(c)/(d) は cache TTL・手動ボタンとも不要と判断し不採用。

### 実装方針

SessionView の Timeline tab (or Files tab) が sid 訪問時に自動で `transcript_read` を叩き、`SessionTreeState` cache を最新化する。cache TTL や UI の手動更新ボタンは導入しない。

実装は worker 委譲予定 (別 task)。

## 受け入れ条件

- [ ] Timeline tab (or Files tab) の sid 訪問時に自動で `transcript_read` が呼ばれ、cache が最新化される
- [ ] worker への実装委譲 task が完了する
