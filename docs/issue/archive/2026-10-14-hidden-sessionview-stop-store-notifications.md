---
title: 隠れている SessionView 配下への store 変更通知を止める
status: resolved
category: design
created: 2026-10-14T15:31:33+09:00
last_read: 2026-10-18T14:26:34+09:00
open_entered: 2026-10-14T15:31:33+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-10-18T14:29:12+09:00
discard_reason:
pending_reason:
close_reason: ["implemented","feat(webui) commit ac00ae66 (change rlszyqyo): 案 1 (隠れている間は通知を止める store を SessionView から context で配る) で実装した"]
blocked_by:
origin: 自リポ TODO
---

# 隠れている SessionView 配下への store 変更通知を止める

## 概要

webui の store を useSyncExternalStore + selector にした後 (v0.168 予定) も、cache 中で隠れている SessionView 配下の Timeline (x3) は peers / rooms / says / connStatus の変化で再描画する。store-selector worker の計測では、開いていない別セッションの peer 変更 1 回で 612 render。Timeline が描画に peers・rooms を使うため。

## 案

- 隠れている間はそのセッション表示の配下へ変更通知を止める store (購読を保留し、表示に戻った時に最新 snapshot で 1 回だけ通知) を SessionView から context で配る
- 代案: SessionView 側で Timeline を memo で包む

## 受け入れ条件

- [x] 隠れている SessionView 配下の Timeline が store 変更で再描画されない
- [x] 表示に戻った時に最新 snapshot へ追従する

## 対応

- `packages/webui/src/client/useStore.ts` に pausableStore を足した。state と dispatch は元の store をそのまま通し、pause 中は subscribe した listener への通知を保留し、resume で保留があれば 1 度だけ通知する。getState は止めない (別の理由で描く・走る処理は今の state を読む)
- SessionView が自分用の pausableStore を作り、自身の購読と配下 (Timeline / Files / Status / 入力欄) に AppContext で配る。active が false の間は pause、true に戻ると resume (layout effect)
- 代案 (Timeline を memo で包む) は採らなかった: Timeline は自分で peers / rooms を購読しているので memo では止まらず、SessionView 自身も接続状態や peers の件数で描き直す
- テスト: `packages/webui/test/session-view-hidden.dom.test.ts` (隠れている間の peers / rooms / 接続状態の変化で Timeline が描き直されない。直す前は描き直していた / 表示に戻ると隠れている間の追記が出る)、`packages/webui/test/use-store.test.ts` (保留と再開時の 1 度の通知)
- /verify: Timeline を開いて /usage へ移り、その間に試験用セッションに応答させ、戻ると応答が末尾に出て最下部に居ることを確かめた。console のエラーは 0。実ブラウザでの描き直しの回数は数えていない (happy-dom のマウントテストで数えた)
