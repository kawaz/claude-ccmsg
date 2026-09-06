---
title: セッション状態の取得元を `claude agents --json` から `sessions/<pid>.json` の直読みに変える
status: open
category: design
created: 2026-09-06T18:34:57+09:00
last_read:
open_entered: 2026-09-06T18:34:57+09:00
wip_entered:
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

# セッション状態の取得元を `claude agents --json` から `sessions/<pid>.json` の直読みに変える

## 概要

daemon のセッション状態取得元を `claude agents --json` から `<config_dir>/sessions/<pid>.json`
の直読みに変え、活動判定 (Busy/Idle) は llm-gateway から届く request/response イベントに寄せる。

## 背景

実測 (2026-09-06) で、`claude agents --json` の busy は `sessions/<pid>.json` の生 status
`"shell"` を丸めたものだと判明した。persistent な Monitor (ccmsg subscribe) を張った時点で
`shell` になり、Monitor が生きる限り変わらない (16/16 本が subscribe 貼り直し時刻の
`statusUpdatedAt` のまま、jsonl 最終更新 14〜42 分前・CPU ≈ 0)。ccmsg 無しの 9 本は全部
idle だった。つまり busy/idle は「いま処理中か」の指標になっておらず、ccmsg 接続の有無と
一致してしまっている。

## 受け入れ条件

- [ ] daemon の agents ポーリングを `sessions/*.json` の直読みに変える。生の status
      (`shell` / `busy` / `idle` / `waiting`) と `waitingFor`・pid・cwd を取る
      (subprocess の 5 秒ポーリングも不要になる)。ファイル形式は upstream
      非公開なので変化に備えたフォールバックを残す
- [ ] SessionList の Busy / Idle 判定は `claude agents` の値 (transcript の turn 状態)
      でなく、llm-gateway から届く request/response イベント (cache ring のために
      既に relay しているもの) を正にする。最後のリクエストのレスポンス完了 = Idle、
      リクエスト進行中 = Busy (kawaz r278m10 の裁定)。transcript / jsonl は活動判定に
      使わない
- [ ] `claude agents` 由来の値は「プロセスの存在」「waiting (dialog)」「pid / cwd / name」
      にだけ使う
- [ ] 生 status `"shell"` は Monitor 等の背景 shell が動いている待機中を示す (実測)。
      この事実は活動判定の切替後も残す

## TODO

関連: docs/QUESTIONS.md の SS-Q1 / SS-Q2 (セクション再設計、r278 の議論)。
