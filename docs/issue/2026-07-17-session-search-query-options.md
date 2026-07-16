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

regex モードでは、既存の grep プリフィルタ (literal `indexOf` 段) をそのまま
素通しできない。以下のいずれかの対応が必要:

- (a) regex から literal な断片を抽出してプリフィルタに使う
- (b) regex 時はプリフィルタを skip し strict 段のみで処理する (正確だが遅くなる)

どちらを採るかは実装時に性能実測して判断する。

## 受け入れ条件

- [ ] `SessionSearchRequest` に case-sensitive / regex フラグと複数行 AND 対応が追加されている
- [ ] daemon 側で regex モードのプリフィルタ戦略 ((a)/(b)) が実測に基づき選定・実装されている
- [ ] webui の Session Search フォームに `[Aa]` / `[.*]` トグルと複数行入力 UI が追加されている
- [ ] in-view 検索 (DR-0022) と同等の UX で動作することを確認

## TODO

<!-- wip 時のみ -->
