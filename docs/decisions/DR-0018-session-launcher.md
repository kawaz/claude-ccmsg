# DR-0018: Session Launcher (webui からの新規セッション起動 UI)

Status: Accepted (LN-Q1..4 裁定 2026-07-16)
Date: 2026-07-15
Sponsor: kawaz r17 mid=66+69

## 1. 背景

webui は既存セッションの transcript / files / rooms を見る箱として設計されてきたが、**新規セッションを立ち上げる操作**は CLI (ターミナル) から `claude` コマンドを叩く形しかない。kawaz が普段 hyoui 経由で backgroind claude を大量に起動する運用をしている中で、model / effort / cwd / プロンプトを毎回タイプする手数がボトルネックになっている。

webui 側から「サイドバー SESSIONS 付近の『新規』ボタン → 設定 view → 実行」の 1 経路でこれを完結させる。

## 2. スコープ

### 2.1 やること

- **サイドバー**に「新規」ボタン (SESSIONS 見出し付近)
- クリック → **セッション設定ビュー** (新規 view 種別 `session-creator`)
- ビュー内の設定項目:
  - **cwd**: クリック → ディレクトリツリー展開 → 選択
  - **model**: dropdown (`sonnet` / `opus` / `fable` / `gpt-5.6-luna` / `gpt-5.6-terra` / `gpt-5.6-sol`)、デフォルト `fable`
  - **effort**: dropdown (`low` / `middle` / `high` / `xhigh`)、デフォルト `middle`
  - **プロンプト**: multiline 入力欄 + 「default」ボタン (押すと設定ファイルの default 文字列に戻す)
- **実行ボタン**: 押したら
  1. 設定ファイルの **コマンドテンプレ**に値を embed
  2. daemon 経由で **exec 実行** (webui は fetch で結果を待つ)
  3. **stdout / stderr / exit code** を結果パネルに表示、それだけ
- **timeout 10 秒**、フォアグラウンドですぐ返ってこなければ `SIGTERM` → 待って `SIGKILL` (kill x2)、それ以上は追わない (mid=69 明示)

### 2.2 cwd ディレクトリツリー UI

- **ルートリスト**: 設定ファイルから複数指定。kawaz 環境の初期値例:
  ```
  ~/.local/share/repos/github.com/kawaz/
  ~/.local/share/repos/github.com/zunsystem/
  ~/.local/share/repos/github.com/emeradaco/
  ~/.local/share/repos/github.com/syun/
  ~/.local/share/repos/github.com/tfabworks/
  ```
- 各ルート配下を展開 → リポジトリ (dir) → その配下の worktree/workspace (dir) を選択
- **ディレクトリのみ表示** (ドットファイル/ファイル非表示)
- 上部に **検索フィルタ欄** (パス名部分一致、`find` 深さ 2 まで)

### 2.3 やらないこと (明示除外)

- **プロセス管理はしない** (kawaz r17 mid=69: 「プロセス管理したがりがちなのを抑制するため『深追いしない』と言った」)
  - 起動後の pid tracking / stdin 送信 / SIGCHLD 監視 / progress 表示 / 自動再起動、いずれも不要
  - 実行 → 結果 (stdout/stderr/exit) 表示 → 終わり
- 実行結果セッションの subscribe 追従 (もし新セッションが hello → daemon に連絡してくれば peers に自動で載る、それだけ)
- ルートリストの UI 編集 (設定ファイル手編集で足りる)
- コマンドテンプレの UI 編集 (同上)

## 3. 設計

### 3.1 設定ファイル

**LN-Q1 裁定 (kawaz 2026-07-16, r26 mid=4) = 既存 daemon config に統合**:

