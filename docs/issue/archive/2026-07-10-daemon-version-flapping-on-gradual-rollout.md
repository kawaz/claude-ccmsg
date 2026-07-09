---
title: gradual rollout 中に daemon version flapping で頻繁に再起動する
status: resolved
category: bug
created: 2026-07-10T02:51:21+09:00
last_read:
open_entered: 2026-07-10T02:51:21+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-07-10T03:35:44+09:00
discard_reason:
pending_reason:
close_reason: ["implemented","dr/DR-0002"]
blocked_by:
origin: 自リポ TODO
---

# gradual rollout 中に daemon version flapping で頻繁に再起動する

## 概要

plugin update の段階的ロールアウト中 (各セッションの plugin cache 版がバラバラ) に、
daemon が再起動を繰り返す。DR-0002 §4 の version mismatch 検出が **等値比較**のため、
旧版セッションの hook (`ensureDaemon`) が新しい daemon を旧版に「降格」させ、新版
クライアントが再び昇格させる、というループが発生する。

## 背景

2026-07-10 に実観測: 0.2.0 の hook が動くセッションと 0.2.1 のセッションが混在する
状態で、subscribe が `restarting (reason: upgrade)` により数分おきに切断された。

影響: 全セッションの sidecar 切断が頻発する。ただし `UserPromptSubmit` hook の nag
から再接続はされるため、自然回復はする (= 致命的ではないが体感が悪い)。

原因の所在: `packages/cli/src/client.ts` の `ensureDaemon` が、daemon 起動時の
バージョンチェックで**等値比較**をしている (= 自分のバージョンと daemon のバージョンが
一致しないと問答無用で再起動させる)。これにより新旧混在環境で降格・昇格の綱引きが起きる。

## 受け入れ条件

- [ ] gradual rollout (新旧 plugin cache 混在) 環境で daemon が不要な再起動を繰り返さない
- [ ] 修正方針を決定 (下記 2 案のいずれか、または他案)。要検討事項: (a) が素直だが、
      DR-0006 で進行中の breaking protocol 変更と同時に入れるかは分けて判断する

### 修正案 (要検討)

- (a) client は自バージョン > daemon バージョンのときだけ入れ替える (semver 比較を
  protocol に持つか、単純な semver parse で足りるか要検討)
- (b) 降格要求は無視して接続続行する (旧 client が新 daemon と話せる範囲の互換性
  設計が要る)

## 解決

修正案 (a) を採用: `ensureDaemon` を newer-wins に変更 (client が daemon より
厳密に新しい semver のときのみ shutdown→respawn、同じか新しい daemon は許容)。
`packages/protocol/src/version-compare.ts` に `compareVersions` を新設し、
「daemon が新しい場合は再起動しない」テストを追加。DR-0002 §4 に追補注記済み。
commit cb15be7e。

残存制約: 0.2.x 以前の旧版クライアントは等値比較のままなので、旧版セッションが
残っている限り降格挙動自体は再現しうる。完全収束は全セッションが修正版へ
plugin reload された後。修正版以降の混在では本問題は再発しない。

## 関連

- DR-0002 §4 (version mismatch 検出の設計箇所)
- `packages/cli/src/client.ts` の `ensureDaemon`
