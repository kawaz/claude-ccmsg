---
title: 🔐 のフィルタ画面の各許可依頼の下に「TL に移動」ボタンを置く
status: resolved
category: design
created: 2026-11-11T19:26:47+09:00
last_read:
open_entered: 2026-11-11T19:26:47+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-11-11T21:38:07+09:00
discard_reason:
pending_reason:
close_reason: ["dr/DR-0050","implemented"]
blocked_by:
origin: kawaz の指示 (2026-11-11)
---

# 🔐 のフィルタ画面の各許可依頼の下に「TL に移動」ボタンを置く

## 概要

🔐 (許可依頼) のフィルタ画面で、各依頼のバブルのすぐ下に横幅いっぱいの「TL に移動」を 1 つずつ置く。押すとフィルタを外して TL に戻り、そのボタンの上の依頼のバブルが画面の一番上に来るスクロール位置にする。その依頼が読み込み済みの範囲 (窓) の外にある時は、その依頼の行が見つかるまで過去分の読み込みを繰り返してから位置を合わせる。

## 背景

kawaz の指示 (2026-11-11、原文): 「permit のフィルタ TL 画面について、各 permit 毎の下に『TL に移動』ボタンを以下のような感じで置く。

```
バブル
TLに移動(wide)
(gap)
バブル
TLに移動(wide)
(gap)
```

『TL に移動』を押すとフィルタを外して TL に戻り、ボタンの上の permit バブルが画面上の一番上に配置されるスクロール位置になるようにする。この時当該 permit が未取得なら見つかるまで過去分の読み込みを行う。」

## 仕様の要点

- 対象は 🔐 のフィルタ画面。各依頼のバブルのすぐ下に横幅いっぱいの「TL に移動」を 1 つずつ置く。次の依頼との間には間隔を空ける (バブルとそのボタンが 1 組に見える)
- 押すとフィルタを外して TL に戻り、そのボタンの上の依頼のバブルが画面の一番上に来るスクロール位置にする
- その依頼が窓の外にある時 (フィルタ中だけ `notification_list` から時刻の位置に合流させて出している依頼、DR-0050 §5) は、その依頼の行が見つかるまで過去分の読み込みを繰り返してから位置を合わせる
- 横幅いっぱいにするのは、押すとその場所に TL が現れるボタンだから (kawaz 2026-11-11 の決まり: 全幅は「TL に戻る」「過去分を読み込む」のように、押すとそこに TL が現れるものだけ。DR-0050 §4 と app.css の `.tl-wide-button` のコメント)

## 関連 (着手前に読む)

- `docs/decisions/DR-0050-timeline-notification-badges.md` §4 (フィルタ中の末尾の「全て既読」と「TL に戻る」)、§5 (窓の外の say / 依頼の合流)、§6 (フィルタを外す時の位置合わせ、`useFilterScroll`)
- `docs/decisions/DR-0040-permit-request-tool.md` §7 (依頼のバブル。行の uuid で選べる)
- `docs/decisions/DR-0009-session-transcript-access.md` §3 (過去分の読み込み。「↑過去分を上に読み込む↑」は先頭の行の画面上の位置を保つ)
- コード: `packages/webui/src/client/components/timeline/Timeline.tsx` (`listedPermitNode`、`leaveFilter`、`loadOlder`、`.tl-filter-back`)、`useFilterScroll.ts`、`scrollAnchor.ts`、`useTranscriptLoader.ts`、`useNotificationList.ts`、`PermitRequestBubble.tsx`、`app.css` のフィルタの `:not(...)` の規則 (残す子の列挙に新しいボタンを足す必要がある)

## 実装前に決める点 (統括の所見。kawaz の裁定ではない)

- 🔔 (say) のフィルタにも同じボタンを置くか: kawaz の指示は permit だけなので、permit だけで実装する
- 窓の外の依頼を探す読み込み: 見つかるまで読み込み続け、途中で止める手段は作らない (kawaz 2026-11-11 の裁定: 1 セッションのファイルの大きさは知れているので要らない)。読み込み中であることが分かる表示は、今ある過去分の読み込みの表示に合わせる
- 位置の合わせ方: 既にある仕組み (TL の位置の選択 = 行の uuid、フィルタ解除時の位置合わせ) のどれに乗せるか。フィルタの無い間の DOM を外す前と同じに保つ決まり (DR-0050 §6) を崩さないこと
- バブルごとのボタンと、末尾の「全て既読」「TL に戻る」の並び (末尾の「TL に戻る」は残す想定)

## 受け入れ条件

- [ ] 🔐 のフィルタ画面で、各依頼のバブルの下に横幅いっぱいの「TL に移動」が出る (依頼ごとに 1 つ、次の依頼との間に間隔)
- [ ] 押すとフィルタが外れ、その依頼のバブルの上端が画面 (TL の表示域) の一番上に来る。読み込み済みの依頼と、窓の外の依頼の両方で
- [ ] 窓の外の依頼では、見つかるまで過去分が読み込まれる
- [ ] フィルタを外した時のほかの動き (末尾の「TL に戻る」での位置合わせ) が変わらない
- [ ] DR-0050 を今の形に合わせる
