# DR-0024: プロジェクト外セクション (セッションが触った cwd 外ファイルの表示)

Status: Accepted (kawaz r26 mid=99 が仕様を直接指定)
Date: 2026-07-17
Sponsor: kawaz r26 mid=99

## 1. 背景

セッションが Read/Write/Edit で触った **cwd (containment root) 外のファイル**を webui で
見たい。自由なプロジェクト外ブラウズではなく、**セッションが実際に触ったファイルの
フルパスリスト**に限定 (kawaz 明示)。

## 2. 仕様 (kawaz mid=99 の指定)

- Files ツリーの「お気に入り」「プロジェクト」に続く第 3 セクション **「プロジェクト外」**
- 内容: そのセッションの transcript から Read/Write/Edit (+ NotebookEdit) の tool call
  file_path を抽出し、**containment root 内のものを除外**したフルパス一覧 (重複除去)
- クリックでファイルビューアに表示 (読み出しは「触ったファイルリスト」への containment に
  相当する認可 — § 3)
- **お気に入り追加可能** (★ トグルを同セクションにも)
- **セクション内リストごとの横スクロール**: プロジェクト外はフルパスで幅が溢れるため。
  既存ツリー (深い dir / 長名で右が隠れる既知問題) も同様にセクション単位の横スクロールを付ける

## 3. 設計

### 3.1 抽出 (daemon)

- session_status (DR-0020) と同じ transcript fold 相乗り、または fs 系の新 op。tool call
  (Read/Write/Edit/NotebookEdit/MultiEdit) の input.file_path / notebook_path を抽出し、
  realpath 正規化 → containment root 外のみ返す
- 逐次 push は session_status の既存基盤に相乗りできるなら乗る (実装時判断)

### 3.2 読み出し認可 (重要)

fs_read の containment は root 配下限定のまま。プロジェクト外ファイルの読み出しは
**「そのセッションが触ったと transcript に記録されているパス」の集合に限定**して許可する
新しい認可面 (allowlist ベース)。任意パス読み出しには絶対に広げない。symlink escape は
realpath で検査 (既存 fs-access の流儀)。

### 3.3 webui

- FileTree に第 3 セクション。行はフルパス表示 + ★。クリックで FileViewer (認可は § 3.2 経由)
- セクション毎に overflow-x: auto (既存セクションにも適用)

## 4. Phase 分割

| Phase | スコープ |
|---|---|
| Phase 1 | daemon: 抽出 + allowlist 読み出し認可 + テスト (敵対: allowlist 外 / symlink) |
| Phase 2 | webui: プロジェクト外セクション + 横スクロール + ★ |

## 5. 関連

- kawaz r26 mid=99 (仕様全文)
- DR-0008 (fs_list/fs_read containment) — 認可の基盤
- DR-0020 (session_status fold) — 抽出の相乗り候補
