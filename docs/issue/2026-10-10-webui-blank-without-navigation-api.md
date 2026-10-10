---
title: webui が Navigation API の無いブラウザで真っ黒になる
status: open
category: bug
created: 2026-10-10T13:37:30+09:00
last_read:
open_entered: 2026-10-10T13:37:30+09:00
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

# webui が Navigation API の無いブラウザで真っ黒になる

## 概要

webui は `packages/webui/src/client/navigation.ts:277` で `window.navigation.addEventListener` を無条件に呼ぶ。`main.tsx` でその実行が WS 接続と初回 render より前にあるため、Navigation API の無いブラウザ (iOS Safari 26.1 以下) では描画前に TypeError で止まり真っ黒になる。

2026-10-10 に iPhone で発生、iPad は正常。v0.157 から同じ挙動で退行ではない。調査は `docs/findings/2026-10-10-iphone-webui-blank-navigation-api.md`。

## 背景

裁定待ち。

- (a) 対応要件 (iOS Safari 26.2+) を DESIGN に明記し、bundle 起動前の固定 HTML で非対応時に見える案内を出す (推奨)
- (b) History API へのフォールバックを含めて navigation 層を代替設計

どちらでも固定 HTML の案内は入れる。`addEventListener` だけの guard は不十分 (他の参照が残る)。

## 受け入れ条件

- [ ] 裁定 (a / b) が決まる
- [ ] Navigation API の無いブラウザで、真っ黒ではなく見える案内 (または動作) になる
