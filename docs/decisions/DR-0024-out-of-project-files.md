# DR-0024: 触ったファイルセクション (セッションが transcript で触ったファイルの表示)

Status: Accepted (kawaz が仕様を直接指定)
Date: 2026-07-17
Sponsor: kawaz

## 1. 背景

セッションが Read/Write/Edit で触ったファイルを webui で見たい。cwd (containment root) の外は自由にブラウズさせず、**セッションが実際に触ったファイルのリスト**に限定する (kawaz 明示)。

## 2. 仕様 (kawaz の指定)

- Files ツリーの「お気に入り」「ワークスペース」に続く第 3 セクション **「触ったファイル」** (節構成と並べ方は DR-0026 §4)
- 内容: そのセッションの transcript から Read/Write/Edit (+ NotebookEdit) の tool call file_path を抽出した一覧 (重複除去)。containment root 内のものも含む (§ 3.3)
- クリックでファイルビューアに表示 (root 外の読み出しは「触ったファイルリスト」への containment に相当する認可 — § 3.2。root 内は既存の fs_read)
- **お気に入り追加可能** (★ トグルを同セクションにも)
- **セクション内リストごとの横スクロール**: root 外のファイルはフルパスで幅が溢れるため。
  既存ツリー (深い dir / 長名で右が隠れる既知問題) も同様にセクション単位の横スクロールを付ける

## 3. 設計

### 3.1 抽出 (daemon)

- session_status (DR-0020) の transcript fold に相乗りし、`touched_files` として返す。tool call (Read/Write/Edit/NotebookEdit/MultiEdit) の input.file_path / notebook_path を抽出し、realpath 正規化 (§ 3.2 の `canonicalizeExternalPath`) する
- containment root 内のものは **root 相対** (先頭 `/` 無し。fs_read と Files ツリーが使う綴り)、root 外のものは **絶対パス** で返す。root 自身はツリーの頂点でファイルではないので返さない。webui の既存規約 (相対 = root 内で fs_read、絶対 = それ以外) がそのまま判別に使え、root の綴り (symlink 経由の cwd 等) を webui 側で realpath し直す必要が無い
- 逐次 push は session_status の既存基盤に相乗りできるなら乗る (実装時判断)

### 3.2 読み出し認可 (重要)

fs_read の containment は root 配下限定のまま。root 外のファイルの読み出しは**「そのセッションが触ったと transcript に記録されているパス」の集合に限定**して許可する新しい認可面 (allowlist ベース)。allowlist は `touched_files` の**絶対パスの項目だけ** (`externalReadAllowlist`)。root 内の項目は fs_read で開けるので allowlist に入れない (入れても fs_read で既に読めるものしか増えないが、認可面を必要以上に広げない)。任意パス読み出しには絶対に広げない。symlink escape はrealpath で検査 (既存 fs-access の流儀)。

**正規化は登録側とリクエスト側で同一関数を通す** (`canonicalizeExternalPath`)。allowlist は完全一致集合なので、片側だけ realpath すると同一ファイルの 2 通りの綴り (transcript が記録する `/var/...` と realpath の `/private/var/...`) が互いに一致せず、webui が表示したそのファイルへのリンクが 403 になる。リクエスト時に canonicalize することでfold 後に symlink へ差し替えられた経路は別 realpath に解決されて弾かれる性質は保たれる。

### 3.3 webui

