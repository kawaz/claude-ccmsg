---
title: webui に Terminal タブ (web gateway embed iframe) を追加
status: resolved
category: request
created: 2026-07-21T01:10:23+09:00
last_read:
open_entered: 2026-07-21T01:10:23+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-07-21T02:12:07+09:00
discard_reason:
pending_reason:
close_reason: ["done:v0.68.0で実装・push済み、CI green","done:Terminalタブ(hyoui_session_id解決済みセッションのみ表示)","done:iframe src=<gateway>/sessions/<id>?embed=1、gateway URLはlocalStorage ccmsg.terminalGatewayUrl(未設定時は入力欄フォールバック)","done:r45でhyoui側に完了報告済み・設計了承済み(r45m4)","pending:kawaz iPadでの実表示確認はgateway v0.9.13リリース後にr45で調整予定"]
blocked_by:
origin: 依頼元プロジェクト (別セッション経由の指示)
---

# webui に Terminal タブ (web gateway embed iframe) を追加

## 概要

セッションビューのヘッダータブ (Files/Timeline/Status/Rooms) に「Terminal」タブを追加する。
実体は外部の web gateway が提供する embed 用ページを iframe で表示するだけで、ccmsg 側に
ターミナル描画・入力処理のロジックを追加実装する必要はない。

- iframe の `src` は `<gateway>/sessions/<SESSION_ID>?embed=1` (ヘッダ無し表示、xterm.js を
  2 秒毎に更新、resume バナーと input 欄を含む埋め込み専用ページ)
- `SESSION_ID` は Status タブで解決済みの ID をそのまま使う。未解決のセッションでは
  Terminal タブ自体を非表示にする
- gateway URL は設定項目として持つ (kawaz 環境の現在値: `https://<tailnet-host>` または
  `http://127.0.0.1:43690` の 2 通り、ローカル/tailnet 経由を切替可能にする)
- gateway 側は `frame-ancestors` 制限なしで iframe embed 可能な前提 (tailnet 内利用のみ
  を想定した gateway 側の保証で、ccmsg 側での対処は不要)
- 入力送信は iframe 内で完結するため、ccmsg 側での追加の入力ハンドリング実装は不要

## 背景

外部ツール連携によりブラウザから直接ターミナル操作をしたいという要望から。
確認環境は iPad の PWA (standalone) 想定。

着手条件: セッションツリーパネル関連の変更 push 後 (`SessionView.tsx` の競合回避のため)。

## 受け入れ条件

- [ ] セッションヘッダーに Terminal タブが追加され、Files/Timeline/Status/Rooms と並ぶ
- [ ] Status タブでセッション ID が未解決の場合は Terminal タブが表示されない
- [ ] gateway URL が設定項目として存在し、iframe の src に反映される
- [ ] iframe が embed モード (`?embed=1`) でヘッダ無しのターミナル画面を表示する
- [ ] iPad standalone (PWA) 環境で表示・入力が機能する
