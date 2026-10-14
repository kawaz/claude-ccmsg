---
title: classic hook を mods に寄せる、TL の応答中を module の event で即時通知する
status: open
category: design
created: 2026-10-14T11:21:50+09:00
last_read: 2026-10-14T17:24:34+09:00
open_entered: 2026-10-14T11:21:50+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered:
discard_reason:
pending_reason:
close_reason:
blocked_by:
origin: 自リポ TODO (kawaz 2026-10-14)
---

# classic hook を mods に寄せる、TL の応答中を module の event で即時通知する

## 概要

2 件の設計検討。

1. classic hook を mods に寄せる。hooks.json の command hook `session-start.ts` (state file の書き出しと daemon start) は module の `session.start` から `bin/ccmsg` を呼ぶ形に統合できる。module 内の `classic.SessionStart` (sidecar 起動契機) は `session.start` に寄せられる。`classic.UserPromptSubmit` (fill した文の受け付け確認、DR-0035 §4 の裁定) は `prompt.submit` で同じ判定ができるか実機で確かめてから行う (できるなら裁定の変更が要る)。
2. TL の更新遅れ。今は Claude Code が transcript に書いた行を fs.watch + 2 秒 backup poll で検知して push しているが、assistant の行は応答完了後に 1 行で書かれるので端末の streaming より遅れて見える。module が受けられる event (`turn.start` / `turn.complete` / `tool.call` 等、builtin module が購読しているもの) を daemon に即時通知し、TL に「応答中」の状態を出せないか。Claude Mods の reference で event 一覧と内容を確認して設計する。

## 背景

kawaz 2026-10-14 の指示。DR-0035 §4 の裁定 (UserPromptSubmit の扱い) に触れるため、`prompt.submit` で同等の判定ができるかを実機で確かめてから裁定変更の要否を決める。

## 受け入れ条件

- [ ] `session.start` で session-start.ts と classic.SessionStart の役割を置き換えられるか実機確認し、結論を記録
- [ ] `prompt.submit` が classic.UserPromptSubmit と同じ判定をできるか実機確認し、DR-0035 §4 の変更要否を決める
- [ ] Claude Mods reference で event 一覧とペイロードを確認し、daemon への即時通知と TL の「応答中」表示の設計を DR にまとめる
