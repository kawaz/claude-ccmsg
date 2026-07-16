---
title: Session Search の UX 改善 3 点 (in-view 検索継承 / パネル維持 / pin 常設)
status: open
category: design
created: 2026-07-17T08:01:00+09:00
last_read:
open_entered: 2026-07-17T08:01:00+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered:
discard_reason:
pending_reason:
close_reason:
blocked_by:
origin: kawaz r26 mid=64
---

# Session Search の UX 改善 3 点 (in-view 検索継承 / パネル維持 / pin 常設)

## 概要

Session Search 周りの UX 改善 3 点。

1. 検索結果クリックで TL 遷移時に、Session Search のクエリ + `[Aa]`/`[.*]`
   トグル状態を TL の in-view 検索 (DR-0022) に継承し、そのままハイライト
   表示する
2. セッション選択時に Session Search パネルを閉じない (検索結果を連続で
   見て回れるようにする)
3. pin ボタンを SessionView の Files/Timeline/Rooms/Status タブ列ヘッダー
   右に常設し、検索経由・ccmsg アクティブ状態と無関係に任意セッションを
   pin/unpin できるようにする (検索結果クリック時の自動 pin は廃止)
4. 検索結果のマッチサマリー内テキストにも検索ハイライト (ワード別色) を
   適用する。DR-0022 の `splitTextForHighlight` (in-view-search.ts の
   pure 関数) を SessionSearchPanel のサマリー描画で再利用する想定

## 背景

Session Search (DR-0021) と in-view 検索 (DR-0022) が別々の検索状態を持つ
ため、検索結果から TL に飛んだ直後にもう一度同じクエリを打ち直す必要がある。
また、現状は検索結果クリックでセッションを開くとパネルが閉じて SESSIONS
リストに戻ってしまい、複数の検索結果を見比べる動線が悪い。

pin は現状「検索結果クリック時の自動 pin」に依存した実装になっているが、
これは確認だけの段階でも意図せず pin してしまう問題がある。pin のキーは
sid なので、UI 上の文脈 (検索経由か通常ナビゲーションか) と関係なく
タブヘッダーに恒常ボタンとして出しても矛盾なく成立する。

## 受け入れ条件

- [ ] (1) 検索結果クリックで TL へ遷移した際、Session Search のクエリと
      `[Aa]`/`[.*]` トグル状態が in-view 検索に引き継がれ、該当箇所が
      ハイライト表示される
- [ ] (2) セッション選択時に Session Search パネルが閉じずに開いたまま
      維持される
- [ ] (3) SessionView の Files/Timeline/Rooms/Status タブ列ヘッダー右に
      pin/unpin ボタンが常設され、検索結果クリック時の自動 pin が廃止
      されている
- [ ] (4) 検索結果のマッチサマリー内テキストにも検索ワードのハイライト
      (ワード別色) が適用されている

## TODO

<!-- wip 時のみ -->

- [ ] DR-0022 (in-view 検索) の land を待つ ((1) がこれに依存)
