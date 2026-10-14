---
title: webui の useStoreState に selector を導入し useSyncExternalStore で購読する
status: open
category: design
created: 2026-10-14T13:51:02+09:00
last_read: 2026-10-14T14:51:04+09:00
open_entered: 2026-10-14T13:51:02+09:00
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

# webui の useStoreState に selector を導入し useSyncExternalStore で購読する

## 概要

useStore.ts の `useStoreState` が useState + useEffect の自作購読で selector が無く、(a) 初回 render と購読登録の間の dispatch を取りこぼす (tearing)、(b) 購読者全員 (App / Timeline / SessionList / StatusPanel / SessionSearchPanel / FileViewer ×2) が全 dispatch で再描画、(c) App.tsx:122 の memo (inactive SessionView の描画スキップ) が Timeline の直接購読で無効化されキャッシュ中の全 Timeline が 10 秒 tick 等で 1800 行を再実行、の問題がある。

preact/compat の `useSyncExternalStore` (Timeline:3824 で既に使用) で `useStoreState(store, selector, isEqual)` を実装し、各コンポーネントは必要な slice だけ選ぶ。AppState 丸渡し (11 コンポーネント) もやめる。raw-view-mode.ts の同形も同じ hook に寄せる。

## 背景

fresh-eyes findings の high 4・5。「最初に直すべき 3 つ」の 2 番目。

## 受け入れ条件

- [ ] `useStoreState(store, selector, isEqual)` が `useSyncExternalStore` ベースで、初回 render と購読登録の間の dispatch を取りこぼさない
- [ ] 各購読コンポーネントが必要な slice だけを selector で選び、無関係な dispatch で再描画されない
- [ ] AppState 丸渡し (11 コンポーネント) が無くなる
- [ ] inactive SessionView の memo が有効に戻り、キャッシュ中の Timeline が tick で再実行されない
- [ ] raw-view-mode.ts も同じ hook を使う
