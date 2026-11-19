---
title: セッションの開始と終了の hook が ccmsg の知らないコマンド (hello / stopping) を呼んで失敗している
status: resolved
category: bug
created: 2026-11-16
close_reason: implemented
---
# セッションの開始と終了の hook が ccmsg の知らないコマンド (hello / stopping) を呼んで失敗している

## 観測 (2026-11-15、worker が試験用の claude を起こした時の stderr)

- セッションの開始時: `SessionStart:startup hook error … ccmsg: unknown command 'hello'`
- セッションの終了時: SessionEnd の hook `ccmsg stopping --hook` が `ccmsg: unknown command 'stopping'` で失敗
- それでも、試験用のセッションのサイドカーは隔離 daemon に名乗れていた (v1 の module の動きには影響していない)
- 2 回 (別々の worker の作業) で出ている

## 分かっていないこと (未調査)

- どの plugin・設定の hook が呼んでいるか。旧い ccmsg (v2 の plugin `ccmsg`) の hook が、PATH にある v1 の `ccmsg` を呼んでいるように見えるが、確かめていない
- 普段のセッションでも毎回出ているか

## 原因 (2026-11-19 に確かめた)

- 呼んでいるのは v2 の plugin `ccmsg@ccmsg` (1.3.0) の `hooks/hooks.json`。SessionStart で `ccmsg hello --hook`、PostToolUse (PushNotification) で `ccmsg notify --hook`、SessionEnd で `ccmsg stopping --hook` を、PATH の `ccmsg` に対して呼ぶ
- PATH の `ccmsg` は `~/.local/bin/ccmsg -> ccmsg-v1` (v1 の 0.286.0)。v1 には `hello` / `stopping` が無いので失敗する
- personal の settings では `ccmsg@ccmsg` と `ccmsg-v1@ccmsg-v1` の両方が有効なので、普段のセッションでも毎回呼ばれている

## 決めること

- 原因の特定と、どちらの側 (hook を持つ plugin / PATH の `ccmsg`) で直すか

## 対処 (2026-11-19)

kawaz の裁定で、v2 の plugin `ccmsg@ccmsg` を personal と emrd の config dir から uninstall した (`claude plugin uninstall ccmsg@ccmsg`)。hook を持つ plugin が無くなったので、`hello` / `stopping` は呼ばれない。claude-rules-personal の `repos_mapping` の bare 面の plugin 一覧も `ccmsg-v1@ccmsg-v1` に直した。
