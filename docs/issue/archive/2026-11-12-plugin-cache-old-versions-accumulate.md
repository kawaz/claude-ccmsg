---
title: plugin キャッシュに旧版が溜まり続けて 11 GB になっている (1 版 約 150 MB × 74 版)
status: resolved
category: bug
created: 2026-11-12T00:18:08+09:00
origin: kawaz/diskdrift
close_reason: documented
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

## 裁定と対処 (2026-11-20)

kawaz の裁定で、使用中でない旧版を手で消した。使用中の判定は、動いている全プロセスの引数と環境 (PATH 等) に現れる版と、各 config dir の install 中の版 (0.298.0)。消したのは 332 版 (personal 102 → 18 版、emrd 102 → 9 版、bare 156 → 1 版)。`du` では約 17.7 GB が減ったが、ディスクの空きは約 5 GB しか増えなかった。node_modules の中身は bun install が複製 (APFS の clone 等) で置いていて、版どうしで実体を共有していたと見ている (未確認)。消えない理由の切り分け (使用中でなくなった orphaned の版がいつ消えるか) は続ける。

## 切り分けの結果 (2026-11-25)

正本は [findings 2026-11-25-plugin-cache-versions](../../findings/2026-11-25-plugin-cache-versions.md)。

- 旧版を消すのは Claude Code の役目で、決まりどおりに動いている。使われなくなった版に `.orphaned_at` が付き、その 14 日後に、生きている claude の印 (`.in_use/<pid>`) が無ければ、claude の起動の時の掃除で消える。溜まって見えるのは、1 日に出す版の数と 14 日の猶予の掛け算
- `du` の合計は見かけで、`node_modules` は bun の global cache の APFS clone なので、版を消しても空かない。1 版の実体は `node_modules` の外の約 17 MiB
- ccmsg が自分の旧版を消すのは責務の外 (キャッシュは Claude Code の持ち物)
- ccmsg の側の案 (配布物を動かすのに要る分だけにする、依存を持たない bundle で配る) は採らない。減らせる実体が 1 版あたり十数 MiB で、配布の形を変える代償に見合わない
