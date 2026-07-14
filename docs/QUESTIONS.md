# 裁定待ち質問集約

kawaz のユーザ裁定が必要な確認事項をラベル + 選択肢で常時集約する。ルール正本は claude-rules-personal の `for-me/rules/questions-md-registry.md` を参照。

## 運用

- 質問提示と同一ターンで本ファイルを更新 + パス指定 commit
- 裁定が下りたら該当セクションを **削除**、裁定内容は正規記録先 (DR / issue / journal / close_reason) に反映
- ラベルはバッチ毎に一意プレフィクス (`RLD-Q1` / `DR13-Q1` の形式、Qn 使い回し禁止)
- 詳細の正本は当該 issue / DR に置き、ここは索引だけ
- 「詳細は _場所_」の場所は本リポ相対パス

## 現在の裁定待ち

### REPLY-Q3: `ccmsg reply` の引数形

reply コマンド (r17 mid=16-19 で議論中の返信仲介機能) の CLI 形。

- **a. `ccmsg reply <rNmN> <msg>` (AI 推し)** — `post <room> <msg>` と同じ positional 慣習。`--stdin` 等は後からオプションで足せる
- b. `ccmsg reply --to rNmN --msg <text>` (kawaz mid=19 の表記)

### REPLY-Q4: wire field の処遇

- **a. `reply_via` → `reply_to` に置換、値は `rNmN` / `tl` / `none` の 3 形 (AI 推し)** — CLI が指示文行の生成に使う。routing 記法 (`r10u1a32a35`) は宛先計算が daemon の reply 処理に移るので廃止
- b. reply_via 完全削除 + 指示文行のみ (機械可読な mode が消える)

詳細経緯: r17 mid=16-19。REPLY-Q1=a (宛先 = 元 from + 元 to − 自分 + u1、daemon 構成) は裁定済み。
