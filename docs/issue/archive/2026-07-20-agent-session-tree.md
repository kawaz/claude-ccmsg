---
title: サブエージェントのセッションツリー表示
status: resolved
category: design
created: 2026-07-20T22:35:52+09:00
last_read:
open_entered: 2026-07-20T22:35:52+09:00
wip_entered: 2026-07-20T23:53:09+09:00
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-07-21T02:11:07+09:00
discard_reason:
pending_reason:
close_reason: ["done: m7 完了 (v0.68.0)。agent_tree を SessionStatusSnapshot に追加 (subagents/ meta.json の toolUseId+spawnDepth で親子リンク、depth cap 5、orphan/teammate は root 直下)、AgentTreePanel を Timeline 隣 2 カラムで新設 (live dot + TL リンク + agent_type バッジ + details 折りたたみ)。実機確認 green (verify worker、孫 2 段 + teammate + orphan + mtime 両状態)。既知の限界: depth>=1 の live 判定は transcript mtime 2 分閾値の近似 (long-running tool call 中に false stopped になり得る、Design rationale はコード内)。パネル全体トグルと PaneSplitter 動的リサイズは MVP で未実装 (要望が出たら追加)"]
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

### m7 偵察結果 (実装着手時点)

`subagents/` は root 配下 flat 構造。`meta.json` の `toolUseId` + `spawnDepth` で親子リンクが可能と判明。
方針: `SessionStatusSnapshot` に `agent_tree` を追加し、`SessionView` を Timeline+Tree の 2 カラム化 (既存 `PaneSplitter` を再利用)。
深い孫の live 判定は実装時に実機検証で確定する (未検証事項として残る)。

## 受け入れ条件

- [x] Agent tool 経由のサブエージェント (Status タブでの同期表示) がツリー構造で収集できる収集経路の特定 (m6、commit 3a001e9e)
- [ ] 深さ上限 (5 段) とループガードを備えた再帰的なツリー構築ロジック (孫エージェントまで)
- [ ] TL 画面の隣にセッションツリーパネルを新設 (ルート=セッション、子孫=サブエージェント/チームメイト、live dot + 名前 + TL リンク、折りたたみ可)

## TODO

- [ ] 孫エージェント (最大 5 段) の再帰的なツリー収集ロジックを実装 (深さ上限 + ループガード)
- [ ] TL 画面の隣にセッションツリーパネル UI を新設 (現状は Status タブのフラットリスト表示のみ)
