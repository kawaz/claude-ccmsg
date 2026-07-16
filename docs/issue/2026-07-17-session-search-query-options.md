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
「JSON.parse コストを払う前の枝打ち」。

**mid=61 時点の想定は成立しない** (kawaz r26 mid=62 の指摘): regex を生 jsonl
行にそのまま当てる案は、JSON エスケープ (`\"` や `\n` 等) によってマッチが
崩れる。literal モードは既存どおり (Phase 1 実装済み) パターン文字列を JSON
エスケープ後の綴りに変換してから `indexOf` するので正確に枝打ちできるが、
regex パターンは同じ変換ができない (任意の正規表現をエスケープ後綴りに
機械変換するのは一般には不可能)。

regex モードの設計は **kawaz 裁定 (r26 mid=63)「a で」により確定** (a + b の
自動切替として決定、以下は確定仕様):

- **(a) 近似プリフィルタ**: pattern から JSON エスケープの影響を受けない
  literal 断片 (英数字等、エスケープされない文字種の連続) を抽出できた場合、
  それを使って `indexOf` ベースの近似プリフィルタを掛ける。抽出する断片は
  「マッチするなら必ず含まれる」方向の **false negative を出さない近似**に
  限定する (false positive は後段の strict 判定 (decode 後の `RegExp.test`)
  が落とすので許容)
- **(b) 抽出不能時のフォールバック**: pattern 全体がエスケープされうる文字
  (`"` `\` 改行相当等) で構成され安全な literal 断片が抽出できない場合は、
  プリフィルタを skip して全行 decode → strict `RegExp.test` に自動的に
  フォールバックする
- 実装時に regex 全行 parse (= フォールバック多発時) の実測コストを計測し、
  許容範囲か確認する

設計裁定は完了。実装は DR-0022 workflow の完了後に着手する (現時点では
status を open のまま据え置き、実装着手時に wip へ遷移する)。

## 受け入れ条件

- [ ] `SessionSearchRequest` に case-sensitive / regex フラグと複数行 AND 対応が追加されている
- [ ] daemon 側で regex モードのプリフィルタが (a) literal 断片抽出による近似枝打ち + (b) 抽出不能時の全行 decode フォールバックの自動切替で実装されている
- [ ] webui の Session Search フォームに `[Aa]` / `[.*]` トグルと複数行入力 UI が追加されている
- [ ] in-view 検索 (DR-0022) と同等の UX で動作することを確認

## TODO

<!-- wip 時のみ -->
