---
title: SessionView Timeline tab で離席中の live tail 更新が反映されず、再訪時に最新ログが抜ける
status: idea
category: design
created: 2026-07-14T20:27:04+09:00
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

# SessionView Timeline tab で離席中の live tail 更新が反映されず、再訪時に最新ログが抜ける

## 概要

kawaz の r12 mid=12 (2026-07-14) 観測: SessionView の Timeline tab で最新が読まれておらず、中身が空だったりする残 fix。ROOM 選択時の過去ログ空バグは v0.26.x で fix 済みだが、これは別問題。

## 背景

webui-history-fix worker の調査による原因判明: `Timeline.tsx` が `SessionTreeState` cache を session/tab 切替時に「loaded」状態のまま保持する設計になっている (`packages/webui/src/client/store.ts` 60-66 行目のコメントに明記された意図的挙動: 「session/tab 切替でも discard しない」)。この cache 保持中、当該 session を離席している間に来た live tail 更新は `transcript_unsubscribe` 済みのため反映されない。結果として tab に戻った時点で cache が古いまま = 最新ログが抜けて見える。

既存の意図的な cache 設計とのトレードオフのため、fix 候補は複数あり設計裁定が必要:

- (a) 常時 `transcript_subscribe` を維持し unsubscribe しない — 複数 session 同時購読で帯域負荷が増える
- (b) tab 復帰時に自動 refresh (`transcript_read` で最新を取り直す)
- (c) cache に TTL を導入する
- (d) UI 側に手動「更新」ボタンを設け、明示的リフレッシュに倒す

DR を追加して裁定する選択肢もある。優先度中 (kawaz の観測ベースで、実害の頻度は未計測)。

## 受け入れ条件

- [ ] Timeline tab 再訪時に、離席中に来た live tail 更新が反映される (またはユーザが明示的にトリガできる) 方式が決まる
- [ ] 選んだ方式のトレードオフ (帯域 / 実装コスト / 既存 cache 設計との整合) が DR またはこの issue に記録される
