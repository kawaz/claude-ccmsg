---
title: worker が作った TODO が Status パネルにも dump にも出ない
status: wip
category: bug
created: 2026-07-27T10:26:21+09:00
last_read: 2026-08-12T07:56:09+09:00
open_entered: 2026-07-27T10:26:21+09:00
wip_entered: 2026-08-12T07:57:17+09:00
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

# worker が作った TODO が Status パネルにも dump にも出ない

## 概要

daemon の TODO fold が main の transcript しか読まないため、サブエージェント (worker) が
TaskCreate / TaskUpdate したタスクが Status パネルにも `ccmsg dump` の `context.todos` にも
現れない。DR-0020 が掲げる「TUI 同等」と実装がずれている。

### 前提: タスクリストは main と worker で共有ストア (実測済み、推測ではない)

- 単一ストア: worker の TaskGet が main の作ったタスクを description まで取得でき内容一致
- id は単一カウンタ: 過去の worker が #1〜3、別 worker が #4、main が #5〜6、また worker が #7。
  独自ストアなら双方 1 から振り直されるはず
- 双方向に見える: main の #6 は worker から、worker の #7 は main から見える
- TaskList は completed / deleted を返さない (両者とも同じ挙動)

### 症状の機序 (経路が 2 つあり両方塞がっている)

**経路 1 = main の transcript 経由 (attachment が捨てられる)**: worker が作ったタスクは
main の transcript に `{"type":"attachment","attachment":{"type":"task_reminder","content":[...]}}`
として注入される (実測: worker が 23:02:36 に作った #4 が main の jsonl 4961 行目に 23:06:03 の
attachment で出現)。しかし foldLine (packages/daemon/src/session-status.ts:733) は type が
assistant / user / queue-operation の行しか処理せず attachment は即 return false で捨てる。

**経路 2 = worker 自身の transcript (そもそも読まれない)**: worker の TaskCreate tool_use は
subagents/agent-<id>.jsonl に書かれるが、scanTranscript (session-status.ts:1298) が走査するのは
resolveTranscript が返す main の jsonl 1 本だけ。subagents/ を読むコードは存在するが用途が別
(readTeammateModels :832 / readAgentTree :991 / agent-transcripts.ts:181 はいずれも foldLine /
applyTodoUpdate に流していない)。

## 背景

DR-0020 (docs/decisions/DR-0020-session-status-tab.md:28) は「TaskCreate / TaskUpdate の
tool call から task id → {subject, status, owner} を再生。pending / in_progress / completed
別に表示 (TUI 同等)」と書いている。TUI が見せているのは共有ストア (= worker 分込み) なので
現状の fold は TUI 同等を満たさない。DR-0020 は「1 セッション = 1 transcript jsonl に全部
載っている」を暗黙の前提にしており、worker の TaskCreate が別ファイルに書かれる事実が
検討されていない。

### 影響範囲

- Status パネルの TODO セクション: worker 分が丸ごと欠落
- `ccmsg dump` の `context.todos`: v0.75.0 で追加したが同じ snapshot() 経由なので同じ取りこぼしを
  引き継ぐ。巻き戻ったセッションが「worker に何をやらせていたか」を TODO から復元できない

### 対処の方向 (未確定、実装を見て判断)

1. attachment を fold する: main の transcript に既に流れてきている task_reminder を読む。
   走査対象が増えないので安い。ただし attachment の注入タイミングが Claude Code 側の都合に
   依存する (実測では main が TaskList を叩いた前後に出ているが規則は未特定)
2. subagents/*.jsonl も走査する: 情報源として確実だが agent 数に比例して走査コストが増える

方向 1 (attachment fold) を主線に実装開始 (2026-08-12)。方向 2 (subagents 走査) は
DR-0029 のまとめ処理承認が要るため、1 で受け入れ条件を満たせない場合に再判断。

### 関連コード

- packages/daemon/src/session-status.ts の applyTodoUpdate (:349) / TaskCreate・TaskUpdate の
  fold 分岐 (:503-523) / foldLine の attachment を落とす箇所 (:733) / scanTranscript (:1298) /
  getSessionStatus (:1370)
- packages/protocol/src/index.ts の SessionTodo (:312)
- packages/daemon/src/session-dump.ts の loadSessionContext が snapshot().todos を使う箇所
- docs/decisions/DR-0020-session-status-tab.md:28

### 補足: owner フィールド

SessionTodo.owner は存在するが TaskUpdate で明示指定した時だけ入る。エージェント名が自動で
入る仕組みはなく、このセッションの transcript 全体で出現回数 0。「どの worker のタスクか」を
owner から辿ることは現状できない。

## 受け入れ条件

- [ ] worker (subagent) が TaskCreate / TaskUpdate したタスクが Status パネルの TODO セクションに表示される
- [ ] `ccmsg dump` の `context.todos` にも worker 分が含まれる
- [ ] DR-0020 の「TUI 同等」記述と実装が一致する (齟齬が残るなら DR 側を更新)
