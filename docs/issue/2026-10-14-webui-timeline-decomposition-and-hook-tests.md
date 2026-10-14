---
title: webui Timeline.tsx の分解と hook 単位のテスト基盤
status: open
category: design
created: 2026-10-14T13:51:25+09:00
last_read: 2026-10-15T02:14:12+09:00
open_entered: 2026-10-14T13:51:25+09:00
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

- [ ] `Timeline()` が関心ごとごとの custom hook に分解され、effect 間の結合が ref と宣言順に依存しない
- [ ] Timeline.tsx が timeline/ 配下に分割されている
- [ ] happy-dom が devDependency にあり、hook 単位のテストが走る
- [ ] 上記 hook のそれぞれに最低限のテストがある
