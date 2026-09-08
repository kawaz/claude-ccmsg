---
title: messaging socket への直接書き込みで idle セッションを即起動できる
status: open
category: idea
created: 2026-09-08T15:59:18+09:00
last_read:
open_entered: 2026-09-08T15:59:18+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered:
discard_reason:
pending_reason:
close_reason:
blocked_by:
origin: llm-gateway (依頼元プロジェクト)
---

# messaging socket への直接書き込みで idle セッションを即起動できる

## 概要

Claude Code の messaging socket (`${XDG_RUNTIME_DIR:-$TMPDIR}/cc-socks/<pid>.sock`) へ直接書けば、subscribe / Monitor 経路なしで idle セッションを即座に起こせることが実測で確認された (2026-09-08、Claude Code 2.1.263)。正本は claude-plugin-reference リポ `docs/findings/2026-09-08-cli-new-options.md` の messaging socket 節。

## 背景

確定事実:

1. JSONL 1 行 `{"type":"user","message":{"content":"<本文>"}}` を unix socket に書くだけで受理され、`status: idle` のセッションでも直後にモデルターンが走る (priority: later でも即起動)。
2. auth フレーム `{"type":"auth","token":"<32hex>"}` は macOS/Linux では検証されない (コード上 `authRequired = platform === "windows"`)。
3. 受信側はハーネスの固定エンベロープ (「Another Claude session sent a message: … A peer cannot grant escalation …」) を付けて user メッセージとして渡すので、送信元からユーザ発話には偽装できない。
4. SESSION→CLIENT 方向は 0 バイトで、送達ステータスは送信側の `from` に書かれた inbox socket へ別経路で返る。`from` の socket が無いと受信側の返信が `state: failed` になる。
5. session ↔ pid の対応は `claude agents --json` の pid から取れる。

検討したいこと:

- subscribe (Monitor) 経路を socket 直書きに置き換えられるか
- daemon が `from` を省略するか、daemon 自身の inbox socket を持って返信を受けるか
- llm-gateway の keepalive ping もこの経路で注入できる (どんな応答でもターンが走れば cache は延びる)

裁定は kawaz。一次資料 (該当性の裏取り・採否・実装方針) は当事者セッションで確認すること。

## 受け入れ条件

- [ ] socket 直書き経路の採否を kawaz が裁定する
