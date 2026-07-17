# DR-0026: ワークスペースセクション (.code-workspace の folders ブラウズ)

Status: Accepted (kawaz r26 mid=113 が仕様を直接指定、認可は DR-0024 前例踏襲)
Date: 2026-07-17
Sponsor: kawaz r26 mid=113

## 1. 背景

セッションの working copy 直下に VS Code の workspace ファイル (例
`kuu/main/kuu.code-workspace`) がある場合、その `folders[].path` に列挙されたパス群を
Files ツリーからブラウズしたい (kawaz)。folders には containment root 外のパス (兄弟リポ等)
が普通に入る。

## 2. スコープ

- **検出**: セッション cwd 直下の `*.code-workspace` を fs_list 時 (または session_status
  fold) に検出。JSONC (コメント・末尾カンマ許容) の寛容 parse
- **解決**: `folders[].path` を workspace ファイルの位置基準で解決・realpath 正規化
- **表示**: Files ツリーに「ワークスペース」セクション (お気に入り / ワークスペース /
  プロジェクト / プロジェクト外 の並び)。各 folder を root にしたブラウズ (ツリー展開可)
- **認可 (DR-0024 前例踏襲)**: containment root 外の folder は「workspace ファイルに
  列挙されたパス集合」を allowlist とする読み出し限定 — 任意ブラウズには広げない。
  ディレクトリ単位 allowlist なので DR-0024 (ファイル単位) より広いが、workspace ファイルは
  リポ内の第一級成果物であり、kawaz 自身が管理する列挙 = 本人の意図。symlink escape は
  realpath 検査
- ★ (お気に入り) 対応

## 3. Phase 分割

| Phase | スコープ |
|---|---|
| Phase 1 | daemon: 検出 + JSONC parse + folder-rooted fs_list/fs_read の allowlist 認可 + 敵対テスト |
| Phase 2 | webui: ワークスペースセクション + ★ |

## 4. 関連

- kawaz r26 mid=113 (要件) / docs/issue/2026-07-17-files-vscode-workspace-section.md
- DR-0024 (allowlist 読み出しの前例) / DR-0008 (fs containment)
