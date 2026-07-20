---
title: SessionCreator にコマンドプレビュー + その場編集を追加
status: resolved
category: design
created: 2026-07-17T22:18:25+09:00
last_read:
open_entered: 2026-07-17T22:18:25+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-07-21T00:00:00+09:00
discard_reason:
pending_reason:
close_reason: ["implemented: SessionLaunchRequest に optional command 追加、SessionCreator に textarea プレビュー + default ボタン実装済み。user role 限定 op で空文字は invalid_args で拒否、変数展開なし","dr/DR-0018 implemented: §3.2 に addendum 追記済み(権限等価性の justification)","done: session-launch.test.ts でテスト済み。close 漏れ棚卸しで実装済みを精査確認 (2026-07-21)"]
blocked_by:
origin: 自リポ TODO
---

# SessionCreator にコマンドプレビュー + その場編集を追加

## 概要

SessionCreator (新規セッション起動フォーム) に実行コマンドのプレビュー + その場編集を追加する (kawaz 裁定 2026-07-17)。DR-0018 の追補として実装。

1. フォームに config の command テンプレを textarea で表示する (変数展開は不要 — `$CWD` 等はそのままの生テンプレ表示)。
2. その場で編集でき、実行時は編集後のテキストを command として送る。protocol の `SessionLaunchRequest` に command 上書き (optional) を追加し、daemon 側は override があればそれを使う。
3. 「default」ボタンで config テンプレに戻す (prompt の default ボタンと同パターン)。

## 背景

session_launch は元々 user role 限定 + config 固定 template が「任意コマンド実行させない」根拠だった。user role (webui = 本人) からの override は「本人がターミナルで打つのと等価」なので許容できる、というのが kawaz の裁定。

ただし DR-0018 § 3.2 のセキュリティ記述と矛盾するため、DR に supersede 追記が必要。session role からは従来通り override 不可 (user role 限定は維持)。

## 受け入れ条件

- [ ] SessionCreator フォームに command テンプレの textarea プレビューが表示される
- [ ] textarea の内容をその場で編集でき、「default」ボタンで config テンプレに戻せる
- [ ] `SessionLaunchRequest` protocol に command override (optional) フィールドが追加される
- [ ] daemon 側で override があればそれを使い、無ければ従来通り config テンプレを使う
- [ ] session role からの override は従来通り拒否される (user role 限定を維持)
- [ ] DR-0018 に本変更の supersede 追記がある (§ 3.2 のセキュリティ記述との整合)

## TODO

<!-- wip 時のみ -->
