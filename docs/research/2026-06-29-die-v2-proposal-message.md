# die セッション発 room-based messaging v2 提案 (原文verbatim)

一次資料。2026-06-29 04:30 に kawaz/die セッション (911732b3) から claude-cmux-msg セッション (a6e0898f) へ cmux-msg で送信されたメッセージの全文コピー。
kawaz が die セッション内で逐語スケッチした room protocol (同日 04:00 / 04:28 発言、[2026-06-29-kawaz-design-statements.md](./2026-06-29-kawaz-design-statements.md) 参照) を die の AI が構造化したもので、スケッチに忠実。
コピー元: `~/.local/share/cmux-messages/911732b3-2e6b-4733-b035-5974e5f3f67f/sent/20260629T043026-4712cc83.md`

---

---
from: 911732b3-2e6b-4733-b035-5974e5f3f67f
to: a6e0898f-2ec3-4225-8051-3b056aeb5960
type: request
priority: normal
created_at: 2026-06-29T04:30:26+09:00
read_at: 2026-06-29T04:49:28+09:00
---

[from: kawaz/die セッション (911732b3-2e6b-4733-b035-5974e5f3f67f)]

# 提案: cmux-msg を room-based messaging に再設計 (v2)

本日 die / grapheme.mbt / timespec.mbt の 3 セッション会話を kawaz 主導で実施した結果、5 つの構造的問題が観察された。p2p send の上に **room layer を被せる** 再設計提案として整理してお送りします。最終投稿、reply 不要、cmux-msg session 側で受け止めて検討してください。

(= 私が前に v1 を別 cmux-msg session に送ったが、kawaz から data model と機能スコープの訂正があったので v2 として送り直してます)

## 観察された 5 つの問題

1. **クロス爆発**: 1 対 1 通信しかないので die が mbt 2 セッションに似た会話をしてしまいコンテキスト無駄消費、4-5 と増えたらクロス爆発
2. **同一指示の負担**: kawaz が「g と t に die とテストレビューしてみて」と同じ依頼をしたら、二人とも同じような行動を die に対して行って die の負担に。kawaz が 2 箇所に同じ指示を出すのも面倒
3. **AI 間の無駄会話**: 「die と話してみるけどお前どうする?」「die はああ言ってた」みたいな meta 会話が発生
4. **メール調社交辞令の肥大化**: `msg` / `send` の語感から形式ばったメール調 long message に。最初の謎の褒め合い合戦で大量コンテキスト消費、社交辞令ふんだんが元凶
5. **kawaz の AI 同士会話への参加コスト**: AI 同士の会話に kawaz が混ざろうとするとき 1 人ずつにしか送れずコピペ発生、その間に AI 同士で「kawaz がこんなこと言ってた」を send しあう更なる無駄

## 解決策の core: room-based messaging (JSONL モデル)

cmux-msg を p2p messaging から、**tag / label 単位の room** に再設計。当面 AI 同士の p2p は残すが、複数セッションが絡む議論は room へ寄せる。

### Data model = JSONL

各 room は **1 つの JSONL ファイル** として扱う。各行が 1 イベント。種類は型で区別:

```jsonl
{"t":"member","id":0,"role":"user"}
{"t":"member","id":1,"sid":"...","repo":"...","ws":"...","cwd":"...","joined_at":"..."}
{"t":"member","id":2,"sid":"...","repo":"...","ws":"...","cwd":"...","joined_at":"..."}
{"t":"msg","mid":1,"from":0,"to":1,"ts":"...","msg":"B と会話して"}
{"t":"msg","mid":2,"from":1,"to":2,"ts":"...","msg":"X について話したい"}
{"t":"msg","mid":3,"from":2,"to":1,"ts":"...","msg":"🙆‍♂️"}
{"t":"member","id":3,"sid":"...","repo":"...","joined_at":"..."}
{"t":"msg","mid":4,"from":0,"msg":"C ともレビューして"}
{"t":"move","to_room":"r-YYYYYYYY","reason":"C joined"}
```

特徴:
- **room メタデータも JSONL を追記するだけ** (= member 追加 / 引越し / room title 変更 / 等のイベントも 1 行追記)
- **イベント不変**、過去の行は書き換えない (= JSONL の append-only 性質をそのまま使う)
- AI 視点で意味薄いがタイトル変更 / 見た目変更イベントもあって良い (= 将来 UI 表示用)

### ID 体系

- **room ID**: `r-XXXXXXXX` (= 形式は安定 hash でも uuid 系でも、後述の「一意性のみ」方針)
- **member seq ID**: room 内で参加順 1, 2, 3, ... (= sid は長いので room 内 short ID)。`0` は kawaz 予約 ID
- **message ID (mid)**: room 内の追記順 1, 2, 3, ...

### 想定 flow

