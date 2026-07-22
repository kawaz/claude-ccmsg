# 裁定待ち質問集約

kawaz のユーザ裁定が必要な確認事項をラベル + 選択肢で常時集約する。ルール正本は claude-rules-personal の `for-me/rules/questions-md-registry.md` を参照。

## 運用

- 質問提示と同一ターンで本ファイルを更新 + パス指定 commit
- 裁定が下りたら該当セクションを **削除**、裁定内容は正規記録先 (DR / issue / journal / close_reason) に反映
- ラベルはバッチ毎に一意プレフィクス (`RLD-Q1` / `DR13-Q1` の形式、Qn 使い回し禁止)
- 詳細の正本は当該 issue / DR に置き、ここは索引だけ
- 「詳細は _場所_」の場所は本リポ相対パス
- 選択肢は横並びにせず**箇条書き**で書く (kawaz 2026-07-16: 横に長いと読みにくい)

## 現在の裁定待ち

## 👺 SN-Q1: 「daemon 先起動の通知がうるさい」の実体特定

調査の結果 (詳細は docs/issue/2026-07-12-daemon-startup-notification-noise.md)、**daemon 起動/入れ替え/SessionStart 単体で session subscriber に通知が流れる経路は現行コードに存在しない**ことを isolated daemon の実測で確認 (member/leave は suppressed、no-backlog 化済み、reconnect も無音)。SessionStart の pre-warm 自体は「lazy ensure に任せる」方針で撤廃済み (次リリース)。

唯一再現できた「member/title 系がsession に届くケース」= **別セッションが broadcast room を新規作成した時の kind+title snapshot 配信** (deliverNewRoom の設計仕様)。

- a) 最近も「うるさい通知」を体感している → その時の通知内容 (Monitor イベントの 1 行) を貼ってもらえれば実体を特定して根治する
- b) broadcast room 新規作成時の kind+title 配信が犯人だと思う → suppressed に追加する (ただし session Monitor が「join した room の kind/title」を知る唯一の live 経路が消える設計判断を伴う)
- c) 最近は気になっていない (v0.67 系の no-backlog 化で実は解消済みだった) → pre-warm 撤廃だけで issue close

