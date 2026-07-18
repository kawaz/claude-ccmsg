# DR-0020: Status タブ (セッションの workflow / background / TODO 可視化)

Status: Accepted (ST-Q1..2 裁定 2026-07-16)
Date: 2026-07-16
Sponsor: kawaz r26 mid=24+25

## 1. 背景

TUI の Claude Code は画面下部に workflow リスト / background タスク / TODO リストの
ステータスを常時表示するが、ccmsg webui にはこれが無く、セッションが「作業中なのか、
idle で何かを待っているだけなのか」が分からない (kawaz mid=24)。

必要なデータは daemon が既に配信している transcript jsonl に tool call として全部
記録されている (Workflow / Agent / TaskCreate / TaskUpdate / Monitor / Bash background)。
不足しているのは抽出と表示 UI のみ (抽出は daemon 側で行う、§ 3.1)。

## 2. スコープ

### 2.1 やること

- **表示場所 (ST-Q2 裁定 = 両方、kawaz r26 mid=27)**:
  - **Status タブ**: SessionView のタブ列を Files / Timeline / Rooms / Status に増やし、
    詳細・全体一覧はこちら
  - **TL 下余白の常駐ミニパネル**: 走行中 workflow と in_progress TODO だけの要約
    1-2 行。タップで Status タブへ遷移
- **抽出** (daemon 側、§ 3.1): transcript jsonl から status 関連イベントを全量抽出し、
  畳み込んで現在ステータスを導出
  - **TODO リスト**: TaskCreate / TaskUpdate の tool call から task id → {subject, status,
    owner} を再生。pending / in_progress / completed 別に表示 (TUI 同等)
  - **workflow**: Workflow tool call (起動) と task-notification (完了) を突合して
    走行中 / 完了を判定。meta.name / phases があれば表示
  - **background タスク**: Monitor / Bash run_in_background / Agent (background) の
    起動と完了通知を突合
- **Status タブ UI**: 上記 3 セクションの一覧。走行中は強調、完了は畳む
- **サイドバー SESSIONS 行のミニバッジ** (Phase 分離): `wf:1 bg:2 todo:3/5` 程度の
  要約表示

### 2.2 やらないこと


- セッションへの操作 (task の変更・workflow の停止等)。表示のみ
- TUI との完全一致 (transcript に現れない内部状態は追わない)

## 3. 設計判断

### 3.1 データソース = daemon 側抽出 (ST-Q1 裁定、kawaz r26 mid=32)

webui 側の transcript fold (読み込み済み範囲だけ) 案は棄却。**daemon が transcript
jsonl を grep 相当で絞り込み → jsonl parse → strict フィルタで status 関連イベント
(TaskCreate / TaskUpdate / Workflow / Monitor / Agent / task-notification) だけを
全量抽出**して返す。ファイル全走査でも対象行の抽出は一瞬で終わる想定 (kawaz)。

- 新 op (例 `session_status`): 初回は全量スキャンして畳み込み済み or 生イベント列を返す
- **追加分は逐次 push**: 既存の transcript_subscribe と同様の tail 追跡で、新しい
  status イベントが現れたら subscribe 中の webui へ push (詳細設計は Phase 1)
- これにより webui の読み込み範囲問題 (旧 ST-Q1) は消滅。畳み込み (イベント列 →
  現在状態) を daemon / webui どちらでやるかは Phase 1 の実装時判断 (protocol を
  薄く保つなら webui 側 fold、転送量を絞るなら daemon 側)

## 4. Phase 分割

| Phase | スコープ |
|---|---|
| Phase 0 | 本 DR + ST-Q1 裁定 |
| Phase 1 | daemon 抽出 op + 逐次 push + fold (テスト込み) |
| Phase 2 | Status タブ UI |
| Phase 3 | サイドバー ミニバッジ |

## 5. 関連

- kawaz r26 mid=24 (要件) / mid=25 (タブ配置の裁定)
- DR-0009 (transcript access) — データ経路の正本
- DR-0010 (timeline markdown) — transcript parse 層の前例

## Addendum 2026-07-18: model / effort 表示 (kawaz r34 mid=8)

セッション自身とチームメイトの現在 model・effort を Status タブ + TL ミニパネルに
表示する (DR-0020 の延長、独立 DR は立てない)。

- データ源: transcript jsonl の assistant 行 — `message.model` (foldContextUsage が
  既に採用) と top-level `effort` (実測: assistant 行のみに付く。CC バージョンに
  よっては欠落 = optional)。チームメイトは `<sidDir>/subagents/agent-*.meta.json` の
  `model` (spawn 時固定、`[1m]` 付きの生値) を snapshot 時に読む。teammate 側の
  effort は meta.json に無く transcript を開くコストが割に合わないため対象外。
- 表示は「transcript 上の最新観測値」でありリアルタイム保証はない (context 表示と
  同じ位置づけ)。
- 転送形: `SessionContextUsage.effort?` を追加、`SessionTeammate.model?` を追加。
  いずれも optional なので旧クライアント互換。
