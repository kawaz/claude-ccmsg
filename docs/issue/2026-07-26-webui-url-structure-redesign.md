---
title: "webui の URL 構造を論理的に再設計する"
status: open
category: design
created: 2026-07-26T19:08:12+09:00
last_read:
open_entered: 2026-07-26T19:08:12+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered:
discard_reason:
pending_reason:
close_reason:
blocked_by:
origin: "自リポ TODO"
---

# webui の URL 構造を論理的に再設計する

## 概要

webui の URL 構造を論理的に再設計する。

## 背景

現状の問題:

1. 機能追加のたびに個別実装された結果、URL の構造がバラバラで論理性が無い
2. Terminal タブ・Status タブに URL が無く、リロードすると Timeline に戻ってしまう(タブ状態が URL に載っていない)
3. サブエージェント系の URL に一貫性が無い — teammate(名前で参照)・workspace・素の subagent(agentId で参照)がそれぞれ別形式で、論理的な体系になっていない

## 受け入れ条件

- [ ] (a) 現状の全 URL 形式を棚卸しする(`packages/webui/src/client/locator.ts` が locator の正本、`state.view` / `applyLocatorChanged` も参照)。何がどう表現され、何が URL に載っていないかを一覧化する
- [ ] (b) 論理的な体系を設計する。観点: セッション / タブ / タブ内の状態(Files のパス・Timeline の agent ref・Rooms の room)を階層としてどう表すか、共有可能・リロード耐性のある単位は何か、agent の 3 種(teammate / workspace / subagent)をどう統一的に表すか
- [ ] (c) 移行方針を決める(既存 URL の後方互換をどこまで保つか、pinned session や favorites など locator に依存する永続データへの影響)
- [ ] 設計を kawaz 裁定に出してから実装する
- [ ] TL の位置が URL に載り Back で復元できる
- [ ] タブ状態が URL に載りリロードで維持される
- [ ] タブ切替でアンマウントせず状態を保持する(URL 設計とは別軸だが同時に解決すべき)
- [ ] agent 3 種が対称な表現になる

## 備考

同時期に FileTree の root を repo_root から cwd に戻す変更を実施しており、locator の path 表現に影響する可能性がある。

## 追加要望 (kawaz r55m100)

1. TL の URL に jsonl の行 id を含めたい。用途: TL 閲覧中に Files や他セッションへ移動する瞬間に `tl/<id>` を history に積んでおけば、Back で戻った時に TL が進んでいても最後に見ていた位置から続きを追える
2. history API を活用した SPA 強化をしたい(現状は hash のみ + `location.assign`)
3. File と TL を交互に移動すると TL タブに戻るたびにリロードされ、さっき見ていた位置がすぐ出ない

## 現状の棚卸し (2026-07-26)

全 URL 形式:

- `#rN` (room)
- `#rN-mM` (room の特定メッセージ)
- `#s<sid>` (Files タブ)
- `#s<sid>:<path>` (ファイル)
- `#s<sid>:<path>:L10-20` (行範囲)
- `#t<sid>` (Timeline タブ)
- `#t<sid>:a<id>` (素の subagent)
- `#t<sid>:wf_XXX/a<id>` (workflow 配下 agent)
- `#t<sid>:tm/<name>` (teammate)

内部表現 Locator は room / session(=Files) / timeline の 3 種のみ。

問題点:

- (a) 接頭辞が場当たり的で room だけ無印・Files が `s`・Timeline が `t`、同一セッションの別タブなのに分かれておりタブという概念が URL に無い
- (b) Terminal / Status / Rooms タブに対応する view が無くリロードで戻ってしまう
- (c) 区切り文字が多義的(`:` がタブ内状態と行範囲の両方、`/` が runId/agentId と `tm/name` で別の意味)
- (d) agent 3 種が非対称(teammate だけ `tm/` 付き、workflow は 2 セグメント、subagent は裸)
- (e) room とセッションが同じ名前空間で階層関係が不明示

## 設計の叩き台 (main 私案、未裁定)

`#<種別>/<id>/<タブ>/<タブ内状態>` の階層構造案:

- `#s/<sid>/files/<path>`
- `#s/<sid>/timeline`
- `#s/<sid>/timeline/<uuid>` (位置)
- `#s/<sid>/timeline/agent/tm/<name>` | `agent/wf/<runId>/<agentId>` | `agent/sub/<agentId>`
- `#s/<sid>/terminal`
- `#s/<sid>/status`
- `#s/<sid>/rooms`
- `#r/<roomId>`
- `#r/<roomId>/m<mid>`

位置 id は jsonl 各行の `uuid` フィールドを使う(実データで存在確認済み。byte offset より堅く、前方の行が書き換わってもずれない)。

## 解決時の記録先

- 設計判断を伴う: `decisions/DR-NNNN-...md`
