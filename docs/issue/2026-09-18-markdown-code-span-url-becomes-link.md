---
title: markdown code span 内の URL がリンクにならない
status: open
category: bug
created: 2026-09-18T18:43:21+09:00
last_read:
open_entered: 2026-09-18T18:43:21+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered:
discard_reason:
pending_reason:
close_reason:
blocked_by:
origin: kawaz
---

# markdown code span 内の URL がリンクにならない

## 概要

メッセージ本文の markdown で、インライン code (`` `https://…` ``) に書かれた URL がリンクにならず、クリックできない。

## 背景

kawaz からの報告 (2026-09-18)。直すこと: code span の中身が整形済みの http(s) URL 1 つだけ (空白なし、`{}` 等のテンプレ文字なし) なら、code の見た目 (等幅・背景) のまま `<a href>` にする (target は既存のリンクと同じ)。v2 webui にも同じ issue を起票済み。

kawaz 2026-09-18: テンプレ文字の例外は不要。code span の中身も本文と同じ URL 判定 (既存の linkify の規則) に通すだけでよい。

## 受け入れ条件

- [ ] code で書かれた登録 URL がクリックで開く
- [ ] code span の中身の URL 判定は本文と同じ既存 linkify の規則に従う (テンプレ文字専用の例外処理は追加しない)
