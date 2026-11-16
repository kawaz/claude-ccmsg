---
title: セッションの開始と終了の hook が ccmsg の知らないコマンド (hello / stopping) を呼んで失敗している
status: open
category: bug
created: 2026-11-16
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

## 決めること

- 原因の特定と、どちらの側 (hook を持つ plugin / PATH の `ccmsg`) で直すか
