---
title: launcher-version-regex-after-rename
status: open
category: bug
created: 2026-09-08T12:48:00+09:00
last_read:
open_entered: 2026-09-08T12:48:00+09:00
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

# launcher-version-regex-after-rename

## 概要

`bin/ccmsg` の `__ccmsg_extract_version` は `/ccmsg/<ver>/` パターンを要求するため、
改名後の cache パス `cache/claude-ccmsg/claude-ccmsg/<ver>/` に一致せず、
self-update / self-exec が無効化されている。

## 背景

DR-0032 §2.2-4 の最終 patch で PATH symlink と self-exec を意図的に停止する方針なら、
regex 修正は不要でそのまま「停止扱い」として確定させてよい。その判断自体をこの issue で
明示的に処理する (= 直すか、意図的に停止のまま確定するかを決める)。

今回の暫定対応として、`~/.local/bin/ccmsg` を手動で 0.152.4 に付け替えて凌いだ
(2026-09-08)。

## 受け入れ条件

- [ ] DR-0032 §2.2-4 を確認し、self-exec / self-update を維持する設計か、停止する設計かを判定する
- [ ] 維持する設計なら `__ccmsg_extract_version` の regex を改名後のパス (`cache/claude-ccmsg/claude-ccmsg/<ver>/`) に一致するよう修正する
- [ ] 停止する設計なら、その旨をコード上 (もしくは DR) で明示し、手動運用 (今回のような手動 symlink 付け替え) が正規の運用手順であることを明記する
