---
title: webui の Terminal タブが出ない: 本番 config.ts の構文エラーで daemon の設定が空になっている
status: open
category: bug
created: 2026-09-16T18:30:13+09:00
last_read:
open_entered: 2026-09-16T18:30:13+09:00
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

# webui の Terminal タブが出ない: 本番 config.ts の構文エラーで daemon の設定が空になっている

## 概要

webui (v1) で SessionView の Terminal タブが表示されない。調査の結果、ccmsg 側のコード経路 (daemon hello の terminal_gateway_url → AppState.terminalGatewayUrl → SessionView の hasTerminal、agents poll の hyoui_session_id 注釈) はいずれも健全で、原因は daemon が読む設定ファイル `<configDir>/config.ts` が構文エラーで読み込めず、設定全体が空に落ちていること。

## 背景

実機確認:

1. v1 の loadConfig を本番 configDir に対して読み取り専用で実行すると `config: <configDir>/config.ts: could not be loaded (AggregateError: 4 errors building ...); treating as empty` と警告し、解決後の設定キーは空。
2. 同ファイルを dynamic import すると `Expected identifier but found "\n"` / `Expected "}" but found "..."` / `Expected "}" but found "params"` / `Unexpected }` の 4 件。
3. 実体は config.ts 冒頭 genTemplate 内 PROMPT の `].join("\n")."\n",` (ドット結合のタイポ、`+` のはず)。

影響は Terminal タブだけでなく session_launcher / llm_usage_url / llm_stats_url / sandbox_origin_template など config 由来の導線すべてが無効化される。

対処案 (未実施、本番設定は触っていない): 設定ファイル側のタイポ修正。加えて ccmsg 側の改善余地として、設定ファイルの読み込み失敗が warn ログのみで UI からは「機能が存在しない」状態と区別できない点があり、webui へ「config の読み込みに失敗している」ことを伝える導線か、起動時のより目立つ通知を検討したい。

参考: daemon 側 `packages/daemon/src/config.ts` の loadConfig / readJsConfig、webui 側 `packages/webui/src/client/components/SessionView.tsx` の hasTerminal。

## 受け入れ条件

- [ ] 本番 config.ts のタイポを修正し、Terminal タブおよび config 由来の各導線が復旧する
- [ ] config 読み込み失敗時に webui 側で「機能が存在しない」状態と区別できる通知経路を検討・実装する

## TODO

<!-- wip 時のみ -->
