---
title: plugin キャッシュに旧版が溜まり続けて 11 GB になっている (1 版 約 150 MB × 74 版)
status: open
category: bug
created: 2026-11-12T00:18:08+09:00
origin: kawaz/diskdrift
---

# plugin キャッシュに旧版が溜まり続けて 11 GB になっている (1 版 約 150 MB × 74 版)

## 概要

`~/.claude-personal/plugins/cache/ccmsg-v1/ccmsg-v1/` に 74 版 (0.183.0 〜 0.252.0) が残り、合計 11.3 GB。最古の 0.183.0 は 2026-11-02 の更新で、10 日で 74 版ぶん積もっている。1 版は約 0.2 GB で、内訳は `node_modules` 145 MB / `packages` 9 MB / `docs` 3 MB。起動ディスクは使用率 98 % で逼迫中。

## 背景

kawaz/diskdrift の初回計測 (2026-11-12) での観測。利用側では削除していない。旧版の削除候補として kawaz に提示済み (diskdrift の `docs/findings/2026-11-12-initial-measurement.md` の A4)。

再現コマンド:

```
/usr/bin/du -sk ~/.claude-personal/plugins/cache/ccmsg-v1
ls ~/.claude-personal/plugins/cache/ccmsg-v1/ccmsg-v1 | wc -l
/usr/bin/du -sk ~/.claude-personal/plugins/cache/ccmsg-v1/ccmsg-v1/0.251.0/*
```

部外者からのフラグ (裏取りしてから採否を決めてください):

- 旧版を消さないのは Claude Code の plugin キャッシュ側の挙動の可能性があり、ccmsg の責務かどうかは未確認
- ccmsg 側で効きそうな点は 2 つ見えた: (1) 版ごとに `node_modules` 145 MB を同梱している (配布物を bundle 済みにできれば 1 版が小さくなる)、(2) リリース頻度が高く 10 日で 74 版になる
- 別件で、`$TMPDIR/ccmsg-main-wpgSh5` に jj workspace らしきディレクトリが 50 個ほど残り 3.0 GB あった (2026-11-11 の作成)。作業用 workspace の後始末漏れかどうかは未確認

## 受け入れ条件

- [ ] 旧版が溜まる原因が ccmsg 側か Claude Code 側かを切り分けた
- [ ] ccmsg 側で減らせる点 (配布物の大きさ、リリース頻度、workspace の後始末) について採否を決めた
