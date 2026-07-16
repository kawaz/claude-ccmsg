---
title: fs_write の containment root が jj workspace 運用と噛み合わず inbox メモが迷子になる
status: resolved
category: design
created: 2026-07-16T18:19:04+09:00
last_read:
open_entered: 2026-07-16T18:19:04+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-07-16T23:21:04+09:00
discard_reason:
pending_reason:
close_reason: ["done:fs_write の相対 path 基点を session cwd に変更 (containment root 検査は維持、inbox prefix は cwd 相対で判定); jj workspace セッションでも main/docs/inbox/ に落ちて jj status で検知可能なことを実daemon+jj実機で確認 (検証21/21 PASS); commit dfcc14b7"]
blocked_by:
origin: 自リポ TODO (DR-0019 Phase W2 検査時の fable 発見)
---

# fs_write の containment root が jj workspace 運用と噛み合わず inbox メモが迷子になる

## 概要

`fs_write` の containment root が `repo_root ?? cwd` になっているため、jj
workspace 運用セッション (repo_root = コンテナ dir) では inbox メモが
`.../claude-ccmsg/docs/inbox/` (コンテナ直下) に落ちる。この場所はどの
working copy にも属さないため、`jj status` で AI が変更に気づけない。
`docs/inbox/README.md` が前提とする運用 (= inbox は各 workspace から見える
場所にある) と矛盾している。

`main/docs/inbox/...` のように明示的に workspace 配下を指定しても
`path_not_writable` で拒否される (実機検証済み)。

## 背景

DR-0019 Phase W2 の検査時に fable が発見。write policy の許可 prefix が
`repo_root ?? cwd` の 1 本に固定されており、jj workspace 構成 (コンテナ dir
+ 複数 working copy) を考慮していない。

修正候補: 許可 prefix を `<ws>/docs/inbox/` にも広げる等の write policy
境界拡張。ただしこれは認可境界の設計判断であり、影響範囲 (他の write 経路
にも同様の穴がないか等) を含めて kawaz の裁定が必要。

関連: DR-0019、`packages/daemon/src/fs-access.ts` の `fsWrite`

## 受け入れ条件

- [ ] jj workspace 運用セッションで inbox メモが書き込まれる場所が、どの
      working copy からも `jj status` で検知可能になっている
- [ ] write policy の境界拡張方針について kawaz の裁定が反映されている

## TODO

<!-- wip 時のみ -->
