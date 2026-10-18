---
title: markdown code span 内の URL がリンクにならない
status: resolved
category: bug
created: 2026-09-18T18:43:21+09:00
last_read: 2026-10-18T15:30:26+09:00
open_entered: 2026-09-18T18:43:21+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-10-18T16:11:06+09:00
discard_reason:
pending_reason:
close_reason: ["done:地の文には autolink literal が無く (DR-0010)、code span の中身も classifyMarkdownLinkUrl に通し、許可 scheme の URL (空白なし) なら code の見た目のまま a にした。scheme の無い綴りは code のまま。テンプレ文字の例外処理は無し。MarkdownView と restricted の両方。verify で Timeline 上の描画を確認。commit xrswypvo"]
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

- [x] code で書かれた登録 URL がクリックで開く
- [x] code span の中身の URL 判定は本文と同じ既存 linkify の規則に従う (テンプレ文字専用の例外処理は追加しない)
