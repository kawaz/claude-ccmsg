# DR-0059: セッションが Waiting の間、TL の末尾に `Waiting...` を出す

- Status: Accepted (2026-11-21、kawaz 指示) — ✅ 実装済み (`timeline/bubbles.tsx` の `WaitingNotice`、`Timeline` の末尾の並び、app.css の `.tl-waiting-notice` / `.tl-waiting-notice-label`)
- Date: 2026-11-21

## Context

セッションが Waiting (承認待ち等の dialog が人を待っている) かは Claude Code の `sessions/<pid>.json` の `status` (webui には agents の行で届く) にしか無く、transcript に現れない。サイドバーを隠して TL だけを見ていると気づく手段が無い。kawaz の指示 (2026-11-21) の要点:

> TL の一番下に普通に `Waiting...` っていう大きめフォントの黄色文字が出るだけで良い。何か反応ないな?って気づくのは応答を待っている時で、TL の一番下を見ている。エラーの場合はそこに赤字で API エラーが出て気づくし、Waiting も同じ場所に何か表示が出ればそれで良い。

## 目的

応答を待って TL の一番下を見ている人が、そのセッションが人の操作を待っていることに、サイドバー無しで気づける。

増やしたくないもの:

- Waiting の判定 (サイドバーの Waiting と TL で別の判定を持たない)
- TL の行の種類 (会話の行として数えるもの。この行は既読・検索・選択・位置・ブックマークを持たない)

## Decision

### 1. 出す条件

- セッション本体の TL に、そのセッションの状態がサイドバーの Waiting と同じ (`toSessionRow` で作った行の `sessionStatus` が `"waiting"`) 間だけ出す。Waiting でなくなれば消える
- Error (`"error"`、harness の API エラーで止まった) の時は出さない。エラーは TL に出る。サイドバーと同じく Error が Waiting に優先する
- subagent / teammate の TL (locator に agent がある) には出さない。Waiting はセッション本体の状態
- Files / Status / Terminal のタブには出さない (TL の末尾の行なので)
- 出すかは Timeline が store (peers・agents・セッションのエラー) から描画で導く

### 2. 置き場と見た目

- TL の末尾の並び ([DR-0054](./DR-0054-timeline-day-bands.md) §1 の「最後の項目 → 末尾の経過時間 → 今日の帯 → 応答中の行」) の後ろに置く。API エラーの行 (`turn interrupted`) が TL の最後の項目として出るのと同じ、TL の項目の並びの一番下。その下に来るのは、会話の行ではない「↑最新のプロンプトへ移動↑」のボタン (DR-0054 §10) だけ
- 形は API エラーの行 (`.tl-line.tl-api-error`) と同じで、色と文言だけを変える: 左の 3px の罫と薄い地を `--warn` で、文字は `Waiting...` を `--warn` の色・太字・`--font-size-4xl` (TL の本文より大きい)
- 文言は `Waiting...` だけ。点滅・動き・アイコンは足さない。`role="status"`

## Alternatives Considered

| 案 | 採らない理由 |
|---|---|
| TL の背景の色を warn に寄せる | kawaz の指示で差し替えた。応答を待つ人が見ているのは TL の一番下で、エラーも同じ場所に出る |
| `waitingFor` (何を待っているか) を添える | kawaz の指示は `Waiting...` だけ。Claude Code の語のままで、人に向けた文言ではない |

## Consequences

- agents の行の更新 (daemon の poll) に合わせて出入りするので、Waiting になってから出るまで poll の間隔だけ遅れる

## 関連

- [DR-0043](./DR-0043-sidebar-folds-and-globals.md) — サイドバーの Sessions の Waiting の区画
- [DR-0044](./DR-0044-turn-abort.md) — TL の末尾の応答中の行
- [DR-0054](./DR-0054-timeline-day-bands.md) — TL の末尾の並び
