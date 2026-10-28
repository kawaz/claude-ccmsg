# DR-0020: Status タブ (セッションの workflow / background / TODO 可視化)

Status: Accepted (ST-Q1..2 裁定 2026-07-16)。§3.1 の fold が読む行の源 (tail から push へ) は [DR-0045](./DR-0045-say-speaks-in-tool-shown-from-transcript.md) §5 が定める
Date: 2026-07-16
Sponsor: kawaz

## 1. 背景

TUI の Claude Code は画面下部に workflow リスト / background タスク / TODO リストのステータスを常時表示するが、ccmsg webui にはこれが無く、セッションが「作業中なのか、idle で何かを待っているだけなのか」が分からない (kawaz)。

必要なデータは daemon が既に配信している transcript jsonl に tool call として全部記録されている (Workflow / Agent / TaskCreate / TaskUpdate / Monitor / Bash background)。
不足しているのは抽出と表示 UI のみ (抽出は daemon 側で行う、§ 3.1)。

## 2. スコープ

### 2.1 やること

- **表示場所 (ST-Q2 裁定 = 両方、kawaz)**:
  - **Status タブ**: SessionView のタブ列を Files / Timeline / Rooms / Status に増やし、詳細・全体一覧はこちら
  - **TL 下余白の常駐ミニパネル**: 走行中 workflow の要約。タップで Status タブへ遷移
- **抽出** (daemon 側、§ 3.1): transcript jsonl から status 関連イベントを全量抽出し、畳み込んで現在ステータスを導出
  - **TODO リスト**: TaskCreate / TaskUpdate の tool call から task id → {subject, status, owner} を再生。pending / in_progress / completed 別に表示 (TUI 同等)
  - **workflow**: Workflow tool call (起動) と task-notification (完了) を突合して走行中 / 完了を判定。meta.name / phases があれば表示
  - **background タスク**: Monitor / Bash run_in_background / Agent (background) の起動と完了通知を突合
- **Status タブ UI**: 上記 3 セクションの一覧。走行中は強調、完了は畳む
- **サイドバー SESSIONS 行のミニバッジ** (Phase 分離): `wf:1 bg:2 todo:3/5` 程度の要約表示

### 2.2 やらないこと


- セッションへの操作 (task の変更・workflow の停止等)。表示のみ
- TUI との完全一致 (transcript に現れない内部状態は追わない)

## 3. 設計判断

### 3.1 データソース = daemon 側抽出 (ST-Q1 裁定、kawaz)

webui 側の transcript fold (読み込み済み範囲だけ) 案は棄却。**daemon が transcript jsonl を grep 相当で絞り込み → jsonl parse → strict フィルタで status 関連イベント(TaskCreate / TaskUpdate / Workflow / Monitor / Agent / task-notification) だけを全量抽出**して返す。ファイル全走査でも対象行の抽出は一瞬で終わる想定 (kawaz)。

- 新 op (例 `session_status`): 初回は全量スキャンして畳み込み済み or 生イベント列を返す
- **追加分は逐次 push**: 新しい status イベントが現れたら subscribe 中の webui へ push する。行の源は module から push される会話の行 ([DR-0045](./DR-0045-say-speaks-in-tool-shown-from-transcript.md) §5)
- これにより webui の読み込み範囲問題 (旧 ST-Q1) は消滅。畳み込み (イベント列 →
  現在状態) を daemon / webui どちらでやるかは Phase 1 の実装時判断 (protocol を薄く保つなら webui 側 fold、転送量を絞るなら daemon 側)

## 4. Phase 分割

| Phase | スコープ |
|---|---|
| Phase 0 | 本 DR + ST-Q1 裁定 |
| Phase 1 | daemon 抽出 op + 逐次 push + fold (テスト込み) |
| Phase 2 | Status タブ UI |
| Phase 3 | サイドバー ミニバッジ |

## 5. 関連

- kawaz (要件、タブ配置の裁定)
- DR-0009 (transcript access) — データ経路の正本
- DR-0010 (timeline markdown) — transcript parse 層の前例

## Addendum 2026-07-18: model / effort 表示 (kawaz)

セッション自身とチームメイトの現在 model・effort を Status タブ + TL ミニパネルに表示する (DR-0020 の延長、独立 DR は立てない)。

- データ源: transcript jsonl の assistant 行 — `message.model` (foldContextUsage が既に採用) と top-level `effort` (実測: assistant 行のみに付く。CC バージョンによっては欠落 = optional)。チームメイトは `<sidDir>/subagents/agent-*.meta.json` の`model` (spawn 時固定、`[1m]` 付きの生値) を snapshot 時に読む。teammate 側のeffort は meta.json に無く transcript を開くコストが割に合わないため対象外。
- 表示は「transcript 上の最新観測値」でありリアルタイム保証はない (context 表示と同じ位置づけ)。
- 転送形: `SessionContextUsage.effort?` を追加、`SessionTeammate.model?` を追加。
  いずれも optional なので旧クライアント互換。

