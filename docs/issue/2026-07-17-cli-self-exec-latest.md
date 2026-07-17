---
title: CLI 起動時 self-redirect (plugin cache 絶対パス起動時に PATH 上の最新へ exec)
status: open
category: request
created: 2026-07-17T11:29:18+09:00
last_read:
open_entered: 2026-07-17T11:29:18+09:00
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

# CLI 起動時 self-redirect (plugin cache 絶対パス起動時に PATH 上の最新へ exec)

## 概要

ccmsg CLI が plugin cache 内のバージョン付き絶対パス (例:
`~/.claude/plugins/cache/ccmsg/ccmsg/<version>/bin/ccmsg`) で起動された場合、
起動直後に自分自身の realpath と `PATH` 上で解決される `ccmsg` の realpath を
比較し、異なれば `exec ccmsg "$@"` で PATH 側 (常に最新版への symlink) に
処理を譲る (self-redirect)。これにより plugin reload を手動で行わなくても
新しい CLI 実装が自動的に使われるようになる。

## 背景

kawaz からの起票依頼 (r26 mid=92)。plugin cache 経由で起動されたセッションが
古いバージョンの `bin/ccmsg` を掴んだまま動き続けるケースがあり、plugin
reload の手間を基本不要にしたいという要望。daemon 側には既に newer-wins の
自動 upgrade があり、本 issue はそれと対になる CLI 側のレールという位置づけ。

## 受け入れ条件

- [ ] `bin/ccmsg` 起動時、自分の絶対パスが plugin cache 配下 (バージョン付き
      パス) であることを検出できる
- [ ] `realpath(自分)` と `realpath(PATH 上の ccmsg)` を比較し、異なる場合は
      `exec ccmsg "$@"` で処理を譲る
- [ ] 無限 exec ループを防止する (`CCMSG_REEXEC=1` 等のフラグで 1 回のみ許可)
- [ ] `PATH` 上に `ccmsg` が存在しない場合はそのまま自分自身の処理を継続する
      (fail-open)
- [ ] `subscribe` 等の長寿命プロセスは、既に起動済みのものは対象外
      (新規起動分からのみ self-redirect が効く前提でよい)

## 設計注意 (起票時メモ)

- redirect 判定は「realpath 不一致」ではなく **semver 比較で PATH 側が自分より
  新しい時のみ exec** する方式にする (kawaz r26 mid=95)。バージョン単調増加が
  保証されるため、exec 先で再判定しても「自分より新しい」は二度成立せず構造的
  に無限ループしない。daemon の newer-wins と同じ判定原理で対称性も良い。
  `CCMSG_REEXEC` ガードは保険として残してもよいが必須ではなくなる
- `PATH` に `ccmsg` が無ければそのまま続行 (redirect 不可時のフォールバック)
- `subscribe` 等の長寿命プロセスは既に起動済みのものはそのまま (新規起動分
  から効けばよい)
- daemon 側の newer-wins 自動 upgrade と対になる CLI 側のレールという位置づけ
- 実装箇所は `bin/ccmsg` エントリポイント
- self-redirect を無効化する試験用環境変数 (例 `CCMSG_NO_SELF_EXEC=1`) を設け、
  リポ内テスト (working copy の bin を直接叩く CLI テスト・integration
  テスト) では常にこれを付けて回避する。付けないと開発中の working copy 版が
  PATH 上の installed 版に exec で乗っ取られ、テスト対象が変わってしまう。
  テストハーネス側 (test ファイルの spawn env) にも一括で仕込むこと
