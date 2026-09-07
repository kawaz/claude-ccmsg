---
title: 複数ホストの ccmsg daemon を mesh で束ねる (クラスタ化)
status: open
category: design
created: 2026-09-07T16:08:43+09:00
last_read:
open_entered: 2026-09-07T16:08:43+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered:
discard_reason:
pending_reason:
close_reason:
blocked_by:
origin:
---

# 複数ホストの ccmsg daemon を mesh で束ねる (クラスタ化)

## 概要

2 台以上の PC に「claude プロセス群 + ccmsg daemon」を置き、ユーザがどのホストの
endpoint に繋いでいてもクラスタ全体のセッションを把握・操作できるようにする。

## 背景

kawaz r278m34/m35、2026-09-07 の相談で合意した骨子 (r278m36 の訂正を反映済み):

1. 設定にクラスタの endpoint リストを持ち、起動後に自分を除いた他 daemon へ WS で
   接続する (webui とほぼ同じプロトコル)。
2. 表示系イベントはメンバ間で relay する。
3. op は「いま繋いでいる daemon に投げる」だけで、担当 sid でなければ担当 daemon へ
   そのまま relay する (Transport は webui から見て 1 本のまま)。
4. **room はクラスタ横断** (別ホストのセッション同士が同じ room で会話できる)。各
   room に持ち主 daemon を 1 つ決め (作成側のホスト)、mid / seq はその daemon だけが
   振る。他ホストのメンバの post は自 daemon → 持ち主へ relay、イベントは持ち主 →
   各 daemon → 配下メンバへ配る。seq の発行主体は room ごとに 1 つなので since_seq は
   `Record<roomId, seq>` のまま。持ち主ホストが落ちている間その room は読み書き不可
   (host_unreachable)、所在の移動は当面持たない。room id は最初からホストを含意する
   形にする。
5. hyoui もホスト単位: sid → 担当ホスト → その daemon の hyoui endpoint と辿る。
6. セッション系オブジェクトに host 属性を持たせる (紐付けは最低 1 回で足りる、全
   オブジェクトに付ける必要は無い)。
7. 別ホストが断絶した時、そのホストのセッションは Disappeared の一種として扱い、
   復帰時に戻す。
8. daemon 間認証は当面なし (tailnet 前提。llm-gateway との共有キー管理と合わせて
   後で考える)。

実装時に決める細部:

- 担当ホストが落ちている時の op の失敗 (host_unreachable 1 種類)。

webui コンポーネント整理 (`docs/findings/2026-09-07-webui-component-inventory.md`
起点の議論) に持ち込む規約:

- host 属性 / per-host の接続状態・能力フラグを全体の値と混ぜない
- room id はホストを含意する

llm-gateway の通知は複数ホストの ccmsg から使われる前提でブロードキャスト対応予定
(gateway 側)。

## 受け入れ条件

- [ ] クラスタ設定 (endpoint リスト) を持ち、起動後に他 daemon へ WS 接続できる
- [ ] room がクラスタ横断で動作し、持ち主 daemon が mid/seq を発行、他ホストからの
      post が持ち主へ relay される
- [ ] 持ち主ホスト断絶時に host_unreachable を返し、復帰後に読み書きが再開する
- [ ] hyoui がホスト単位の endpoint 解決で動作する
- [ ] セッション系オブジェクトに host 属性が付与され、断絶時に Disappeared 系として
      扱われる

## TODO

<!-- wip 時のみ -->

- [ ] {次に手を付けるサブタスク}
