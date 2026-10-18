---
title: classic hook を mods に寄せる、TL の応答中を module の event で即時通知する
status: resolved
category: design
created: 2026-10-14T11:21:50+09:00
last_read: 2026-10-18T19:20:35+09:00
open_entered: 2026-10-14T11:21:50+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-10-18T19:40:06+09:00
discard_reason:
pending_reason:
close_reason: ["dr/DR-0039","dr/DR-0035","implemented"]
blocked_by:
origin: 自リポ TODO (kawaz 2026-10-14)
---

# classic hook を mods に寄せる、TL の応答中を module の event で即時通知する

## 概要

2 件の設計検討。

1. classic hook を mods に寄せる。hooks.json の command hook `session-start.ts` (state file の書き出しと daemon start) は module の `session.start` から `bin/ccmsg` を呼ぶ形に統合できる。module 内の `classic.SessionStart` (sidecar 起動契機) は、`/clear` では `session.start` が起きず `classic.SessionStart (source: clear)` だけが起きる (findings 2026-10-14-mods-vs-transcript-information-sources で 2.1.299 実測)。寄せるなら `session.end (clear)` を受けて次の event で `$.session.id()` を読み直す形になる。また `classic.SessionStart` は compact の後にも起き、turn の途中でありうる。`classic.UserPromptSubmit` (fill した文の受け付け確認、DR-0035 §4 の裁定) は `prompt.submit` で同じ判定ができるか実機で確かめてから行う (できるなら裁定の変更が要る)。
2. TL の更新遅れ。今は Claude Code が transcript に書いた行を fs.watch + 2 秒 backup poll で検知して push しているが、assistant の行は応答完了後に 1 行で書かれるので端末の streaming より遅れて見える。module が受けられる event (`turn.start` / `turn.complete` / `tool.call` 等、builtin module が購読しているもの) を daemon に即時通知し、TL に「応答中」の状態を出せないか。Claude Mods の reference で event 一覧と内容を確認して設計する。

実装済み (TL の応答中): hooks module が turn.start / turn.complete を session facts (DR-0035 §3 の「セッションの事実」、ccmsg sidecar facts → daemon の session_facts) で送り、snapshot の turn と TL 末尾の「応答中」の行として出している。sidebar の行の状態は `claude agents --json` の poll のまま (全セッション分を module の事実で置き換えるには daemon が agents の行に重ねる形を決める必要がある)。

## 背景

kawaz 2026-10-14 の指示。DR-0035 §4 の裁定 (UserPromptSubmit の扱い) に触れるため、`prompt.submit` で同等の判定ができるかを実機で確かめてから裁定変更の要否を決める。

## 受け入れ条件

- [x] `session.start` で session-start.ts と classic.SessionStart の役割を置き換えられるか実機確認し、結論を記録 (DR-0039 で classic 全廃として済み)
- [x] `prompt.submit` が classic.UserPromptSubmit と同じ判定をできるか実機確認し、DR-0035 §4 の変更要否を決める (DR-0039 で済み)
- [x] Claude Mods reference で event 一覧とペイロードを確認し、daemon への即時通知と TL の「応答中」表示の設計を DR にまとめる (DR-0035 §3 に記載。TL の応答中、sidebar の状態の置き換えとも実装済み)
