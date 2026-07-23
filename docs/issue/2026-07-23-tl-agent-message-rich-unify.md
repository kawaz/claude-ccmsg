---
title: TL のエージェント間メッセージ表示を ROOM チャットの rich 形式に統一
status: wip
category: request
created: 2026-07-23T12:24:32+09:00
last_read: 2026-07-23T12:46:02+09:00
open_entered: 2026-07-23T12:24:32+09:00
wip_entered: 2026-07-23T12:47:25+09:00
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered:
discard_reason:
pending_reason:
close_reason:
blocked_by:
origin: kawaz 依頼
---

# TL のエージェント間メッセージ表示を ROOM チャットの rich 形式に統一

## 概要

TL 上でのエージェント同士のメッセージ表示 (AgentCard / SendMessage / peer-message) が
古い見た目のままで、ROOM チャット側の rich 表示に比べて見劣りする。ROOM チャットで
使っている表示形式 (アイコン + 名前 + メッセージボックス) をそのまま流用し、両者の
見た目を統一する。

## 背景

kawaz 依頼 (2026-07-23、スクショ 3 枚は依頼メッセージの添付参照)。ROOM 側は
`TimelineItem.tsx` の msg カード表示 (`--member-hue` の CSS 変数注入、`hueForSeed`
によるアイコン色算出) が rich 表示の正本。

TL 側のエージェント間メッセージ表示は `Timeline.tsx` の AgentCard / SendMessage /
peer-message 部分で、v0.71.1 で構造は統一済みだが ROOM ほど rich ではない
(アイコンや名前 (リポ名) の表示置き換え、メッセージボックスのカラーテーマを
identicon hue に合わせる、等が未対応)。

両コンポーネントの共通化を検討する (関連する過去の指摘: 「コンポーネント分離
できてないの?」)。

v0.73.0 時点の指摘で、次セッションへの引き継ぎ対象 (前セッションは pre-clear 済み)。

## 受け入れ条件

- [ ] TL のエージェント間メッセージ (AgentCard / SendMessage / peer-message) が
      ROOM チャットと同じ「アイコン + 名前 + メッセージボックス」形式で表示される
- [ ] メッセージボックスのカラーテーマが ROOM と同じ identicon hue (`hueForSeed`
      由来の `--member-hue`) で算出される
- [ ] アイコン・名前 (リポ名) の表示ロジックが ROOM 側と揃う
- [ ] 可能であれば `TimelineItem.tsx` の msg カード表示と TL 側表示のコンポーネント
      共通化を検討し、重複実装を解消する

## TODO

<!-- wip 時のみ -->

- [ ] `TimelineItem.tsx` (ROOM 側 rich 表示) と `Timeline.tsx` の AgentCard /
      SendMessage / peer-message 表示を比較し、差分を洗い出す
- [ ] 共通化可能なコンポーネント/hook (アイコン算出、hue 算出、メッセージボックス
      レイアウト) を切り出す
- [ ] TL 側表示を rich 形式へ置き換え

## 追加スコープ (kawaz r46m62、2026-07-23)

filepath リンク化 (v0.73.0) は現在 ROOM チャット側 (TimelineItem 経由) のみ配線で、
TL の assistant 応答テキスト (`Timeline.tsx` の `MarkdownView` 呼び出し 2 箇所、
L773/L818 付近) には `filePathLinker` が渡っていない。rich 化と同時に TL 側にも
配線する (sender の ctx = そのセッション自身の cwd/repo_root)。

また対象が inline code のみである制約は仕様 (誤検知抑制) なので、kawaz へ
「バッククォートで囲まれたパスだけリンク化される」ことを次セッションで一言案内すること。

## kawaz 指摘 (r46m64) と整理

ROOM 側のリンク化は `filePathCtxForSender` が送信者 sid → peers の
repo_root/cwd で解決する「送信者プロジェクト基準」で実装済み (完全に不可能
ではない) だが、送信者 disconnect で解決不能・リンク先は送信者セッションの
Files でスコープが飛ぶ、の制約あり。

kawaz の利用実態 (基本 TL、ROOM は会話観察) より優先は TL 側配線。ROOM 側は
「送信者特定できる時だけ動くおまけ」として現状維持の方針 (main 判断、kawaz
追認待ちだが異論が無ければこのまま)。

## kawaz 裁定 (r46m65)

「発言者 (from) のエージェントのプロジェクトディレクトリベースで考えるという
決めを作れば ROOM 内でもファイルリンクの URL 一意化は辻褄が合う。リンク可能
そうなのでそうしましょう」— ROOM 内リンク化は発言者基準で正式仕様化。

v0.73.0 の `filePathCtxForSender` の現実装がこの仕様どおりなので追加実装なし。
送信者 disconnect 時に解決不能になる制約の改善 (peers に居ない sid の
repo_root を別ソースから引く等) は必要が観測されたら別途。
