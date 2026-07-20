---
title: サブエージェントのセッションツリー表示
status: open
category: design
created: 2026-07-20T22:35:52+09:00
last_read:
open_entered: 2026-07-20T22:35:52+09:00
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

# サブエージェントのセッションツリー表示

## 概要

サブエージェント (Agent tool の子) をセッションツリーとして辿れる UI を追加する (kawaz r44 m6-m7 依頼)。要件は 3 点:

1. Status タブにはチームメイト (teams) は表示されるが、Agent tool 経由のサブエージェントが表示されない。これを表示するには収集経路の調査が先に要る
2. 孫エージェント (サブエージェントがさらに Agent tool で起動した子) も含め、最大 5 段まで再帰的にツリーで辿れるようにする。深さ上限とループガードが必要
3. UI は Status タブのリスト表示ではなく、TL 画面の隣にセッションツリーパネルを新設する形。ルート = 現在のセッション、子孫 = サブエージェント/チームメイト、各ノードに live dot + 名前 + TL へのリンクを表示し、折りたたみ可能にする

## 背景

m6 分 (Status タブへの同期サブエージェント表示) は commit 3a001e9e で実装済み (未 push)。原因は `isTrackedToolUse` が `name` / `run_in_background` 無しの同期 Agent tool 呼び出しを追跡していなかったこと。Agent tool を無条件追跡に変更し、agent 行に live dot + TL リンク + agent_type バッジを表示するようにした。

補足: サブエージェントの meta.json に `model` フィールドは存在しない (teammate のみ持つ) ため model 表示は不可、`agent_type` で代替するのが確定情報。

残スコープは m7 分のみ (孫エージェントの再帰収集と専用パネル UI)。

## 受け入れ条件

- [x] Agent tool 経由のサブエージェント (Status タブでの同期表示) がツリー構造で収集できる収集経路の特定 (m6、commit 3a001e9e)
- [ ] 深さ上限 (5 段) とループガードを備えた再帰的なツリー構築ロジック (孫エージェントまで)
- [ ] TL 画面の隣にセッションツリーパネルを新設 (ルート=セッション、子孫=サブエージェント/チームメイト、live dot + 名前 + TL リンク、折りたたみ可)

## TODO

- [ ] 孫エージェント (最大 5 段) の再帰的なツリー収集ロジックを実装 (深さ上限 + ループガード)
- [ ] TL 画面の隣にセッションツリーパネル UI を新設 (現状は Status タブのフラットリスト表示のみ)
