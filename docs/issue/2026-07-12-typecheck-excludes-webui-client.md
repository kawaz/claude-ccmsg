---
title: just typecheck が packages/webui のクライアント/テストコードを検査していない
status: open
category: bug
created: 2026-07-12T05:10:57+09:00
last_read:
open_entered: 2026-07-12T05:10:57+09:00
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

# just typecheck が packages/webui のクライアント/テストコードを検査していない

## 概要

`just typecheck` (root の `tsc --noEmit`) が `packages/webui/src/client/**` と
`packages/webui/test/**` を exclude しており、webui クライアントコードの
型エラーが CI で検出されない盲点がある。Wave5 worker が発見 (2026-07-12)。

`packages/webui/tsconfig.json` 自体は別途 client を include (カバー) している
が、root の `just typecheck` / CI からはこの tsconfig が呼ばれておらず、
client 側の型チェックが実質未実施のまま通ってしまう。

## 背景

exclude の経緯は未確認。おそらく DOM lib 型 (`lib.dom.d.ts`) と daemon 側
(Node/Bun 環境) の型定義の衝突回避が理由と推測されるが、裏取りできていない。

## 受け入れ条件

- [ ] root tsconfig / justfile で `packages/webui/src/client/**` `packages/webui/test/**` を exclude している経緯を確認する (git blame / commit log / DR を辿る)
- [ ] exclude の理由 (DOM lib 型と daemon 型の衝突回避と推測) が妥当か検証する
- [ ] 修正方針を決定して適用する:
  - 案A: justfile の `typecheck` recipe に `(cd packages/webui && bunx tsc --noEmit -p tsconfig.json)` を追加
  - 案B: root tsconfig の project references 化
- [ ] 修正後、`just typecheck` が webui クライアント/テストコードの型エラーを検出できることを確認する
