# 裁定待ち質問集約

kawaz のユーザ裁定が必要な確認事項をラベル + 選択肢で常時集約する。ルール正本は claude-rules-personal の `for-me/rules/questions-md-registry.md` を参照。

## 運用

- 質問提示と同一ターンで本ファイルを更新 + パス指定 commit
- 裁定が下りたら該当セクションを **削除**、裁定内容は正規記録先 (DR / issue / journal / close_reason) に反映
- ラベルはバッチ毎に一意プレフィクス (`RLD-Q1` / `DR13-Q1` の形式、Qn 使い回し禁止)
- 詳細の正本は当該 issue / DR に置き、ここは索引だけ
- 「詳細は _場所_」の場所は本リポ相対パス

## 現在の裁定待ち

### IB (fs_write / inbox, DR-0019)

- **IB-Q3**: DR-0019 (webui Files から docs/inbox/ への新規ファイル作成、fs_write op) の Phase W1 実装に進んで良い? 選択肢: (a) 進める、(b) inbox 手動運用をしばらく見てから。**AI 推し = (a)** スコープが inbox 限定 write で小さく、スマホ完結の価値が高い。詳細は `docs/decisions/DR-0019-fs-write-inbox.md`

### LN (Session Launcher, DR-0018)

- **LN-Q1**: 設定ファイル形式・位置は? 選択肢: (a) 既存 daemon config に統合、(b) 独立 `~/.config/ccmsg/session-launcher.yaml`、(c) 独立 `.ccmsg.yaml` (cwd 直下、リポ別に持てる)。**AI 推し = (a)** 単一 config で管理コスト最小、location 変わっても既存経路踏襲。詳細は `docs/decisions/DR-0018-session-launcher.md#31` § 3.1
- **LN-Q2**: 変数展開 `{cwd}` `{model}` `{effort}` `{prompt}` の安全性: (a) 単純 str replace、shell escape は template 側 (kawaz) 責務、(b) daemon が引数リストとして安全に組み立て `execve` (shell 経由なし = template の `$(bump-semver ...)` などの bash 構文が使えなくなる)。**AI 推し = (a)** template の柔軟性 (bash 展開含む) が要件。config を kawaz 自身で編集する前提なら誤 escape リスクは自己管理。詳細は DR-0018 § 3.1
- **LN-Q3**: dir_tree の depth と展開インタラクション: (a) 常に depth 2 まで一括 fetch (top level ロード時、UI は展開/折り畳みのみ)、(b) lazy = ノード展開時に子の 1 段を追加 fetch (深いツリーで初回速い)。**AI 推し = (a)** kawaz の root_dirs 配下は既に「所有者 / リポ / worktree」の 3 段が典型で、2 段 = リポ + worktree で用が足りる。詳細は DR-0018 § 3.2 の dir_tree op
- **LN-Q4**: 設定変更を反映するには? (a) daemon 再起動が必要、(b) SIGHUP or 専用 op で reload、(c) webui から reload ボタン。**AI 推し = (a)** 頻度低い + daemon 再起動は `just push` 経由でも自動、余計な reload 経路を作らない。詳細は DR-0018 § 3.3
