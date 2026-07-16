---
title: Session Search クエリに case-sensitive / regex トグルと複数 AND を導入
status: open
category: design
created: 2026-07-17T07:36:16+09:00
last_read:
open_entered: 2026-07-17T07:36:16+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered:
discard_reason:
pending_reason:
close_reason:
blocked_by:
origin: kawaz r26 mid=60
---

# Session Search クエリに case-sensitive / regex トグルと複数 AND を導入

## 概要

Session Search (DR-0021) のクエリオプションに、in-view 検索 (DR-0022) と同じ
`[Aa]` case-sensitive / `[.*]` regex トグルを導入し、加えて改行区切りの複数語
AND 検索にも対応する。対象は protocol の `SessionSearchRequest` 拡張 + daemon
側の実装 + webui のフォーム。

## 背景

DR-0022 の in-view 検索で導入した `[Aa]` / `[.*]` トグルと同系の UX を
Session Search 側にも揃えたい、という要望。webui フォームは同系 UI 部品を
共有できるため、DR-0022 workflow の完了後に着手するのが効率的。

## 設計注意

プリフィルタは daemon 自前の行単位判定であり (外部 grep ではない)、本質は
「JSON.parse コストを払う前の枝打ち」。そのため regex モードでも同じ枝打ち
位置に `RegExp.test` を生行に当てれば、プリフィルタ構造はそのまま成立する:
literal モードは `indexOf`、regex モードは `RegExp.test` を同じ枝打ち位置で
使う。

## 受け入れ条件

- [ ] `SessionSearchRequest` に case-sensitive / regex フラグと複数行 AND 対応が追加されている
- [ ] daemon 側で regex モードのプリフィルタに `RegExp.test` を生行に適用する形で実装されている
- [ ] webui の Session Search フォームに `[Aa]` / `[.*]` トグルと複数行入力 UI が追加されている
- [ ] in-view 検索 (DR-0022) と同等の UX で動作することを確認

## TODO

<!-- wip 時のみ -->
