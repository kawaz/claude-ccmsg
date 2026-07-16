# DR-0020: Status タブ (セッションの workflow / background / TODO 可視化)

Status: Proposed
Date: 2026-07-16
Sponsor: kawaz r26 mid=24+25

## 1. 背景

TUI の Claude Code は画面下部に workflow リスト / background タスク / TODO リストの
ステータスを常時表示するが、ccmsg webui にはこれが無く、セッションが「作業中なのか、
idle で何かを待っているだけなのか」が分からない (kawaz mid=24)。

必要なデータは daemon が既に配信している transcript jsonl に tool call として全部
記録されている (Workflow / Agent / TaskCreate / TaskUpdate / Monitor / Bash background)。
不足しているのは抽出層と表示 UI のみで、daemon / protocol の変更は不要。

## 2. スコープ

### 2.1 やること

- **表示場所 (ST-Q2 裁定 = 両方、kawaz r26 mid=27)**:
  - **Status タブ**: SessionView のタブ列を Files / Timeline / Rooms / Status に増やし、
    詳細・全体一覧はこちら
  - **TL 下余白の常駐ミニパネル**: 走行中 workflow と in_progress TODO だけの要約
    1-2 行。タップで Status タブへ遷移
- **抽出層** (webui pure 層、transcript-model.ts の隣): transcript イベント列を畳み込んで
  現在ステータスを導出
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

- daemon / protocol の変更 (transcript 経路で足りる)
- セッションへの操作 (task の変更・workflow の停止等)。表示のみ
- TUI との完全一致 (transcript に現れない内部状態は追わない)

## 3. 設計判断

### 3.1 データソース = transcript fold (daemon 変更なし)

`claude agents --json` は busy/idle しか持たず、TODO/workflow は載らない。transcript
jsonl は tool call を全部含み、webui は既に Timeline 用に parse 済み — 抽出層の追加が
最小変更。トレードオフ: transcript の読み込み範囲 (末尾ページング) 外の古い
TaskCreate は見えない。

### 3.2 読み込み範囲の妥協 (裁定待ち ST-Q1)

現行 Timeline は末尾から byte offset でページングする。TODO の正確な再生には
セッション先頭からの全量 fold が要るが、数百 MB 級 transcript では現実的でない。
案: (a) 読み込み済み範囲だけで fold し「それ以前の状態は不明」と明示 /
(b) Status タブ表示時に追加で older ページを自動読みして充足するまで遡る。

## 4. Phase 分割

| Phase | スコープ |
|---|---|
| Phase 0 | 本 DR + ST-Q1 裁定 |
| Phase 1 | 抽出層 (pure function + テスト) |
| Phase 2 | Status タブ UI |
| Phase 3 | サイドバー ミニバッジ |

## 5. 関連

- kawaz r26 mid=24 (要件) / mid=25 (タブ配置の裁定)
- DR-0009 (transcript access) — データ経路の正本
- DR-0010 (timeline markdown) — transcript parse 層の前例
