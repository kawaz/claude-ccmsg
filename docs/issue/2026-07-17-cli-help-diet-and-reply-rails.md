---
title: CLI help / SKILL ダイエットとレール設計
status: open
category: design
created: 2026-07-17T11:07:18+09:00
last_read:
open_entered: 2026-07-17T11:07:18+09:00
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

# CLI help / SKILL ダイエットとレール設計

## 概要

ccmsg CLI の `--help` と SKILL.md を「基本レール」だけに絞り、レール外の動作をユーザ (呼び出し側 AI) の視界に入れさせない設計に変更する。

## 背景

kawaz 指定 (r26 mid=84) により、`--help` のデフォルト表示を以下の基本レールのみに絞る:

- `reply <rNmN> <msg>` — 返信用
- `post <room> [--to <aN,...>] <msg>` — 新規メッセージ用
- `peers [cwd(partial)]` — セッション一覧
- `create-room --members <sid,...> <title>` — ルーム作成
- `subscribe` — Monitor 常駐用
- `notify --self --text <msg>` — 自セッション通知 (justfile 等組み込み用途)
- `Options: --help-full` のみ

他の全サブコマンド・オプション・環境変数の説明は `--help-full` に隠す。環境変数は `--help-full` 以外に書かない (`CLAUDE_SESSION_ID` で動くのがデフォルトレールという前提を守る)。

SKILL.md も同方針でダイエットし、「新規声かけは post、応答は基本 reply」の使い分けを前面に出し、詳細をそぎ落とす。

併せて、1on1 の `reply_hint:"tl"` ルールが効きにくい問題への対処も検討する: SKILL 記述強化に加えて subscribe イベントの指示行の文言改善。tl 指定メッセージへの post 応答を daemon 側で警告する等のレール化は過剰かもしれない — 設計判断が必要。

CLI help ↔ SKILL ↔ completion の 3 者同期 (cli-design-preferences ルール) を崩さないこと。

## 受け入れ条件

- [ ] `--help` のデフォルト出力が基本レール 6 コマンド + `--help-full` オプションのみに絞られている
- [ ] 環境変数の説明が `--help-full` 側にのみ存在する
- [ ] `--help-full` で従来相当の全情報が引き続き閲覧できる
- [ ] SKILL.md が「post で新規声かけ、reply で応答」を前面に出す構成にダイエットされている
- [ ] `reply_hint:"tl"` が効きにくい問題について、SKILL 記述強化 or subscribe イベント文言改善のいずれか (または両方) が実施され、daemon 側レール化は見送るか採用するかの判断が記録されている
- [ ] CLI help / SKILL / completion の内容に矛盾がない

## TODO

<!-- wip 時のみ -->
