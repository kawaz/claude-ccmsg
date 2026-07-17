---
title: webui の場当たり改修で重複したパターンのコンポーネント化・simplify 棚卸し
status: idea
category: task
created: 2026-07-17T09:17:47+09:00
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
origin: kawaz r26 mid=77
---

# webui の場当たり改修で重複したパターンのコンポーネント化・simplify 棚卸し

## 概要

webui の場当たり改修で重複したパターンをコンポーネント化・simplify する (kawaz r26 mid=77、優先順位は AI 裁量)。

候補 (実施時に全数走査して確定):

1. localStorage の load/save + clamp/garbage 耐性パターン — favorites / paneRatio / sidebarWidth / pinnedSessions / sortKey / draft と 6 箇所で類似実装、pure ヘルパ or hook に統一
2. FAB + popup panel + 外側クリック close + sending ガード — RoomComposerFab / OneOnOneComposer で重複
3. fs_list 結果の dispatch 配線 (loadDir / onMemoCreated の ancestor リロード / SessionSearchPanel 等)
4. `<details>` 折りたたみセクション (SessionList のセクション / StatusPanel / ROOMS 1on1 折りたたみ)
5. タブ切替 UI (SessionView タブ / thinking タブ)

## 背景

webui は機能追加を優先して場当たり的に実装を重ねてきたため、上記のような類似パターンが複数箇所に重複している。

## 受け入れ条件

- [ ] 候補 1-5 を全数走査し、実際に重複しているパターンを確定
- [ ] 確定したパターンをコンポーネント化 / pure ヘルパ or hook に統一
- [ ] simplify 後もテスト green を維持 (挙動不変)
- [ ] 視覚変更なし

## 補足

着手タイミング: 走行中の機能実装キュー (Session Search UX / Status 拡張 / DR-0023) が捌けた後の「キリが良い時」に 1 workflow で。ただし新機能がこれらのパターンに再度触る場合はその workflow 内で先行抽出してよい (PaneSplitter の前例)。
