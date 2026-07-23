---
title: セッション発の対ユーザ報告は TL に誘導する (1on1 自作禁止ガイド)
status: open
category: design
created: 2026-07-23T16:39:08+09:00
last_read:
open_entered: 2026-07-23T16:39:08+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered:
discard_reason:
pending_reason:
close_reason:
blocked_by:
origin: 依頼元プロジェクト (claude-ccmsg dogfooding セッション)
---

# セッション発の対ユーザ報告は TL に誘導する (1on1 自作禁止ガイド)

## 概要

セッションから kawaz への報告は、自セッションの TL (通常応答) で行うのが正。
1on1 room はユーザ起点 (= ユーザからのプロンプトと同値) の場でしかなく、
セッション側が 1on1 を持っていない/使えないからといって room を自作するのは誤り。

## 裁定 (r55m23)

> なんで1on1を作る必要があるの？TLでしゃべれよ。って感じでSKILLで案内するなり
> なんなりで上手くガイドあれば良いでしょ。1on1はユーザからのプロンプトと同値と
> 考えて良い。

セッション側から正規 1on1 (kind='1on1') を作成/取得する手段を用意する方向
((a) create-room に --kind 1on1 相当を許可 / (b) 初回 post 時に daemon が自動生成
/ (c) 既存 room の kind 変更・archive を CLI から可能にする) は **全て不採用**。

## 補足裁定 (r55m24)

> 1on1は返信は必ず reply_via:"tl" とかのはずだし、ユーザからの一方通行にしか使わない。

1on1 の設計意図は「ユーザ → セッションの一方通行」。セッションからの返信は
常に TL 経由 (`reply_via_tl`) が前提であり、1on1 room 自体に post して
双方向チャネルとして使う想定ではない。セッション側が 1on1 を「自分から
書き込む場所」として扱おうとすること自体が設計前提と食い違っている。

## 背景

2026-07-23 の実例: 新セッションが前セッションの 1on1 (r46) に post しようとして
`not_a_member` で拒否された。代替として `create-room --members <自sid>` で room
(r54) を自作したが、kind が 1on1 にならず通常 room として表示された
(kawaz 指摘 r55m21)。この r54 自作自体が誤り (= TL で報告すべきだった)。

## 追加裁定 (r55m25)

> SKILLに書く必要ゼロだな

ガイド文追記 (SKILL.md / CLI docs) は不採用。対応はレール側のみに絞る
(= create-room や post の拒否/警告メッセージ等、機械的な誘導のみで解決する)。

## 最終裁定 (r55m26)

> コンテキストの無駄なので、1on1 に post 自体が問題なので、TL にかけとエラーで案内すれば良い。

レール検討の選択肢を一本化: **1on1 room への post 自体をエラーで拒否し、
エラーメッセージで「TL (通常応答) に書け」と案内する** (既存の reply_via_tl
拒否と同系のレール)。

## 受け入れ条件

- [ ] 1on1 room への post をエラーで拒否し、「TL (通常応答) に書け」と
  案内するエラーメッセージを実装する
- [ ] 誤って作られた r54 の archive 手段の検討は残す (= 後始末のみ、恒久機構は不要)

## TODO

<!-- wip 時のみ -->
