---
title: Status タブにメインコンテキストサイズ・使用率を表示
status: open
category: request
created: 2026-07-17T08:47:10+09:00
last_read:
open_entered: 2026-07-17T08:47:10+09:00
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

# Status タブにメインコンテキストサイズ・使用率を表示

## 概要

Status タブ (+ サイドバーバッジ検討) にメインセッションのコンテキストサイズと
使用率を表示する。daemon の session_status fold に「直近 assistant 行の
usage 合算」を追加するだけで取得できる (hook / statusline 不要)。

## 背景

kawaz r26 mid=70 での依頼。実測確認済み: transcript jsonl の各 assistant 行
`message.usage` に `input_tokens` / `cache_read_input_tokens` /
`cache_creation_input_tokens` があり、直近 assistant 行の合算が現在の
メインコンテキストサイズにほぼ一致する (自セッションで ~522k を実測)。

使用率の分母はモデル名 (`message.model`) からの推定 (200k / `[1m]` = 1M)。
`CLAUDE_CODE_MAX_CONTEXT_TOKENS` 等の env 上書きは transcript から観測
できないため、表示は推定値であることを明示し生値も併記する。表示例:
`ctx 522k/1M (52%)`。

compaction 後は usage が下がるので自然に追従するはずだが、実装時に
`/clear` 跨ぎ・compaction 跨ぎの挙動を実データで確認すること。

DR-0022 (in-view 検索) 完了後の実装キュー。teams セクション issue
(`2026-07-17-status-teams-section.md`) と同じ daemon session_status fold
拡張が必要になるため、同一 workflow で実装するのが効率的。

## 受け入れ条件

- [ ] daemon の session_status fold に直近 assistant 行の usage 合算
      (input_tokens + cache_read_input_tokens + cache_creation_input_tokens)
      を追加した
- [ ] message.model からモデルの context 上限 (200k / `[1m]`=1M) を推定し
      使用率を算出できる
- [ ] Status タブにコンテキストサイズ・使用率を表示できる (例:
      `ctx 522k/1M (52%)`)
- [ ] env 上書き (`CLAUDE_CODE_MAX_CONTEXT_TOKENS` 等) は transcript から
      見えないため推定値である旨が UI 上に明示されている
- [ ] `/clear` ・ compaction 跨ぎでの表示追従を実データで確認した
- [ ] サイドバーバッジでの表示可否を検討した (採用しない場合はその判断も記録)

## TODO

<!-- wip 時のみ -->
