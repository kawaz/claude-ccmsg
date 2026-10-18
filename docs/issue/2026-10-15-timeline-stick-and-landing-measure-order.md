---
title: Timeline の末尾追従と位置への着地が、内容が伸びた後・着地の前の測り直しに引きずられる可能性 (未検証)
status: wip
category: bug
created: 2026-10-15T03:10:09+09:00
last_read: 2026-10-18T14:08:50+09:00
open_entered: 2026-10-15T03:10:09+09:00
wip_entered: 2026-10-18T14:16:40+09:00
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

# Timeline の末尾追従と位置への着地が、内容が伸びた後・着地の前の測り直しに引きずられる可能性 (未検証)

## 概要

webui Timeline の scroller の測り直し (useStickToBottom の測り直しの effect が scroll 位置を測り、最下部付近かを決め、位置 pin の解除と読書位置の記憶を onScrollMeasured に渡す) が、内容の変化と位置の変化のたびに即座に走る。分割前の Timeline.tsx からの振る舞いで、Timeline の custom hook への分解 (issue webui-timeline-decomposition-and-hook-tests、archive 済み) ではこの順序をそのまま残した。次の 2 つが起きうると読めるが、どちらも未検証。

### 仮説 1: 80px を超える追記で、最下部に居ても追わない

- 測り直しは内容 (group の列) が変わるたびに走り、同じ commit の追従判定 (useStickToBottom の onEndChange の appended) より先に走る (packages/webui/src/client/components/timeline/useStickToBottom.ts の Design rationale)
- そのため、追記で伸びた後の位置で「最下部付近か」を測る。伸びた分が NEAR_BOTTOM_PX (80px) を超えると最下部付近ではないと判定され、追従しない
- 末尾の保持 (useScrollHold の toBottom) が生きている間は ResizeObserver が末尾へ書き直すので表に出ない。読み手が wheel / touch 等で保持を外した後に、自分で最下部へ戻って読んでいる時に起きる

### 仮説 2: 戻る / 進むで位置に来た時、着地の前に位置が外れる

- 位置 (/timeline/<uuid>) が変わると、着地 (usePositionLanding) より先に測り直しが走る (timeline/Timeline.tsx の Design rationale)
- 読み手が以前にスクロールしていて (PinTracker の userScrolledSincePin が true のまま)、最下部付近に居ると、測り直しが「自分で最下部へ来た」と判定して head へ replaceNavigation する。直後の着地でスクロールはするが、URL は head へ戻され、位置が外れる
- クリックでの選択は PinTracker.selected が数え直すので起きない。直リンクの初回も数え直し前の初期値が false なので起きない

## 確認手順 (/verify)

.claude/skills/verify/SKILL.md に従い、隔離 daemon と試験用セッション (--name 🤖ccmsg-verify-<topic>) を使う。

- 仮説 1: 試験用セッションで数ターン積んで Timeline を開く。wheel で少し上へ動かして保持を外し、wheel で最下部へ戻る。その後、試験用セッションに長い応答 (表示で 80px を大きく超えるもの、例: 1〜60 の数字を 1 行ずつ) を返させる。最下部を追うか (scrollTop と scrollHeight - clientHeight を比べる) を見る
- 仮説 2: 項目をクリックして位置を選ぶ。別の項目もクリックして選び、履歴を積む。wheel で最下部まで降りる (位置は head に戻る)。ブラウザの戻るで位置 URL へ戻った時に、URL が位置のまま残り、その項目が toolbar 直下に着地するかを見る
- 再現したら、まず落ちるテストを packages/webui/test/timeline.dom.test.ts に足す (happy-dom で scroller の高さを差し替える部品がそこにある)

## 受け入れ条件

- [ ] 2 つの仮説それぞれについて、実機で再現するかを確認した
- [ ] 再現したものは落ちるテストを足してから直した。再現しなかったものは、確認した手順と結果を本文に残した
