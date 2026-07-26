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

## 備考

同時期に FileTree の root を repo_root から cwd に戻す変更を実施しており、locator の path 表現に影響する可能性がある。

## 解決時の記録先

- 設計判断を伴う: `decisions/DR-NNNN-...md`
