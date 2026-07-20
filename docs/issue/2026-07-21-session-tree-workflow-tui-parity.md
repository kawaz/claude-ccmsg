---
title: セッションツリーの workflow 表示を TUI 同等にリッチ化 (モデル名/tok/状態注記/ドリルダウン)
status: open
category: design
created: 2026-07-21T06:35:39+09:00
last_read:
open_entered: 2026-07-21T06:35:39+09:00
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

# セッションツリーの workflow 表示を TUI 同等にリッチ化 (モデル名/tok/状態注記/ドリルダウン)

## 概要

kawaz が TUI (`/workflows`) の実スクショ 13 枚を提供 (r46m16、2026-07-21 06:05-06:24)。webui ツリーパネル (v0.69.0 のグループ化 + フェーズ done/total) と TUI の表示差分を埋める:

1. agent 行にモデル名 + トークン数 (「Haiku 4.5 · 59k tok」形式、meta.json の model field + journal から)
2. 状態注記 (running / idle Nm Ns / stopped、pause 中は stopped)
3. 未開始フェーズは番号 + 名前の淡色表示 (「3 Finalize」— 宣言済みだが空のフェーズが見える)
4. ノード選択でドリルダウン (Prompt / Activity = 実行中ツールコール / Outcome = 返り値。データ源は TUI と同じ workflow-drilldown 経路 + agent transcript)

kawaz 提供の Status タブ実スクショ (2026-07-21 06:35) で判明した既存 workflow 表示の不具合 2 点もスコープに含める:

5. 同一 workflow run (`wf_666fea3f-0be`、pause→resume を経たもの) が WORKFLOWS セクションに複数回重複表示される。resume は同じ runId を引き継ぐため runId で dedup すべき。表示層だけでなく state.json / 購読経路の記録重複の可能性もあるので daemon 側も確認する
6. モデル名の表記ゆれ。同じ run 内で「haiku」(prep 行) と「claude-haiku-4-5-20251001」(work/finalize 行) が混在。生モデル ID → 表示名 (Haiku 4.5 等) の正規化を一元化する

## 背景

参照スクショは r46m16 の添付 13 枚。前提: v0.69.0 の AgentTreeGroups 構造の上に載せる。

kawaz 方針 (2026-07-21): Status タブの現在の workflow 表示は「まぁまぁ良い」ので、似た感じでセッションツリーに載せる = ゼロから TUI を模写するのでなく、Status タブの既存 workflow 表示コンポーネント/整形ロジック (StatusPanel の workflow セクション) を AgentTreePanel の workflow ノードに再利用する方向。データ経路は v0.69.0 時点で既に両者とも workflow-drilldown で共通なので、表示層の流用が主作業。着手は v0.69.0 の実機確認後。

## 受け入れ条件

- [ ] agent 行にモデル名 + トークン数が表示される
- [ ] running / idle Nm Ns / stopped の状態注記が表示される (pause 中は stopped)
- [ ] 未開始フェーズが番号 + 名前で淡色表示される
- [ ] ノード選択で Prompt / Activity / Outcome のドリルダウンが表示される
- [ ] 同一 workflow run の pause→resume が WORKFLOWS セクションに重複表示されない (runId dedup)
- [ ] モデル名表示を生モデル ID に統一する (kawaz 裁定 2026-07-21: 表示名 (Haiku 4.5 等) への正規化はしない — 情報が減る。「haiku」とフル ID の混在だけ解消し、フル ID 側に揃える)

## TODO

<!-- wip 時のみ -->
