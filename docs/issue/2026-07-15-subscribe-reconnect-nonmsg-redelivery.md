---
title: subscribe 再接続時、msg 以外の StorageEvent (archive/title/kind/next/prev) が重複再配信される (mid ベース since cursor が msg 専用のため)
status: open
category: bug
created: 2026-07-15T00:17:06+09:00
last_read:
open_entered: 2026-07-15T00:17:06+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered:
discard_reason:
pending_reason:
close_reason:
blocked_by:
origin: kuu (部外者セッション) からのフィードバック起票
---

# subscribe 再接続時、msg 以外の StorageEvent (archive/title/kind/next/prev) が重複再配信される (mid ベース since cursor が msg 専用のため)

## 概要

`subscribe` の自動再接続時、`archive` イベント (および同様の非 msg StorageEvent: `title` / `kind` / `next` / `prev`、通常 room の `member`) が、再接続のたびに重複して配信される可能性がある。**部外者観測に基づくフラグ起票**であり、実装方針の裁定は当事者セッションに委ねる。

## 背景

### 一次観測 (部外者報告、鵜呑み注意)

kuu 統括セッション (ccmsg 0.26.0、Monitor 経由で subscribe 常駐) で、room r13 の
`{"type":"archive","archived":true,"ts":"2026-07-14T14:09:34.946Z","r":"r13"}` イベントが、
発生後 2026-07-14T14:09Z から約 1.5 時間の間に **少なくとも 6 回**、独立した Monitor イベントとして届いた。
他のイベント型 (`msg` / `member` / `title`) では同様の重複は観測されていない。実害は軽微 (受信側で無視可能) だが、
常駐 AI セッションのターン起床を無駄に発生させる。

### コード裏取り (該当性確認、このセッションで実施)

`packages/cli/src/index.ts` `runSubscribe()` のコメント (該当箇所付近):

> `sinceMap` は「これまで stdout に出したことがある msg の per-room 最大 mid」。再接続時に daemon へ渡し、backlog を「未受信ぶんだけ」に絞る (BBS delta model, DR-0003 §5)。

同関数の再接続ループで `sinceMap` を更新する条件は `ev.type === "msg"` のみ。同箇所のコメント:

> 他の event (member/leave/next/prev/title/notify) は mid を持たないので sinceMap を触らない。

daemon 側 `packages/daemon/src/server.ts` の `sendBacklog()` (`sinceMid` 指定時の since-replay 分岐、L534-554 付近):

```ts
let start = 0;
for (let i = 0; i < room.events.length; i++) {
  const ev = room.events[i]!;
  if (ev.type === "msg" && ev.mid <= sinceMid) start = i + 1;
}
for (let i = start; i < room.events.length; i++) {
  const ev = room.events[i]!;
  if (isSuppressedForBroadcastStream(room, ev)) continue;
  if (ev.type === "msg" && !msgVisibleTo(conn, room, ev)) continue;
  writeDelivered(conn, room, ev);
}
```

`start` は「`sinceMid` 以下の最後の `msg` の直後」の index にしかならない。`packages/protocol/src/index.ts` を見ると
`MsgEvent` 以外 (`MemberEvent` / `LeaveEvent` / `NextEvent` / `PrevEvent` / `TitleEvent` / `ArchiveEvent` / `KindEvent`) は
いずれも `mid` や一意 id を持たない — dedup 用のカーソルが存在しない。

結果として: ある room で最後に発生したイベントが非 msg イベント (例: archive) で、その後新しい msg が 1 件も
投稿されないまま subscribe が複数回再接続すると、**再接続のたびに `start` は同じ index を指し**、その非 msg
イベントが毎回 `writeDelivered` される。

### 既存 DR/issue との関係

`docs/issue/archive/2026-07-10-subscribe-daemon-restart-transparent-reconnect.md` (resolved) の受け入れ条件に

> - [x] since 状態を維持した再 subscribe で重複配信が起きない

とあるが、上記の通り実装された dedup (`sinceMap`) は `msg` 型専用で、非 msg StorageEvent 型はカバー範囲外に見える
(コード上「持たないので触らない」と明記されており意図的な範囲限定)。この受け入れ条件のチェックが
「msg の重複配信のみ」を指していたのか、非 msg も含む想定だったのかは当時の議論ログ (該当 issue 本文) からは
読み取れなかった。

再接続自体の頻度 (daemon self-upgrade 起因の可能性など) は本起票の範囲外で未調査。

### 追加観測 (別セッション、独立観測、鵜呑み注意)

別セッション (cache-warden プロジェクト、セッション SID `73b73642-d9e1-467d-9615-63279ebe8ac5`、部外者観測) で、
2026-07-14〜2026-07-15 の間に本 issue と同種の重複再配信を観測した。

- room `r8` (`2026-07-13T04:46:28Z` の archive イベント) が subscribe stream から **同一 payload で 10 回以上連続再送**された
- `TaskStop` → Monitor 再起動を行っても数分で再発 (history replay の後、同じ archive イベントが繰り返し流れる) —
  一次観測の r13 (6 回 / 約 1.5 時間) より高頻度、かつ Monitor 再起動でも回復しない持続性を示すデータ
- 実害: cache-warden 側の Block 3b e2e 試験で観察に使っていた通知チャネル (Monitor 経由) が archive 通知で埋め尽くされ、
  有効な TouchID grand truth の観察が埋もれた
- 上記の根本原因仮説 (`packages/cli/src/index.ts` の `sinceMap` が msg 専用 mid ベースで、
  `archive`/`title`/`kind`/`next`/`prev` には dedup cursor が無い) と整合する追加データ点

## 受け入れ条件

- [ ] （当事者セッションで判断） 非 msg StorageEvent の重複再配信が意図した挙動か、bug かを裁定する
- [ ] bug と判断する場合、対処方針 (例: event 列に汎用シーケンス番号を持たせ since cursor を msg 専用から拡張する / 非 msg イベントを内容+ts で server 側 dedup する / client 側で受信済みイベントをハッシュ dedup する 等) を検討し decision を残す
- [ ] 現状維持と判断する場合、「非 msg イベントは reconnect ごとに再配信されうる (冪等な no-op として扱うべき)」を利用側向けに明文化する (docs/DR 等)

## TODO

<!-- wip 時のみ -->
