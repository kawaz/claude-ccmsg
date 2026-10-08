---
title: claude plugin validate が plugin 名 claude-ccmsg を reserved として error にする
status: open
category: bug
created: 2026-10-08T11:51:25+09:00
last_read:
open_entered: 2026-10-08T11:51:25+09:00
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

# claude plugin validate が plugin 名 claude-ccmsg を reserved として error にする

## 概要

Claude Code 2.1.293 の `claude plugin validate .` が、このリポの plugin 名 `claude-ccmsg` を "reserved" として error にする。DR-0035 段 1 の実装中に判明した。今回の変更より前からある状態。

2.1.293 では plugin も hooks module も問題なく読まれるが、validate は失敗のまま。`just ci` の validate 段が落ちる可能性と、将来の build で読み込みを拒否される可能性がある。

## 背景

未確認事項: validate の正確な error 文言 (起票時点で手元に無い)。次に validate を実行した時にここへ貼る。

## 受け入れ条件

- [ ] reserved とされる規則 (`claude-` で始まる名前か等) を validate の出力・公式 docs・claude-plugin-reference skill で確認する
- [ ] plugin 名の変更が要るか判断する
- [ ] 要る場合、marketplace 名・インストール済み環境の移行手順を決める
- [ ] `claude plugin validate .` が通る (または通らないままで良い根拠が記録されている)
