# DR-0026: ワークスペースセクション (.code-workspace の folders ブラウズ)

Status: Accepted (kawaz が仕様を直接指定、認可は DR-0024 前例踏襲)
Date: 2026-07-17
Sponsor: kawaz

## 1. 背景

セッションの working copy 直下に VS Code の workspace ファイル (例`kuu/main/kuu.code-workspace`) がある場合、その `folders[].path` に列挙されたパス群をFiles ツリーからブラウズしたい (kawaz)。folders には containment root 外のパス (兄弟リポ等)
が普通に入る。

## 2. スコープ

- **検出**: セッション cwd 直下の `*.code-workspace` を fs_list 時 (または session_status fold) に検出。JSONC (コメント・末尾カンマ許容) の寛容 parse
- **解決**: `folders[].path` を workspace ファイルの位置基準で解決・realpath 正規化
- **表示**: Files ツリーに「ワークスペース」セクション (節の並びは §4)。各 folder を root にしたブラウズ (ツリー展開可)
- **認可 (DR-0024 前例踏襲)**: containment root 外の folder は「workspace ファイルに列挙されたパス集合」を allowlist とする読み出し限定 — 任意ブラウズには広げない。
  ディレクトリ単位 allowlist なので DR-0024 (ファイル単位) より広いが、workspace ファイルはリポ内の第一級成果物であり、kawaz 自身が管理する列挙 = 本人の意図。symlink escape はrealpath 検査
- ★ (お気に入り) 対応

## 3. Phase 分割

| Phase | スコープ |
|---|---|
| Phase 1 | daemon: 検出 + JSONC parse + folder-rooted fs_list/fs_read の allowlist 認可 + 敵対テスト |
| Phase 2 | webui: ワークスペースセクション + ★ |

## 4. 節構成とお気に入り (2026-10-20 kawaz 指定)

- 節は お気に入り / ワークスペース / プロジェクト外 の 3 つ。「プロジェクト」節は置かず、セッションの cwd はワークスペース節の folder の 1 つとして出す
- cwd の folder: workspace ファイルに cwd (`"."`) を指す folder があればその名前で (当たるかは daemon が cwd と folder の両方を realpath にして比べ、`is_cwd` で知らせる)、無ければ `PROJECT_ROOT` という folder を先頭に足す (workspace ファイルが無い時も同じ)。cwd の folder は containment root 経由 (fs_list / fs_read) で読み、他の folder は今どおり fs_*_workspace で読む
- お気に入りは正規化したフルパスで持ち、フルパスが同じなら同じお気に入り。相対で保存された項目は containment root 基準でフルパスとして読む。workspace 定義を変えても過去のお気に入りが別物にならないよう、folder への畳み込みは表示時に行う
- お気に入り節は folder ごとにまとめ、各行は folder 内の相対パスで出す。cwd の folder の分は見出し無しで先頭、他の folder は見出し付き (既定で開いた畳める見出し)、どの folder にも無いものは `others` 見出しにフルパスで出す。空の見出しは出さない
- プロジェクト外節も同じ形 (folder ごと + `others`)

## 5. 関連

- kawaz (要件) / docs/issue/2026-07-17-files-vscode-workspace-section.md
- DR-0024 (allowlist 読み出しの前例) / DR-0008 (fs containment)