```yaml
session_launcher:
  root_dirs:
    - ~/.local/share/repos/github.com/kawaz/
    - ~/.local/share/repos/github.com/emeradaco/
    # ...
  default_prompt: |
    ccmsg subscribe起動。このセッションではultracode許可。pre-clear出力があればロード
  # 環境変数 CWD / MODEL / EFFORT / PROMPT がセットされた状態で shell が実行する
  # (LN-Q2 裁定: template への文字列置換ではなく env 渡し)
  shell: bash          # "bash" | "zsh" (組み込み 2 択、bash = `bash -eu -o pipefail -c`)
  command: >
    direnv exec "$CWD" hyoui run --dettach --
    claude --model "$MODEL" --effort "$EFFORT"
    --name "${$(bump-semver vcs get repository):t1}@$(bump-semver vcs get worktree-name) $(date +%Y%m%dT%H%M)"
    "$PROMPT"
  timeout_seconds: 10
  dir_tree_depth: 2    # LN-Q3 裁定: 初期ロード深さ (default 2)、config で可変
```

- **変数渡し (LN-Q2 裁定 = 環境変数)**: daemon は文字列置換を一切しない。`CWD` / `MODEL` /
  `EFFORT` / `PROMPT` の 4 つの環境変数をセットして shell を起動し、command はそのまま
  `-c` に渡す。クオート安全性 (`"$CMD"` 等) は config を書く kawaz の責務 —
  injection 面が「env 参照を quote するかどうか」に閉じ、`$(date ...)` 等の shell 展開も
  自然に使える
- **shell は暗黙にしない (LN-Q2 裁定)**: `sh -c` 暗黙起動ではなく、config の `shell` キーで
  `bash` / `zsh` の組み込み 2 択から明示選択。bash は `bash -eu -o pipefail -c "$COMMAND"`
  相当、zsh は等価のエラー厳格オプションで起動 (bash/zsh は好みが分かれるため両対応)
- **timeout_seconds**: 実行の grace period。以降は SIGTERM → 少し待って SIGKILL

### 3.2 protocol (新 op)

新 request/response 型を `packages/protocol/src/index.ts` に追加:

- **`dir_tree` op** — cwd ツリー描画用 (read-only、既存 `fs_list` の subset でドット除外を daemon 側で処理)
  - request: `{op: "dir_tree", roots: string[], depth?: number, filter?: string}` (roots は config の root_dirs **配下**であるか検証 — LN-Q3 裁定によりノード展開時の追加 fetch でも使うため、root_dirs との完全一致ではなく containment 検査)
  - response: `{entries: {path: string, is_dir: boolean, children?: [...]}[]}` (recursive)
  - **depth (LN-Q3 裁定 = a+b ハイブリッド)**: 初期ロードは config `dir_tree_depth`
    (default 2) の一括 fetch。depth 境界より深いノードは展開時に lazy fetch で 1 段ずつ
    追加 (深いリポ構成の奥をルートに起動する用途に対応)。「一括 vs lazy」は排他ではなく
    初期一括 + 境界以深 lazy の複合
- **`session_launch` op** — コマンド組み立て + exec
  - request: `{op: "session_launch", cwd: string, model: string, effort: string, prompt: string}`
  - response: `{ok: boolean, stdout: string, stderr: string, exit_code: number | null, timed_out: boolean}`
  - `null` exit_code は SIGTERM/SIGKILL で終了させた場合

**セキュリティ**: `dir_tree` は root_dirs 配下に限定、`session_launch` は config で固定された template のみが起動する経路。

**Addendum 2026-07-17 (kawaz 裁定)**: 上の「config で固定された template のみ」の記述は **user role からの override を許容する形に緩和**する。`SessionLaunchRequest` に optional `command` を追加し、user role (= webui は本人 kawaz のみ) は request 単位で shell command template を上書きできる (空文字は `invalid_args`)。理由: user role の webui 操作は kawaz 本人がターミナルで `claude` を打つのと権限的に等価であり、コマンドテンプレの override は本人が別のコマンドを叩くのと同じ表現力しか与えない。**session role からの `session_launch` 呼び出しは従来通り `bad_request` で拒否** — user role gate は `server.ts` で `command` フィールドを見る前に確定するため、override が session role に露出することはない。SessionLauncherConfigResponse に `command` (生 template) を追加し、SessionCreator の textarea 初期表示に使う (詳細は `docs/issue/2026-07-17-session-creator-command-preview.md`)。

