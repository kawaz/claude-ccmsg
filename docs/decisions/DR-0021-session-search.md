# DR-0021: Session Search (ccmsg 未起動の過去セッションのブラウズ)

Status: Accepted (SS-Q1=a / SS-Q2=a、kawaz 2026-07-16 r26 mid=48)
Date: 2026-07-16
Sponsor: kawaz r26 mid=47

## 1. 背景

webui は ccmsg 接続中セッション + `claude agents --json` 検出分しか見えない。過去セッション
(ccmsg 未起動・終了済み) の transcript を探して読む手段が webui に無い。daemon は
`~/.claude*/projects/**/*.jsonl` に到達できるので、daemon 仲介だけで検索・閲覧が可能なはず
(kawaz)。

## 2. スコープ (kawaz mid=47 の要件を転記)

### 2.1 検索フォーム (SESSIONS に search 導線)

| 項目 | 仕様 |
|---|---|
| 検索クエリ | 通常検索は行内の空白区切りワードを OR、改行区切りを AND。ダブルクオート句は 1 ワード化し、句内空白は `\s+` マッチ。regex 検索は 1 行 1 パターン、改行区切り AND |
| 検索対象トグル | ユーザメッセージ / エージェントメッセージ (それぞれ ccmsg 経由含む) |
| セッション cwd | スペース区切り複数ワード部分一致 AND |
| SESSION ID | uuid 部分一致可 |
| 対象 claude_config_dir | 複数設定がある場合のみ表示、トグル |
| mtime | デフォルト 5d |

### 2.2 検索ロジック (kawaz 指定の 3 段)

1. sid / cwd / mtime で jsonl ファイルリストを絞る (メタデータ段)
2. jsonl をクエリワードで grep 的に行フィルタ (プリフィルタ段)
3. 対象フィールド厳密 parse で更にフィルタ (strict 段)

(DR-0020 session_status と同じ grep→parse→strict パターン)

### 2.3 検索結果リスト

各行: リポ / wt・ws / SID / 作成日 / 更新日 / サイズ (ファイルサイズ) /
検索マッチテキストのサマリ (ユーザ・エージェントメッセージの区別がつく形) をブロックにして
リスト表示。

### 2.4 選択 → pinned session

- クリックでそのセッションを選択 → **pinned SESSIONS リスト**に保存・マーキング
- SESSIONS サイドバーに表示され、Files (パスが現存するなら) / TL 等が閲覧可能
- ccmsg 接続なしで daemon 仲介のみで動く (transcript_read は path ベースで拡張が要る —
  現行は hello 済みセッションの announce した path しか読めない、§ 3 設計判断)

## 3. 設計判断 (SS-Q1=a / SS-Q2=a 裁定済み)

### 3.1 daemon 側: 新 op 群

- `session_search`: § 2.1 のパラメータ → § 2.2 の 3 段 → § 2.3 の行データを返す。クエリ parser は protocol package の直列化可能な AND/OR 正規表現構造を webui と共有する
- 過去セッションの transcript / files 閲覧 (**SS-Q1=a**): daemon が jsonl から cwd を復元し
  「仮想 session」として既存 transcript_read / fs_list / fs_read を path ベースで拡張。
  認可は user role のみ (webui 経由限定)
- 走査範囲は daemon が既に agents poll で検出している config_dir 群の projects/ 配下に限定

### 3.2 pinned list の保存先 (**SS-Q2=a**)

webui localStorage。daemon 側の永続化はしない。

## 4. Phase 分割

| Phase | スコープ |
|---|---|
| Phase 0 | 本 DR + 裁定 |
| Phase 1 | daemon: session_search op (3 段検索) + 過去セッション transcript 読み出しの拡張 |
| Phase 2 | webui: 検索フォーム + 結果リスト |
| Phase 3 | webui: pinned sessions (サイドバー統合、Files/TL 閲覧) |

## 5. 関連

- kawaz r26 mid=47 (要件全文)
- DR-0009 (transcript access) — 読み出し経路の拡張元
- DR-0020 (session status) — grep→parse→strict の前例