## Addendum 2026-08-12: subagent の TODO を task_reminder attachment から取る

§ 2.1 の「TaskCreate / TaskUpdate の tool call から再生 (TUI 同等)」は「1 セッション =
1 transcript jsonl に全部載っている」を暗黙の前提にしていたが、subagent (worker) のTaskCreate / TaskUpdate は `<sidDir>/subagents/*.jsonl` に書かれ、main の jsonl には現れない。タスクストアは main / worker で共有 (実測: id は単一カウンタ、双方向にTaskGet できる) なので、TUI は worker 分も含めて表示する = 従来の fold は「TUI 同等」を満たしていなかった。

- **データ源**: main の transcript に harness が注入する`{"type":"attachment","attachment":{"type":"task_reminder","content":[...]}}` 行。
  item は `{id, subject, description, activeForm, status, owner, blocks, blockedBy}`。
  worker のタスクが main 側に現れる唯一の経路。
- **適用は upsert のみ、削除はしない**: content は全ストアの snapshot ではない(実測: 直近バッチだけが載り、そのバッチが全部 completed になると空になる。それ以前のタスクは content から消えても id は生きたまま)。空 content を「タスク無し」と解釈するとtool_use fold が正しく記録したタスクを消すため、削除は `TaskUpdate status:"deleted"` の専権のままとする (deleted は attachment に載らないので競合しない)。
- **blockedBy / blocks は置換**: TaskUpdate は `addBlockedBy` の「足す」形だが attachment は両方向の完全な list を持つ (addBlockedBy しか呼ばれていないタスクに逆向きの `blocks` が入る)。attachment 側を権威として置換する。
- **subagents/*.jsonl の全走査は採らない**: agent 数に比例した走査コストを毎 fold 払う必要がある一方、attachment だけで受け入れ条件 (worker タスクが Status / dump に出る) を満たせることを実 transcript で確認した。
- **既知の限界**: attachment は生成から注入までに遅延があり、直後の tool_use が進めたstatus を一瞬巻き戻して見せうる。次の reminder か次の TaskUpdate が後勝ちで正すため収束する。

## Addendum 2026-10-25: TODO 一覧を畳む、プロセスの稼働時間と Claude Code の版 (kawaz)

- **TODO 一覧は既定で閉じる**: TODO が多いと Status タブの他の節を押し下げて邪魔になり、重要度も他の節より低い。節全体を `<details>` にし、見出しに全件数 (`TODO (n)`) を出す。開閉の状態は保持しない。開いた中身は従来どおり (in_progress、pending は開いた fold、completed は閉じた fold)。TODO が 1 件も無いセッションでは節を出さない (Background と同じ)。
- **稼働時間**: そのプロセスの起動からの経過。データ源は Claude Code の `sessions/<pid>.json` の `startedAt` (agents の行に既に載っている)。resume は新しいプロセスなので、そこから数え直す。書式は webui が経過を出す既存の `formatDuration` (メッセージバブルの相対時間、応答中の経過と同じ `5s` / `1m12s` / `5h12m` / `2d15h`) に揃え、個別の書式を作らない。Status タブに `UPTIME` の行、TL 下ミニパネルの ctx 行の末尾に出す。Status タブはタブを開いた時点の値で、開いている間は更新しない。
- **Claude Code の版**: 同じ `sessions/<pid>.json` の `version` (プロセスごと。2 つの config dir の全ファイルにあることを 2026-10-25 に確認)。agents の行に optional の `version` として載せる。表示は DR-0043 §5.3 (GLOBALS)。transcript の各行の `version` は採らない: プロセスの記録の方が「今動いているプロセスの版」を直接言う。
- ctx 行は `12%[1m] / fable-5-1 / low / 2d15h` の形になる (先頭は context の使用率と、直後の角括弧に context window の大きさ `[1m]` / `[200K]`。次に model、effort、稼働時間。区切りは ` / `。model は transcript の最新の assistant 行 (非 sidechain・非 synthetic) の `message.model` から `claude-` を落とした実際に適用された model ID `fable-5-1` で、hooks module が名乗る起動時の別名 (`fable[1m]`) は使わない。`[1m]` は model には付けず分母側だけ)。window が分からない間は率の代わりに token 数 (`120k`) を出す。assistant 行がまだ無い間 (context の観測が無い間) も、プロセスの行があれば `35m20s` だけの行を出す。
