# 裁定待ち質問集約

kawaz のユーザ裁定が必要な確認事項をラベル + 選択肢で常時集約する。ルール正本は claude-rules-personal の `for-me/rules/questions-md-registry.md` を参照。

## 運用

- 質問提示と同一ターンで本ファイルを更新 + パス指定 commit
- 裁定が下りたら該当セクションを **削除**、裁定内容は正規記録先 (DR / issue / journal / close_reason) に反映
- ラベルはバッチ毎に一意プレフィクス (`RLD-Q1` / `DR13-Q1` の形式、Qn 使い回し禁止)
- 詳細の正本は当該 issue / DR に置き、ここは索引だけ
- 「詳細は _場所_」の場所は本リポ相対パス

## 現在の裁定待ち

### UNIF-Q1: ROOM Composer と 1on1 floating の UI 統一方針

出典: kawaz r15 mid=1 (2026-07-14) `#r15-m1`。原文: 「ルームだけメッセージフォームが違うのもアレなので＋ボタン ui に合わせましょう。」

背景: v0.29.0 (attachment 実装) 後の現状 UI 差分:
- 通常 room (RoomView): inline Composer、画像/ファイル 2 添付ボタン + textarea + 送信、broadcast は宛先選択 hint 追加
- 1on1 (SessionView): 右下 position:fixed 丸「＋」ボタン → クリックで floating popup 内に textarea + 送信/閉じる

- a) **通常 room / broadcast Composer 側の「画像 + ファイル」2 添付ボタンを「＋」1 個の展開メニューに集約** (attachment ボタンだけの UI 統一、Composer 本体の inline レイアウトは維持) (**AI 推し** — attachment 実装後の文脈と直結、変更範囲小)
- b) 通常 room 全体を 1on1 と同じ「右下＋ボタン → floating popup」スタイルに変更 (全体の Composer 展開スタイル統一、UI 変更大)
- c) その他

参照: `packages/webui/src/client/components/Composer.tsx`, `SessionView.tsx` の 1on1 floating composer (DR-0014 §2.6)。

### TLR-Q1: session Timeline 「訪問時の最新反映」修正方針

出典: kawaz r12 mid=12 (2026-07-14) 観測、webui-history-fix worker 調査で別問題として issue 化。

- a) 常時 `transcript_subscribe` を維持 (unsubscribe しない、複数 session だと帯域負荷)
- b) tab 復帰時に自動 refresh (`transcript_read` で最新を取り直す) (**AI 推し** — 帯域と実装の trade-off が最も軽い)
- c) SessionTreeState cache に TTL 導入
- d) UI に「更新」ボタンで手動 refresh

参照: docs/issue/2026-07-14-session-tl-refresh-on-revisit.md。DR 追加要否も含めて裁定要 (b/c は DR 不要、a は DR-0009 追記が要る)。
