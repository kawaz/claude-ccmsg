---
title: codex レビュー Minor 指摘 3 件 (pending flush / ln quoting / DR-0002 crash-loop 乖離)
status: open
category: design
created: 2026-07-10T19:16:21+09:00
last_read:
open_entered: 2026-07-10T19:16:21+09:00
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

# codex レビュー Minor 指摘 3 件 (pending flush / ln quoting / DR-0002 crash-loop 乖離)

## 概要

codex レビュー (2026-07-10) の Minor 指摘 3 件をまとめて起票。個別には実害が小さいが、放置すると積み残るため一括で扱う。詳細評価は `docs/findings/2026-07-10-codex-review-evaluation.md` を参照。

1. **webui ws client: pending array が onClose で flush/reject されない**
   - `packages/webui/src/client/ws.ts` の `send()` (63 行目) は `pending.push(resolve)` してから `ws.send()` する。`onOpen()` が済んだ状態で `send` 直後に切断するレアな窓があると、その resolver は永久に呼ばれず、Composer 側で待っている Promise が pending のまま固まる。
   - `onClose()` (115 行目) は `dispatch` と reconnect スケジュール (`setTimeout(connect, delay)`) のみで、`pending` 配列に一切触れていない。reconnect 後も古い `pending` エントリが残っていると、`onMessage` の `pending.shift()` (97 行目) が新しいレスポンスを古い呼び出し元に誤配送する経路もある。
   - 修正方針: `onClose` で `pending` の全 resolver を reject (またはエラー response で resolve) してから配列をクリアする。`connect()` (reconnect 時含む) 冒頭でも念のためクリアする。

2. **`hooks/session-start.ts:167` の `ln -sfn` 提案文言が unquoted**
   - `` `  - If they agree: ln -sfn ${bin} ${candidate.binPath}` `` は AI (Claude) へ提示するガイダンス文字列だが、`${bin}` / `${candidate.binPath}` がクォートされていない。home パスやその配下に空白・shell メタ文字を含む環境で AI がこの文字列をそのまま実行すると壊れる。
   - 修正方針: 両パスを single quote で囲む (`ln -sfn '${bin}' '${candidate.binPath}'`)。

3. **DR-0002 の crash-loop 警告仕様が未実装 (実装は 12 回試行 throw で完結)**
   - `docs/decisions/DR-0002-daemon-supervision.md` (44 行目) は「spawn リトライは exponential backoff (1s → 2s → 4s → 上限 30s)、5 回連続失敗で hook は 1 回だけ警告を出し、以降そのセッション中は沈黙する」と規定している。
   - 実際の実装 (`packages/cli/src/client.ts` の `connectWithSpawn` / `SPAWN_RETRY_DELAYS_MS = [25, 50, 100, 150, 250, 400, 600, 800, 1000, 1500, 2000, 3000]`) は 12 回の接続リトライ後に `throw new Error("ccmsg: daemon did not become reachable after spawn")` するのみ。DR が言う「5 回失敗で警告 + 以降沈黙」の hook 側ロジックは存在しない。
   - 判断が必要: (a) DR 側を実装 (= 12 回試行 → throw のみ) に合わせて簡略化する、(b) 実装側に警告 + 沈黙ロジックを追加して DR に合わせる、のどちらを取るか未決定。

## 背景

codex レビュー (2026-07-10) の Minor 指摘 3 件。詳細評価は `docs/findings/2026-07-10-codex-review-evaluation.md`。いずれもレアな race / ガイダンス文字列の潜在バグ / ドキュメントと実装の乖離であり、実害は小さいため一括で起票する。

## 受け入れ条件

- [ ] `ws.ts` の `onClose` (および reconnect 時) で `pending` の resolver を reject し、配列をクリアする
- [ ] `hooks/session-start.ts:167` の `ln -sfn` 文言の両パスを single quote で囲む
- [ ] DR-0002 の crash-loop 警告仕様について、実装に合わせて DR を簡略化するか、実装側に警告ロジックを追加するかを決定し反映する
