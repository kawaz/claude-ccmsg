---
title: webui Timeline.tsx の分解と hook 単位のテスト基盤
status: resolved
category: design
created: 2026-10-14T13:51:25+09:00
last_read: 2026-10-15T02:14:12+09:00
open_entered: 2026-10-14T13:51:25+09:00
wip_entered: 2026-10-15T02:25:37+09:00
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-10-15T03:08:25+09:00
discard_reason:
pending_reason:
close_reason: ["implemented"]
blocked_by:
origin: 自リポ TODO
---

# webui Timeline.tsx の分解と hook 単位のテスト基盤

## 概要

Timeline.tsx の `Timeline()` が 1 関数 1812 行ある (useEffect 24 / useMemo 27 / useState 14 / useRef 11 / useCallback 13、ファイル全体 4972 行、createContext 8)。effect 同士が ref と宣言順 (4301 行のコメント) で結合しており、DOM テスト基盤 (happy-dom / preact/test-utils) が無いため一切テストされていない。

関心ごとに custom hook へ分解し、ファイルを timeline/ に分割し、happy-dom を devDependency に入れて hook 単位のテストを足す。

分解候補の hook:

- useTranscriptLoader
- useLiveTailSubscription
- useStickToBottom
- useInViewSearch
- useUserTurnNav
- usePositionLanding
- useAutoOpenSettings

## 背景

fresh-eyes findings の high 2。「最初に直すべき 3 つ」の 3 番目。前段は issue webui-store-subscription-selector で、その後に着手する。

## 受け入れ条件

- [x] `Timeline()` が関心ごとごとの custom hook に分解され、effect 間の結合が ref と宣言順に依存しない
- [x] Timeline.tsx が timeline/ 配下に分割されている
- [x] happy-dom が devDependency にあり、hook 単位のテストが走る
- [x] 上記 hook のそれぞれに最低限のテストがある

## 解決時の根拠

1. `Timeline()` は custom hook に分解済み: useTranscriptLoader / useLiveTailSubscription / useForkOrigin / useTranscriptModel / useSayBubbles / useTimelineFolds / useAutoOpenSettings / useSidePanel / useInViewSearch / useUserTurnNav / useStickToBottom / usePositionPin + usePositionLanding (packages/webui/src/client/components/timeline/)。Timeline() は 1710 行から約 666 行 (JSX 約 390 行)。hook 間の受け渡しは戻り値 (PinTracker、onScrollMeasured、openFoldsAt 等)。prevEndRef と宣言順で結ばれていたセッション切替検知と追記検知は classifyEndChange (timeline/transcript-end.ts) で 1 effect にまとめ、👤 ナビも同じ規則で独立に判定する。宣言順の依存として残るのは「末尾追従の測り直しを位置への着地より先に走らせる」1 か所で、理由を Timeline.tsx に Design rationale として書いた。
2. Timeline.tsx は components/timeline/ 配下に分割済み (Timeline.tsx / context.ts / raw / folds / tools / agents / translation / segments / system-messages / bubbles / ccmsg / actions)。
3. happy-dom は devDependency にあり (packages/webui/test/dom.ts の withDom)、hook 単位のテストが走る (test/render-hook.ts)。
4. 各 hook のテスト: use-timeline-panel-hooks / use-transcript-loader / use-transcript-model / use-in-view-search / use-timeline-scroll-hooks の .dom.test.ts。Timeline 全体の回帰テスト timeline.dom.test.ts (分解前後とも 27 件 green) と行の種類ごとの描画テスト timeline-rendering.dom.test.ts。webui coverage 76.91 / 82.10 で下限を 74 / 80 に引き上げ。/verify (試験用セッション 🤖ccmsg-verify-timeline) で読み込み・live tail の追記と追従・遡り中は追従しない・👤 ↑↓ のループ・クリックでの位置選択・位置 URL の再読み込みでの着地・自分で最下部に来た時の解除・タブ往復での末尾寄せを実機確認。

## 残課題 (別 issue 候補)

- 追記で内容が伸びた後に測り直してから追従を判定するため、保持の無い状態で 80px を超える追記は追従しない可能性 (未検証、挙動は分解前のまま保存)。
- 戻る/進むで位置に来た時、読み手が以前にスクロールしていて最下部に居ると着地前の測り直しで位置が外れる可能性 (未検証、順序は保存)。
