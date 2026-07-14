# 裁定待ち質問集約

kawaz のユーザ裁定が必要な確認事項をラベル + 選択肢で常時集約する。ルール正本は claude-rules-personal の `for-me/rules/questions-md-registry.md` を参照。

## 運用

- 質問提示と同一ターンで本ファイルを更新 + パス指定 commit
- 裁定が下りたら該当セクションを **削除**、裁定内容は正規記録先 (DR / issue / journal / close_reason) に反映
- ラベルはバッチ毎に一意プレフィクス (`RLD-Q1` / `DR13-Q1` の形式、Qn 使い回し禁止)
- 詳細の正本は当該 issue / DR に置き、ここは索引だけ
- 「詳細は _場所_」の場所は本リポ相対パス

## 現在の裁定待ち

### OTO-Q1..Q3: session Timeline からの 1on1 送信機能

出典: kawaz r12 mid=10 (2026-07-14) 提案、a3 r12 mid=11 で 3 論点整理。実装スコープ: SessionView Timeline tab 下部に Composer + 送信で 1on1 ルーム (無ければ「リポ名 1on1 sid8」タイトルで auto-create) + priv 送信 + タイトルに `1on1` を含むルームからの user priv は SessionView の TL 側で表示。

- **OTO-Q1**: 「セッション出力として応答」の具体像
  - **a) webui の SessionView Timeline view の UI に priv 履歴を表示** (agent は subscribe stream で受け取り、既存の AI 応答経路で返す) (**AI 推し**)
  - b) session の Claude Code process 側に何か注入する (transcript 直接書き込み等)
- **OTO-Q2**: msg jsonl に応答経路 hint フィールド (`reply_via` 等) を daemon が刻印して agent の判断を明示化するか
  - **a) 賛成** (応答ルールが 4→5 と増えると pattern match の暗黙知になる = 事故源、明示 hint で agent は迷わず従える、SKILL 記述も減る) (**AI 推し**)。詳細スキーマは a 確定後に別 Q として起こす
  - b) SKILL のルールで代替 (フィールド追加なし)
- **OTO-Q3**: 5 番目応答パターン
  - **a) c-1: 「1on1 ルーム (kind:1on1 or title に "1on1") から user priv 受信」→ session TL に表示** (今回の新機能そのものが 5 番目) (**AI 推し**)
  - b) c-3: 「archive 済み room の post 受信」→ 応答不要 (静穏化フラグ) を 5 番目に立てる (6 番目候補としては残す)
  - c) その他

参照: r12 mid=10 (kawaz 原文) / mid=11 (a3 の 3 論点整理)。全 Q 裁定後 DR-0014 (仮) 起草 → 実装。broadcast 実装 (DR-0013 Accepted) との順序は本 Q 裁定タイミングで判断。

### TLR-Q1: session Timeline 「訪問時の最新反映」修正方針

出典: kawaz r12 mid=12 (2026-07-14) 観測、webui-history-fix worker 調査で別問題として issue 化。

- a) 常時 `transcript_subscribe` を維持 (unsubscribe しない、複数 session だと帯域負荷)
- b) tab 復帰時に自動 refresh (`transcript_read` で最新を取り直す) (**AI 推し** — 帯域と実装の trade-off が最も軽い)
- c) SessionTreeState cache に TTL 導入
- d) UI に「更新」ボタンで手動 refresh

参照: docs/issue/2026-07-14-session-tl-refresh-on-revisit.md。DR 追加要否も含めて裁定要 (b/c は DR 不要、a は DR-0009 追記が要る)。
