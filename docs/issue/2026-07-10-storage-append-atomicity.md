---
title: storage.ts appendEvent の順序反転 (in-memory 先行問題)
status: open
category: design
created: 2026-07-10T19:14:20+09:00
last_read:
open_entered: 2026-07-10T19:14:20+09:00
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

# storage.ts appendEvent の順序反転 (in-memory 先行問題)

## 概要

`packages/daemon/src/storage.ts:207` の `appendEvent` は次の順で処理している:

1. `room.events.push(ev)` (in-memory 追記)
2. `mid` / `title` / `next` / `prev` 等の in-memory 派生状態更新
3. `fs.writeSync(room.fd, line)` (disk 書き込み、208-218 行)

このため `fs.writeSync` が例外 (disk full / EIO 等) を投げた場合、**in-memory 状態が
disk より先行**し、両者が分岐する。

- 次回 daemon 再起動時は jsonl から room 状態を再構築するため、write 失敗分の
  in-memory 差分は単純に消失する (= 再起動すれば整合は回復する)
- ただし daemon が再起動せず稼働し続けるケースでは、`room.lastMid` が
  disk 未反映のまま加算されているため、**同じ `mid` の重複割当が理論的に起こり得る**
  (= 後続の `msg` イベントで mid 採番がずれる可能性)

severity: minor-to-medium (通常運用では disk full / EIO は稀、かつ再起動で自己修復するが、
mid 重複は無症状のまま伝播しうる)

## 背景

codex レビュー (2026-07-10, Major 4) で判明した storage 一貫性問題。詳細評価は
`docs/findings/2026-07-10-codex-review-evaluation.md` を参照。

修正案として、`fs.writeSync` を先に実行し、成功後に `room.events.push` と
`lastMid` 等の in-memory 更新を行う順序反転が挙がっている。write 失敗時は
throw させれば、`server.ts:302` 付近の `handleRequest` 内 try/catch が
既に捕捉して `sendErr` する経路がある (= 新規のエラーハンドリング追加は不要、
呼び出し順序の入れ替えのみで対応できる可能性が高い)。

## 受け入れ条件

- [ ] `appendEvent` が disk 書き込み成功を確認してから in-memory 状態
      (`events` / `lastMid` / `title` / `next` / `prev`) を更新する順序になっている
- [ ] `fs.writeSync` 失敗時に in-memory 状態が変化しないことをテストで確認できる
- [ ] 既存の `handleRequest` (`server.ts` 付近) の try/catch 経路で
      write 失敗が `sendErr` として呼び出し元に返ることを確認 (新規ハンドリング追加が
      不要かどうかも含めて検証)
- [ ] 順序反転による副作用 (`scheduleFsync` のデバウンス、`room.fd` の遅延 open 等)
      が無いことを確認
