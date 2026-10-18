---
title: Timeline の末尾追従と位置への着地が、内容が伸びた後・着地の前の測り直しに引きずられる可能性 (未検証)
status: resolved
category: bug
created: 2026-10-15T03:10:09+09:00
last_read: 2026-10-18T14:08:50+09:00
open_entered: 2026-10-15T03:10:09+09:00
wip_entered: 2026-10-18T14:16:40+09:00
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-10-18T14:23:24+09:00
discard_reason:
pending_reason:
close_reason: ["done:2 つとも /verify で再現し、落ちるテストを足してから直した (fix(webui) commit e5dbd998 の親 swkylmop)"]
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

- [x] 2 つの仮説それぞれについて、実機で再現するかを確認した
- [x] 再現したものは落ちるテストを足してから直した。再現しなかったものは、確認した手順と結果を本文に残した

## 確認結果

- 仮説 1: 再現した。試験用セッションで数ターン積み、wheel で上 (300px) に動かして保持を外し、wheel で最下部へ戻した (scrollTop 1042 = scrollHeight - clientHeight)。1〜60 を 1 行ずつ返させると scrollTop は 1042 のまま、最下部は 2730 になり追わなかった。短い応答 (「了」) でも、ユーザ発話と応答の 2 行と応答中の表示の分 (計 178px) で追わなかった。直した後は同じ操作で 1710px 伸びても scrollTop = 最下部 (4618) に追従した。原因: 測り直しが内容の変化のたびに走り、伸びた後の位置で「最下部付近でない」と判定していた。scroller を測るのをスクロールが起きた時だけにした
- 仮説 2: 本文の手順どおりでは位置 URL へ戻れなかった。項目のクリックでの選択は replace で履歴を書き換えるので積まれず、戻るは Timeline の前の URL へ行った。代わりに、最下部で項目をクリックして選び、最下部のまま wheel を回し (動かないので scroll は来ない)、別の画面 (/usage) へ行ってからブラウザの戻るで位置 URL へ戻ると、着地はするが URL が head に置き換わり選択が外れた (wheel を回さない対照では位置が残った)。原因: 位置を張る前のスクロールの記録が残ったまま、着地の前にスクロール位置の復元で最下部が測られていた。測り直しを位置の変化で走らせないだけでは直らず (実機で確認)、head に戻った時にその記録を捨てるようにして直った
- テスト: packages/webui/test/timeline.dom.test.ts に 2 件 (80px を超える追記で最下部へ戻った読み手を追う / 最下部で wheel を回してから離れて戻った位置を着地させて保つ)、packages/webui/test/use-timeline-scroll-hooks.dom.test.ts に 1 件 (head に戻る前のスクロールで、後から来た位置を外さない)。どれも直す前に落ちることを確かめた。内容の変化で測り直すことを固定していた hook のテストは、スクロールの時だけ測る仕様に書き換えた
