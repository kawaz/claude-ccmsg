---
title: エコシステム外部レビュー(2026-09)の指摘への対応
status: open
category: task
created: 2026-09-10T14:49:25+09:00
last_read:
open_entered: 2026-09-10T14:49:25+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered:
discard_reason:
pending_reason:
close_reason:
blocked_by:
origin: kawaz依頼(2026-09-10、claude-rules-personalセッション経由)
---

# エコシステム外部レビュー(2026-09)の指摘への対応

## 概要

外部レビュー (2026-09-09〜10) のうち本リポ向け指摘 4 件 (V1-1〜V1-4、原文は
`claude-rules-personal` リポの `docs/research/2026-09-10-ecosystem-review/claude-ccmsg.md`)
を実物 (DR INDEX / issue INDEX / DR 本文 / `docs/inbox/` / cmux-msg README) と
照合し、採否を判定した。

温度感 (レビュー README より): 初版の指摘は個別リポの精読が進むたびに覆るケースが
多い。今回も 1 件 (cmux-msg 退役の前提) が実物と食い違っていた。

## 判定結果

### V1-1 (訂正) 退役条件は DR INDEX が持っている — 半分採用・半分却下

- **採用**: DR INDEX (`docs/decisions/INDEX.md`) の「v2 での扱い」列は実機確認済み。
  既に 5 値 (据え置き/契約に吸収/webui へ移管/置き換わる予定/対象外) で全 DR に
  付与されている。残る作業として「v1 を止める条件」の 1 行を DR-0032 §2.2 か
  README の Status に足す提案は妥当 → **TODO** として残す
- **却下**: 「README の『cmux-msg は parity まで維持』は cmux-msg 退役済みなので
  書き換え」という記述は事実誤認。`claude-cmux-msg/main/README.md` を確認したところ
  「A central-daemon successor is being designed... This plugin stays `cmux-msg`
  and remains in active use.」であり、**cmux-msg は退役していない**。この README
  修正提案は却下 (現状の記述で正しい)

### V1-2 ★2 open issue 18 本を INDEX と同じ 4 値で仕分ける — 採用

- 実機確認: `docs/issue/INDEX.md` の active 18 本には、webui 機能要望
  (`timeline-message-hover-toolbar` / `session-list-sections` /
  `webui-connection-log-id` / `keepalive-pause-button` 等) と v2 設計
  (`multi-host-cluster` / `messaging-socket-direct-write`) が実際に混在しており、
  DR INDEX にある「v2 での扱い」列に相当するものが issue INDEX には無い
- 指摘は妥当、**採用**。issue INDEX に列を足し、v2 へ移すものは v2 側に同名 issue を
  立てて v1 側を archive する作業が **TODO** として残る

### V1-3 ★1 「Proposed (実装済み)」の 3 本を閉じる — 採用(裁定待ち)

- 実機確認: DR-0015 / DR-0025 / DR-0028 は Status: Proposed のまま、DR INDEX 上でも
  「Proposed (実装済み)」「webui へ移管 (裁定待ち)」の表記で止まっている (`grep`
  で 3 本とも確認)
- 指摘のロジック (実装済みなら Accepted、webui 移管は移管先が決まるまで Proposed の
  ままにする理由が無い) はそのまま妥当。ただし INDEX 自体が既に「裁定待ち」と
  明記している通り、webui への移管先確定は kawaz 判断が必要 → **裁定待ち**:
  3 本を Accepted に変更してよいか (「webui へ移管」表記だけ残す形で)

### V1-4 ★1 `docs/inbox/` の運用を rules-personal 側へ — 裁定待ち

- 実機確認: `docs/inbox/README.md` に「先行運用 (kawaz 裁定 2026-07-16)。良さそうなら
  claude-rules-personal でルール化して他リポへ展開する」と明記済み。
  `claude-rules-personal` の `reference/` `for-all/` `for-me/` を `rg` したが
  `docs/inbox` への言及は無く、未展開の状態を確認
- 指摘は事実として正確。使い続けるか (→ rules-personal に展開) / 使わない
  (→ v2 に持ち込まず消す) は **裁定待ち** (kawaz 判断)

## TODO

- [ ] V1-1: DR-0032 §2.2 か README Status に「v1 を止める条件」1 行を追記
- [ ] V1-2: issue INDEX に「v2 での扱い」列を追加、v2 へ移す issue を仕分けて
      v2 側に同名 issue を起票・v1 側を archive
- [ ] V1-3: kawaz 裁定待ち — DR-0015/0025/0028 を Accepted 化してよいか
- [ ] V1-4: kawaz 裁定待ち — `docs/inbox/` を rules-personal 側にルール化して
      展開するか、使わずに終わらせるか

## 受け入れ条件

- [ ] V1-3 / V1-4 の裁定待ち 2 件が kawaz の判断で決着している
- [ ] V1-1 / V1-2 の TODO (DR-0032 追記、issue INDEX 列追加と仕分け) が実施されている
