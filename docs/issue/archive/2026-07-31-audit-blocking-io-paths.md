---
title: daemon/webui の同期 IO・イベントループ阻害の洗い出し (詰まり体感の根治)
status: resolved
category: task
created: 2026-07-31T11:18:12+09:00
last_read: 2026-08-12T08:23:19+09:00
open_entered: 2026-07-31T11:18:12+09:00
wip_entered: 2026-08-12T08:24:03+09:00
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-08-12T08:40:54+09:00
discard_reason:
pending_reason:
close_reason: ["finding/2026-08-12-blocking-io-audit-full","done:34項目仕分け完了","done:high4件=fsRead/fsWrite実装済み(v0.100.3)","done:snapshot経路はissue/session-status-snapshot-sync-ioへ","done:webui cross-lineはissue/timeline-crossline-incrementalへ","done:残medium/lowはissue/remaining-sync-io-medium-lowへ","done:受け入れ条件4つ全て充足"]
blocked_by:
origin: 自リポ TODO
---

# daemon/webui の同期 IO・イベントループ阻害の洗い出し (詰まり体感の根治)

## 進捗

監査実施 (2026-08-12)。daemon/webui の同期 IO 洗い出し + 仕分けを worker に委譲、結果は findings に追記予定。

## 概要

daemon の op ハンドラ / イベント処理経路と webui のイベントハンドラ / レンダリング経路を対象に、
イベントループを塞ぐ同期 IO・重い同期処理を grep + 通読で洗い出し、各箇所を
「非同期化する」/「性質上同期で問題ない (理由明記)」に仕分けする。仕分け後、非同期化が必要な箇所は
個別修正 issue 化するか即修正する。

## 背景

kawaz の裁定 (r99m5): 「IO を伴うイベントやメッセージは全て非同期化を原則とする (daemon しかり UI しかり)。
今現在もまだ他に色んなところで詰まりを感じることが多い」を受けた監査タスク。正本は DR-0029。

既知の大物として webui Timeline の DOM 規模肥大 (実測: 1 セッション DOM 73,000 ノード / リスナ 12,000 個)
は `2026-07-29-timeline-virtual-scroll` として別 issue で追跡中のため、本 issue のスコープからは除く
(重複対応しない)。

## 受け入れ条件

- [x] daemon の op ハンドラ / イベント処理経路を通読し、同期 fs API (`readFileSync` 等) やイベントループを
      塞ぐ重い同期処理を全て列挙した一覧がある
- [x] webui のイベントハンドラ / レンダリング経路を通読し、同様の一覧がある (Timeline DOM 規模は除外)
- [x] 各項目が「非同期化する」/「性質上同期で問題ない (理由明記)」に仕分けされている
- [x] 非同期化が必要な項目それぞれについて、修正 issue 化または実装が完了している

## TODO

- [ ] DR-0029 および r99m3〜m5 のやり取りを読み、非同期化原則のスコープ・除外条件を確認する
- [ ] daemon 側: op ハンドラ・イベント処理経路を grep (`readFileSync`, `writeFileSync`, `execSync` 等の
      同期 API) + 通読で洗い出す
- [ ] webui 側: イベントハンドラ・レンダリング経路を同様に洗い出す
- [ ] 洗い出し結果を仕分け、非同期化が必要な箇所を修正 issue 化 or 即修正する
