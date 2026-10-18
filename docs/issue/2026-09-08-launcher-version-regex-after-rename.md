---
title: launcher-version-regex-after-rename
status: open
category: bug
created: 2026-09-08T12:48:00+09:00
last_read: 2026-10-18T17:37:18+09:00
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

`bin/ccmsg` の `__ccmsg_extract_version` は `/ccmsg/<ver>/` パターンを要求するため、改名後の cache パス `cache/claude-ccmsg/claude-ccmsg/<ver>/` に一致せず、self-update / self-exec が無効化されている。

## 背景

DR-0032 §2.2-4 の最終 patch で PATH symlink と self-exec を意図的に停止する方針なら、regex 修正は不要でそのまま「停止扱い」として確定させてよい。その判断自体をこの issue で明示的に処理する (= 直すか、意図的に停止のまま確定するかを決める)。

今回の暫定対応として、`~/.local/bin/ccmsg` を手動で 0.152.4 に付け替えて凌いだ(2026-09-08)。

## 追記 (plugin 改名)

plugin 名を `ccmsg-v1` に改名した (commit 96baae2d)。cache のパスは `plugins/cache/claude-ccmsg/ccmsg-v1/<ver>/` (`<marketplace>/<plugin>` の形) になる。下の受け入れ条件に書かれたパス `cache/claude-ccmsg/claude-ccmsg/<ver>/` は古いので、`ccmsg-v1` の形に読み替える。`bin/ccmsg` の `__ccmsg_extract_version` が `/ccmsg/<ver>/` の形にしか一致しない問題は今も残っている。

## 受け入れ条件

- [ ] DR-0032 §2.2-4 を確認し、self-exec / self-update を維持する設計か、停止する設計かを判定する
- [ ] 維持する設計なら `__ccmsg_extract_version` の regex を改名後のパス (`cache/claude-ccmsg/claude-ccmsg/<ver>/`) に一致するよう修正する
- [ ] 停止する設計なら、その旨をコード上 (もしくは DR) で明示し、手動運用 (今回のような手動 symlink 付け替え) が正規の運用手順であることを明記する