- FileTree に第 3 セクション「触ったファイル」。グループの並びはワークスペース節と同じ (カレントプロジェクト = cwd の folder が先頭、次に各 workspace folder、最後に `others`。DR-0026 §4)。行は folder 内の相対パス (`others` はフルパス) + ★。クリックで FileViewer (root 内は fs_read、root 外は § 3.2 経由)
- **カレントプロジェクトのグループには Read 由来 (`origin: read`) を出さない**。セッションが自分のプロジェクトを読むのは作業の大半で、並べると編集したファイルが埋もれるため。他のグループ (workspace folder・`others`) は Read 由来も出す
- 各グループの見出し行はワークスペース節の folder 行と同じ部品 (キャレット + フォルダアイコン + 名前) と同じインデントで描き、中の行はその folder の子と同じ 1 段下に置く
- **触ったファイル (とお気に入り) の行から選んだ時は、ワークスペース節を動かさない**。行のリンクは `?section=touched` (お気に入りは `?section=favorites`) を付けた URL を指し、その選択では選択中ファイルの祖先の自動展開とスクロール (reveal) をせず、選択状態は選んだセクションの行にだけ付ける。`section` の無い選択 (ワークスペースの行・Timeline のリンク・直接の URL・検索結果) は reveal し、選択状態はワークスペースの行にだけ付ける。同じパスが複数の節で光ると今どの行にいるのか迷うため、光るのは常に 1 つの節
- セクション毎に overflow-x: auto (既存セクションにも適用、スクロールバーは出さない)

## 4. Phase 分割

| Phase | スコープ |
|---|---|
| Phase 1 | daemon: 抽出 + allowlist 読み出し認可 + テスト (敵対: allowlist 外 / symlink) |
| Phase 2 | webui: 触ったファイルセクション + 横スクロール + ★ |

## 4.1 Addendum: `! <cmd>` の persisted-output サイドカー (kawaz TL-Q1 = a, 2026-07-29)

30KB 超の `! <cmd>` 出力を Claude Code が退避するサイドカーファイル (transcriptの隣の `<sid>/tool-results/*.txt`) のパスも allowlist に含める。抽出元はtranscript の `<persisted-output>` スタブ本文の `Full output saved to:` 行。

**信頼形状は § 3.1 の既存エントリと同一**: transcript 自身が名指した絶対パスを1 件だけ、完全一致で付与する (ディレクトリ付与・prefix 付与なし)。読み出し認可は
§ 3.2 の `fs_read_external` をそのまま通り、realpath 再検査も同じ。

スタブ判定は **`<bash-stdout>` の中身全体がスタブであること**を要求する(先頭・末尾 anchor)。巨大でない通常出力はそのまま `<bash-stdout>` に載るため、コマンド出力中に現れた断片で任意パスが allowlist に入らない。全体がスタブになるよう自分で `echo` したユーザは、`! <cmd>` で直接読める範囲を自分に許可しただけで、権限は増えない。

webui は無変更。バッシュカードの「全文を別タブで開く」リンクは元から実在プローブで gate されているため、allowlist 化により自然に点灯する。

## 4.2 Addendum: file 系 attachment と由来別グループ (kawaz)

TL が file 系 attachment (`edited_text_file` / `file`) の本文を Read カード同様にプレビューし、そのパスから Files を開けるようにする。そのため attachment 行が名指す絶対パスも allowlist に加える。

**信頼形状は § 3.1 / § 4.1 と同一**: transcript 自身が名指した絶対パスを 1 件、完全一致で付与する。対象 attachment type と path フィールドは**明示テーブル**
(`ATTACHMENT_PATH_FIELD`) で持つ — 未知 type の path らしき field を総なめすると認可面が中身を見ないまま広がるため。テーブルに無い type は TL には出るが Filesから開けないだけ。

`touched_files` は `{ path, origin }` の配列。`origin` は `read` (Read と § 4.1 のサイドカー) / `edit` (Write / Edit / MultiEdit / NotebookEdit) / `attachment` (file 系 attachment) で、**表示専用** (webui がカレントプロジェクトのグループから `read` を外すのに使う)。認可は origin を見ない。複数の由来が同じパスを名指したら `edit` > `read` > `attachment` の順で 1 つを採る (編集したファイルが読んだことで隠れないため。到着順に依らない)。allowlist を origin ごとのフィールドに割らないのは、消費側が片方の union を忘れると「TL に出るのに Files で 403」になるため。

## 5. 関連

- kawaz (仕様全文)
- DR-0008 (fs_list/fs_read containment) — 認可の基盤
- DR-0020 (session_status fold) — 抽出の相乗り候補