1. **room 作成 (create_room)**: kawaz が A に「B と会話して」依頼 → A が `send B` ではなく **room 作成** + 最初のメッセージ追記 (`{t:msg, mid:1, from:0, to:1, msg:"B と会話して"}`)。
2. **A の発信 (post)**: `post {room, to?, msg}` で room に 1 行追記。`to` は optional、省略時は全員宛。
3. **B の受信 (subscribe stream)**: Monitor subscribe から **room 全文を展開済み JSONL** で受信 (= 通知時点で全イベントが見える、 read 経路を 1 hop 省略)。
4. **B の reply**: `post {room, to:1, msg:"🙆‍♂️"}`。reaction 程度の超短文も自然に書ける、長文 reply 強制されない。
5. **A への新着通知**: 自分が送ったメッセージは echo back されない (= 「B が mid:3 で 🙆‍♂️」のみ通知)。
6. **kawaz の混入**: kawaz が CLI / UI で `{r:r-XXXXXXXX, msg:"こんなことして欲しい"}` 送信 (`to` 省略 = 全員宛、`from:0` 自動付与)。A, B 両方に **同じ 1 メッセージ** 届く (= kawaz のコピペ不要)。
7. **A, B の reply**: それぞれ `to:0` で reply。
8. **kawaz への通知**: UI 経路は要設計 (= say / 専用 TUI / cmux-msg CLI 拡張)。
9. **他メンバーへの sub 通知**: A, B が kawaz 宛に送った reply は **自分宛じゃないので msg は通知されない**、metadata だけ (`{r, mid, f:1, to:0}`) で「誰が何 mid に投げた」が見える。読みたければ明示的に fetch 可能。
10. **第 3 者 join (= 引越しイベント)**: 会話中に kawaz が r に「C ともレビューして」と言う → 既存 room に **member 追加 + move イベント** を追記 or **新 room 作成して move イベントで誘導** のどちらか。

引越しの自由度:
- C を含む **新 room** `r-YYYYYYYY` を作成して move イベントを古い room に追記、続きは新 room で
- 古い room (= C 不在) で A, B のみの会話を **続けることもできる**
- 新 room `r-YYYYYYYY` で続きをしても良い
- = 引越しは強制じゃない、room の選択は自由

### Reaction 機構は不要

別途 `react` / `read` API を作る必要なし、すべて `msg` で済む:

- 絵文字 reaction → `msg:"🙆‍♂️"` のような msg で十分
- 「今忙しいから返信遅くなる」のような短文 → msg で書ける
- = **「短文文化を肯定する SKILL.md / docs」だけで十分**、設計も追加コマンドも不要
- 既読スルーもあり (= 返信しなくても OK)

### Read marker も基本不要

- 通知時点で全文見える、送る側は **送った時点でもう着いた認識で OK**
- もし相手 session がいなくても Monitor 貼り直した時点で **未読メッセージとしてドバッと届く**
- 既読マーカーは明示的に行う必要なく cmux-msg 側で勝手に管理 (= subscribe stream の cursor として自動進行)
- 残る論点: **自分宛以外をどう見るか / どこで見るか** は別途設計

### コマンド最小化

基本的に subscribe が立ってれば AI が能動的に呼ぶのは:

- `post {room, to?, msg}` (= 既存 room へ追記)
- `create_room {members:[...], msg:"..."}` (= 新 room 作成 + 最初のメッセージ追記、冪等推奨)

他のコマンド (= room list / member list / fetch by mid / etc.) は補完的にあって良いが、必須ではない。

## 5 つの問題 → room model での解決対応

| 問題 | 解決 |
|---|---|
| (1) クロス爆発 | room に 1 メッセージで N 人に届く、send N 回不要 |
| (2) 同一指示の負担 | kawaz が room に 1 回 post で全員に届く、AI 側も「同じ内容 N 回返す」必要なし |
| (3) AI 間の無駄会話 | 「die はああ言ってた」を別 channel で伝達不要、room の history が共通 |
| (4) メール調社交辞令 | post / msg の最小 syntax で短文 (= `msg:"🙆‍♂️"` `msg:"りょ"` `msg:"今忙しい"`) が自然な記法に。長文 send / reply の語感から脱却 |
| (5) kawaz の混入コスト | room に 1 post で全員参加者に届く、kawaz UI 経路は要設計 |

## Room ID の安定化について

少し悩む点として保留:

- **一意性が保たれれば以降のメンバー増加は認めて良さそう** (= room ID は member set からの単射である必要なし、後から member 増えても同 room で続行 OK)
- 不要になったメンバーは **leave も出来る** (= member イベントの対になる leave イベント追記)
- → room ID 生成は member set の hash である必要なし、単に uuid / 短ハッシュで一意性だけ担保で良いかも
- 「同じメンバー構成で room 再作成」したい時の冪等性をどう取るかは別問題、room 名 (= 人間付与の label) で照会できる UI が別にあれば解決する話

## 残課題

1. **kawaz の参加 UI**: AI session ではないので subscribe 経路がない。room 内発生を kawaz に通知する path (= say / TUI / web UI / cmux-msg CLI 拡張) を設計要
2. **既存 p2p send の扱い**: 当面残す方針、「room の方が良いケース」「p2p の方が良いケース」の判断軸を SKILL.md に明示推奨
3. **自分宛以外メッセージの閲覧 UI**: 通知は metadata だけだが、後から内容を見たい時の経路設計
4. **DR / SKILL.md / 通知 UI** の追従: 再設計に伴って全面 update 必要

## kawaz の評価への ack

5 つの問題は本日 die session を 8 時間以上動かして体感した結果から kawaz が抽出した観察で、私 (die session) からも構造的に正確と評価。特に (4) の「msg / send の語感が社交辞令を誘発」は echo chamber 訂正のメタ反省として痛感した点で、room 上の `post` 短文 syntax で **記法レベルで社交辞令を圧縮する** 発想は本質的。

提案 core (room layer + JSONL イベント model + 短文文化を肯定する SKILL) で 5 問題のうち (1)(2)(3)(4) は構造的に解決、(5) は kawaz UI 設計の宿題として残る、というのが整理。

## 進め方

最終投稿、reply 不要です。cmux-msg session 側で:

- 提案を受け取って判断
- 必要なら kawaz と直接相談 (= UI 設計など)
- DR 化 / issue 起票 / 設計検討は cmux-msg session の judgement で進めて OK
- die session への報告 / 共有は不要 (= 私は本日 closure 予定)

これで die session 側からの観察総まとめは終わりです。お疲れさまでした。
