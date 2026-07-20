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

Status タブは既にチームメイト表示を持つが、Agent tool 経由の子は別経路で扱われており見えていない。参考実装候補として webui の `Timeline.tsx` にある `AgentTimelineHrefsContext` (teammates + workflow agents から sid を解決するロジック) が収集の土台として使えそうだが未確認。daemon 側では `packages/daemon/src/agents.ts` の poller が関連候補として挙がっている。

kawaz からの依頼を受けて着手したが、コンテキスト残量不足のため調査未着手のまま中断 (2026-07-20)。

## 受け入れ条件

- [ ] Agent tool 経由のサブエージェント (孫を含め最大 5 段) がツリー構造で収集できる収集経路の特定
- [ ] 深さ上限 (5 段) とループガードを備えた再帰的なツリー構築ロジック
- [ ] TL 画面の隣にセッションツリーパネルを新設 (ルート=セッション、子孫=サブエージェント/チームメイト、live dot + 名前 + TL リンク、折りたたみ可)

## TODO

- [ ] `Timeline.tsx` の `AgentTimelineHrefsContext` (teammates + workflow agents → sid 解決) の実装を読み、サブエージェント収集にも転用できるか確認
- [ ] `packages/daemon/src/agents.ts` の poller が Agent tool 子エージェントの情報を持っているか調査
- [ ] Status タブでチームメイトのみ表示されサブエージェントが表示されない原因 (収集経路の欠落箇所) を特定
