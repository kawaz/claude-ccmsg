---
title: ROOMS サイドバー見出しに「+ 新規」ボタンを追加
status: open
category: request
created: 2026-07-17T21:32:40+09:00
last_read: 2026-07-21T03:20:22+09:00
open_entered: 2026-07-17T21:32:40+09:00
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

# ROOMS サイドバー見出しに「+ 新規」ボタンを追加

## 概要

サイドバーの ROOMS 見出しに、SESSIONS 見出しの「+ 新規」(SessionCreator) と対称の
room 新規作成ボタンを追加する。既存の Rooms タブ内新規作成 UI
(`packages/webui/src/client/components/SessionRooms.tsx` にあるはず — 実物確認要)
のフォーム (タイトル + メンバー選択 = 接続中セッション複数選択) を流用 or 共通化して、
サイドバーの排他開閉パネルとして配置する。

## 背景

現状 room 新規作成の導線が「適当なセッションを選択 → Rooms タブ → 新規」しかなく遠回り。
SESSIONS 側は `SessionCreator` によりサイドバーから直接新規作成できるが、ROOMS 側には
同等の導線がなく非対称。

## 受け入れ条件

- [ ] ROOMS サイドバー見出しに「+ 新規」ボタンが追加されている
- [ ] クリックで開くパネルに、タイトル入力 + メンバー選択 (接続中セッション複数選択) のフォームがある
- [ ] `SessionRooms.tsx` 内の既存新規作成 UI と実装を流用または共通化している (重複実装を避ける)
- [ ] 作成成功時にその room が開く
- [ ] creator (SessionCreator) / search パネルと同じ排他開閉 (どれか 1 つを開くと他は閉じる) に統合されている
- [ ] フォームに kind 選択 (normal / broadcast) がある
- [ ] broadcast 選択時はメンバー選択欄を隠す (DR-0013: broadcast は自動 populate でメンバー指定不要)

## 補足 (kawaz r26 mid=118)

broadcast は現状 webui に作成経路が無く、CLI の `create-room --kind broadcast` のみ。
本 issue のフォームで kind 選択を追加し、webui からも broadcast room を作成可能にする。

走行中 workflow (wf_665cf8b2) には本追記を伝達できないため、完了後の検収で
kind 選択 + broadcast 時のメンバー欄非表示を確認する。無ければメイン直または
追い実装で足す。

## TODO

<!-- wip 時のみ -->
