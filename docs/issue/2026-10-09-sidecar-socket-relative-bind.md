---
title: サイドカー socket を cwd 相対パスで bind / connect して退避先 (別置き場) をなくす
status: open
category: task
created: 2026-10-09T08:18:10+09:00
last_read:
open_entered: 2026-10-09T08:18:10+09:00
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

# サイドカー socket を cwd 相対パスで bind / connect して退避先 (別置き場) をなくす

## 概要

サイドカーの socket の置き場 (`packages/protocol/src/paths.ts` の `resolveSidecarDir` 等) は、`<stateDir>/sidecars/<sid>.<pid>.sock` の絶対パスが sun_path (macOS 104 バイト) に収まらない時、`/tmp/claude-ccmsg-<uid>/sidecars/` に退避する設計になっている (v2 の sidecarDir を移植したもの)。

しかし sun_path の制限は bind / connect に渡すパス文字列の長さの制限で、置き場の制限ではない。そのディレクトリに cd してから相対パスで bind / connect すれば、置き場を分けずに済む。退避先を持つと置き場が 2 か所になり、daemon とサイドカーが同じ判定を共有する必要が生じる。

実機確認 (2026-10-09 統括): 166 文字のフルパスは `AF_UNIX path too long` で失敗、同じディレクトリに cd して相対パスで bind / connect すると成功。

## 背景

今の環境では既定の dir に収まっており退避は使われていないので急ぎではない。v2 (kawaz/ccmsg) の sidecarDir も同じ設計なので、結論が出たら v2 にも還元する。

## 調べること

1. サイドカー (`ccmsg sidecar`) は単独プロセスなので、bind の前に chdir して相対パスで bind するのは容易。
2. daemon 側は常駐プロセスの中で多数のセッションの socket に connect するので、process 全体の cwd を変える chdir は他の非同期処理と干渉する。Bun / Node で dir fd 基準の connect ができるか、短命の子プロセスや別の手段で相対パスの connect ができるかを確かめる。
3. 置き換えられるなら退避先と判定 (`MAX_SAFE_INTEGER` の pid で最長を見積もる処理) を消す。

## 受け入れ条件

- [ ] daemon 側から相対パス (または同等の手段) で connect できるかの調査結果を記録
- [ ] 置き換え可能なら退避先 (`/tmp/claude-ccmsg-<uid>/sidecars/`) と長さ判定を削除し、置き場を 1 か所にする
- [ ] 結論を v2 (kawaz/ccmsg) に還元