### 3.3 daemon 実装

- config 読み込み: 起動時 (既存 config path に統合)
- `dir_tree`: `readdir` を深さ制限 + dot-filter で walking
- `session_launch` (LN-Q2 裁定反映):
  1. env に `CWD` / `MODEL` / `EFFORT` / `PROMPT` をセット (daemon は文字列置換しない)
  2. config の shell に応じて `Bun.spawn(["bash", "-eu", "-o", "pipefail", "-c", config.command], {env})`
     または zsh 等価で起動
  3. `timeout_seconds` の setTimeout で SIGTERM 送信
  4. さらに 500ms 待って exited でなければ SIGKILL
  5. stdout/stderr 収集 → response

### 3.4 webui 実装

- **state.view enum** に `"session-creator"` を追加
- **`components/Sidebar.tsx`**: SESSIONS 見出しの右に「+ 新規」ボタン、クリックで `state.view = "session-creator"` へ dispatch
- **新規コンポーネント** `components/SessionCreator.tsx`:
  - フォーム (dropdown / textarea / dir tree trigger)
  - 「default」ボタン → prompt を config.default_prompt に戻す
  - 「実行」ボタン → session_launch op、結果を下に表示
- **新規コンポーネント** `components/CwdTree.tsx`:
  - dir_tree op で fetch、展開状態 local state
  - 検索フィルタ欄 (input) → depth 2 相当を daemon 側で filter (config の root_dirs 内から)
- **`app.css`**: SessionCreator + CwdTree の style

## 4. Phase 分割

| Phase | スコープ | 担当 (予定) |
|---|---|---|
| **Phase 0** | 本 DR + 裁定項目 (`docs/QUESTIONS.md` の LN-Q1..4) | 完了 (このコミット) |
| **Phase 1** | 設定ファイル読込 + protocol 型定義 + daemon 側 op 骨組 (dir_tree / session_launch、まだ template exec 実装なし = mock) | 1 workflow (fable プラン → codex-sol 実装 → fable レビュー) |
| **Phase 2** | daemon 側 exec 実装 (timeout/kill/stdout capture) + protocol テスト | 1 workflow |
| **Phase 3** | webui 側 SessionCreator フォーム + Sidebar 「新規」ボタン + state.view 拡張 | 1 workflow |
| **Phase 4** | webui 側 CwdTree UI (ディレクトリツリー + 検索フィルタ) + 結合 | 1 workflow |

各 Phase は kawaz 裁定の後に順次実装。Phase 間の依存: 1 → 2 → 3 → 4 (protocol 型が固まらないと daemon 実装が組めない、daemon がないと webui のフォームが叩けない)。

## 5. 裁定記録 (kawaz 2026-07-16, r26 mid=4)

- **LN-Q1 = (a)** 既存 daemon config に統合
- **LN-Q2 = 環境変数渡し** (`CWD`/`MODEL`/`EFFORT`/`PROMPT`)。shell は暗黙にせず config の
  `shell: bash | zsh` で組み込み 2 択から明示選択 (bash = `-eu -o pipefail -c`)。quote は
  config 筆者責務、`$(date)` 等の shell 展開も可 — § 3.1 / 3.3 に反映済み
- **LN-Q3 = (a)+(b) ハイブリッド** 初期一括 depth は config `dir_tree_depth` (default 2)、
  境界以深はノード展開時に lazy fetch — § 3.2 に反映済み
- **LN-Q4 = (a)** config 変更は daemon 再起動で反映

## 6. 関連

- kawaz r17 mid=66 (要件全文)、mid=67 (Phase 分割提案 = 本 DR)、mid=69 (深追いしない = プロセス管理抑制 + timeout 10s + kill x2)
- [DR-0008](./DR-0008-workspace-file-access.md) — fs_list op (dir_tree は subset として整合)
- [DR-0009](./DR-0009-session-transcript-access.md) — 新セッションが起動後 hello → daemon → webui peers に自動掲載される既存経路
