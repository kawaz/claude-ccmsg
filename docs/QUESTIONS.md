# 裁定待ち質問集約

kawaz のユーザ裁定が必要な確認事項をラベル + 選択肢で常時集約する。ルール正本は claude-rules-personal の `for-me/rules/questions-md-registry.md` を参照。

## 運用

- 質問提示と同一ターンで本ファイルを更新 + パス指定 commit
- 裁定が下りたら該当セクションを **削除**、裁定内容は正規記録先 (DR / issue / journal / close_reason) に反映
- ラベルはバッチ毎に一意プレフィクス (`RLD-Q1` / `DR13-Q1` の形式、Qn 使い回し禁止)
- 詳細の正本は当該 issue / DR に置き、ここは索引だけ
- 「詳細は _場所_」の場所は本リポ相対パス

## 現在の裁定待ち

### SEQ-Q1: 全 StorageEvent 横断の連番 field 名を `seq` にして良いか

subscribe 再接続で非 msg イベント (archive 等) が毎回再配信される bug
(詳細: `docs/issue/2026-07-15-subscribe-reconnect-nonmsg-redelivery.md`) の fix に、
全 event 型横断の daemon 採番連番が必要。既存 field は流用不可
(`ts` = 時刻のみで同一 ms 衝突あり / `id` = member id で意味衝突 / `mid` = msg 内連番)。

- **a. `seq: number` を全 StorageEvent に追加 (AI 推し)** — 短名・DB 慣習に沿う。member `id` と衝突しない
- b. 別命名 (自由記述で指定)

裁定後 DR-0016 起草 → 実装 → issue close。
