---
title: quota 表示ページで再ログインが必要な credential にログインボタンを置く
status: resolved
category: request
created: 2026-09-02T15:02:31+09:00
last_read:
open_entered: 2026-09-02T15:02:31+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-09-04T14:41:27+09:00
discard_reason:
pending_reason:
close_reason: ["done:usage 再ログインリンク+reason 表示+expired 表示 実装済み(v0.144系)、kawaz が実機で再ログイン動作を確認(r273m1)"]
blocked_by:
origin: llm-gateway (依頼元プロジェクト)
---

# quota 表示ページで再ログインが必要な credential にログインボタンを置く

## 概要

llm-gateway v0.29.0 で `GET /llm-gateway/usage` の各 credential に `auth` フィールドが付くようになった。ccmsg の LLM usage 表示側で `auth.status` に応じたログイン導線・reason 表示・expired window の区別表示を実装する。

## 背景

llm-gateway からの依頼 (kawaz 指示 2026-09-02)。

`auth` フィールドの仕様:

- `auth.status` = `ok` | `relogin_required` | `degraded`
- `relogin_required` / `degraded` のとき `auth.reason` (英文、CLI コマンド入り) と `auth.observed_at_iso` が付く
- `relogin_required` かつ `claude_oauth` のときのみ `auth.login_path` (相対パス、例 `/llm-gateway/login/<cred>/start`) — **v0.30.0 で追加予定 (実装中、v0.29.0 時点では未提供)**
- gateway は公開 origin を知らないため相対パスで返す設計。ccmsg 側で usage を叩く base URL に連結して絶対 URL にする
- ログインボタンは `target=_blank` 推奨
- 各 window (5h/7d) に `expired: true` が付くことがある = reset 時刻を跨いだ古い観測で現在値ではない。表示で区別が要る

仕様正本: llm-gateway リポの `docs/MANUAL-ja.md` の usage 節。

ccmsg 側の該当コード: `packages/webui/src/client/llm-usage-view.ts` および LLM usage 表示コンポーネント。

備考: 依頼元は旧リポ claude-cmux-msg に同名 issue を誤起票済み (ローカル commit、未 push)。本 issue が正、旧リポ側は依頼元に破棄を依頼済み。

## 受け入れ条件

- [ ] `auth.status` が `relogin_required` の credential にログインボタン (base URL + `login_path`、`target=_blank`) が出る
- [ ] `auth.reason` がボタン付近に表示される (`degraded` でも reason は表示)
- [ ] window の `expired: true` が表示に反映され、古い観測値と分かる
- [ ] `login_path` 未提供 (v0.29.0 gateway) でもボタン無しで壊れない
