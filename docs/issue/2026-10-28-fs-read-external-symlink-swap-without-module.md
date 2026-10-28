---
title: module の無いセッションの fs_read_external は毎回の走査で allowlist を作り直すので、許可されたパスの先祖が後から symlink に差し替わると差し替え先が読める
status: open
category: bug
created: 2026-10-28T18:30:23+09:00
last_read:
open_entered: 2026-10-28T18:30:23+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered:
discard_reason:
pending_reason:
close_reason:
blocked_by:
origin: DR-0045 段階 2 の実装中に気づいた
---

# module の無いセッションの fs_read_external は毎回の走査で allowlist を作り直すので、許可されたパスの先祖が後から symlink に差し替わると差し替え先が読める

## 現象

`fs_read_external` (DR-0024) は `getSessionStatus` の `external_files` を allowlist にする。

- live のセッション (hooks module の run が名乗っている) では、allowlist は Status の fold が行を畳んだ時の canonical なパス (realpath) で固まる。後で先祖のディレクトリや file 自身が symlink に差し替わっても、要求のパスを今 canonicalize した結果が allowlist と一致しないので `path_forbidden` になる (`packages/daemon/test/fs-access.test.ts` の 2 件の security テストが主張している)
- live でないセッション (module が無い、閉じた) では、`getSessionStatus` が要求のたびに transcript を 1 回走査して allowlist を作る。その時点で canonicalize するので、差し替え後の symlink の先が allowlist に入り、差し替え先が読める

## 経緯の要点

- DR-0045 の段階 2 で、Status の fold を持つ条件が「webui がそのセッションの Status を購読している」から「module の run が名乗っている」に変わった (DR-0045 §3 / §5、DR-0020 §3.1)
- 同じ穴は段階 2 の前から、Status を購読していないセッションにはあった。段階 2 で、守られる場面が「タブが開いている」から「module がある」に移った
- 実機での攻撃の再現は未検証。テストでは、`fs-access.test.ts` の `sessionAtWithTranscript` で run を名乗らせないと 2 件が落ちることを確かめた

## 直し方の候補 (未検討)

- live でないセッションでも、走査で得た allowlist を、最初に canonicalize した時点のパスで sid ごとに覚えておく (live の fold と同じ性質にする)。覚えておく期間と、transcript が伸びた時の扱いを決める必要がある
- module の無いセッションは `fs_read_external` を断る (DR-0045 §1 の「module の無いセッションは live を持たない」に揃える)。履歴の閲覧で外部ファイルを開けなくなる影響の見積もりが要る
