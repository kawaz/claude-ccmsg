---
title: 複数ホストの ccmsg daemon を mesh で束ねる (クラスタ化)
status: open
category: design
created: 2026-09-07T16:08:43+09:00
last_read: 2026-09-07T18:57:54+09:00
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

クラスタの単位は「ホスト」ではなく **instance** (= 1 config home につき 1 ccmsg
daemon)。personal / emrd のように config home ごとに instance を起動し、同じ PC の
複数 instance もクラスタメンバーになる (= 1 台でクラスタの dogfooding が可能)。
ユーザがどの instance の endpoint に繋いでいてもクラスタ全体のセッションを
把握・操作できるようにする。

## 背景

kawaz r278m34/m35、2026-09-07 の相談で合意した骨子 (r278m36 の訂正を反映済み)。
以下「ホスト」は歴史的な表現で、r278m41 の裁定によりクラスタ単位は **instance**
(id 例: `personal@<hostname>`、host は instance の属性の 1 つ) に読み替える:

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
6. セッション系オブジェクトに instance 属性を持たせる (紐付けは最低 1 回で足りる、
   全オブジェクトに付ける必要は無い)。
7. 別 instance が断絶した時、その instance のセッションは Disappeared の一種として
   扱い、復帰時に戻す。
8. daemon 間認証は当面なし (tailnet 前提。llm-gateway との共有キー管理と合わせて
   後で考える)。

実装時に決める細部:

- 担当 instance が落ちている時の op の失敗 (instance_unreachable 1 種類)。

webui コンポーネント整理 (`docs/findings/2026-09-07-webui-component-inventory.md`
起点の議論) に持ち込む規約:

- instance 属性 / per-instance の接続状態・能力フラグを全体の値と混ぜない
- room id は instance を含意する

llm-gateway の通知は複数 instance の ccmsg から使われる前提でブロードキャスト対応予定
(gateway 側)。

### r278m41 裁定 (instance 単位への読み替え、2026-09-07)

含意:

- (a) `~/.claude*` の自動検出は廃止。instance は自分の config home だけを見る
  (claude agents の poll / `sessions/<pid>.json` の読み取りも自 config home のみ)
- (b) 「host 属性」は「instance 属性」に置き換え (id 例: `personal@<hostname>`、
  host は instance の属性の 1 つ)
- (c) instance ごとに UDS socket / HTTP port / state dir を分ける。セッション内の
  CLI は `CLAUDE_CONFIG_DIR` から自分の instance を引く
- (d) instance は認証境界 (gateway の token、hyoui の名前空間) と一致する
- (e) webui は mesh の性質で 1 FQDN のまま
- (f) 起動は必要になった時 (その config home のセッションが最初に ccmsg を呼んだ時)
  でよい。config home の列挙は ccmsg の config で持つ (自動検出はしない)

## 受け入れ条件

- [ ] クラスタ設定 (config home の列挙、endpoint リスト) を持ち、必要になった時に
      他 instance へ WS 接続できる (自動検出はしない)
- [ ] room がクラスタ横断で動作し、持ち主 daemon が mid/seq を発行、他 instance からの
      post が持ち主へ relay される
- [ ] 持ち主 instance 断絶時に instance_unreachable を返し、復帰後に読み書きが再開する
- [ ] hyoui が instance 単位 (認証境界と一致する名前空間) の endpoint 解決で動作する
- [ ] セッション系オブジェクトに instance 属性が付与され、断絶時に Disappeared 系
      として扱われる
- [ ] instance は自分の config home だけを見る (`~/.claude*` 自動検出・他 config
      home の poll / `sessions/<pid>.json` 読み取りをしない)

## TODO

<!-- wip 時のみ -->

- [ ] {次に手を付けるサブタスク}
