# DR-0021: Session Search (ccmsg 未起動の過去セッションのブラウズ)

Status: Accepted (SS-Q1=a / SS-Q2=a、kawaz 2026-07-16。検索クエリの AND/OR 割当は DR-0022 §2.1 と共通で kawaz 指定が正本。§2.1 の since / until / timeout と大文字小文字の既定、§2.2 の読む範囲、§2.3 の探した範囲の文、§3.1 の検索を止める決まりは kawaz 2026-11-24)
Date: 2026-07-16
Sponsor: kawaz

## 1. 背景

webui は ccmsg 接続中セッション + `claude agents --json` 検出分しか見えない。過去セッション(ccmsg 未起動・終了済み) の transcript を探して読む手段が webui に無い。daemon は`~/.claude*/projects/**/*.jsonl` に到達できるので、daemon 仲介だけで検索・閲覧が可能なはず(kawaz)。

## 2. スコープ (kawaz の要件を転記)

### 2.1 検索フォーム (SESSIONS に search 導線)

| 項目 | 仕様 |
|---|---|
| 検索クエリ | 通常検索は行内の空白区切りワードを AND、改行区切りを OR。AND は セッション全体で判定 (別メッセージが別ワードを満たしてよい)。ダブルクオート句は 1 ワード化し、句内空白は `\s+` マッチ。regex 検索は 1 行 1 パターン、改行区切り OR |
| 大文字小文字 | 既定は区別する。区別しない側へのトグルを持つ |
| 検索対象トグル | ユーザメッセージ / エージェントメッセージ (それぞれ ccmsg 経由含む) |
| セッション cwd | スペース区切り複数ワード部分一致 AND |
| SESSION ID | uuid 部分一致可 |
| 対象 claude_config_dir | 複数設定がある場合のみ表示、トグル |
| since | どこまで遡るか。`<数>[mhd]`、既定 5d (wire の `mtime_within`) |
| until | どこから遡り始めるか。since と同じ書式、既定 0 (今)。`0` と空は今 (wire の `mtime_until`、省くと今) |
| timeout | 読む時間 (ms)。既定 3000。1000〜15000 に収める。範囲の外や数でない入力はエラーにせず、収めた値 (数でなければ既定) で検索し、欄の値を直して見せる (wire の `timeout_ms`、daemon も同じく収める) |

### 2.2 検索ロジック (kawaz 指定の 3 段)

1. sid / cwd / mtime で jsonl ファイルリストを絞る (メタデータ段)
2. jsonl をクエリワードで grep 的に行フィルタ (プリフィルタ段)
3. 対象フィールド厳密 parse で更にフィルタ (strict 段)

(DR-0020 session_status と同じ grep→parse→strict パターン)

#### 読む範囲 (kawaz 2026-11-24)

メタデータ段は until より新しいファイルも、開く前に更新時刻で外す。残った候補を更新時刻の新しい順に読み、次のどれかで止める:

- 全部読んだ
- timeout が過ぎた。読みかけのファイルは最後まで読み、次のファイルを開かない (止まるのはファイルの境目)
- 当たったセッションが `SESSION_SEARCH_RESULT_MAX` (50) 件に達した。`。` のような語は全部に当たるので、件数の上限は残す

1 回で読む量の上限は持たない。量で止めると、期間を広げても古い方に届かず、どこまで探したかも言えない。範囲は人が since / until で、かける時間は timeout で決める。

応答は当たりに加えて、どこまで探したかを返す: 候補のファイルの数 (`files_total`)、読み終えた数 (`files_searched`)、読み終えた中で一番古いファイルの更新時刻 (`oldest_searched_mtime`)、止まった理由 (`ended_by`: `all` / `timeout` / `hit_limit`)。until が since より古いか同じ (範囲が空) 要求は、読まずに `invalid_args` で断る。

続きを取る仕組みは持たない。先を探すなら、人が until を動かすか timeout を伸ばして検索し直す。

### 2.3 検索結果リスト

各行: リポ / wt・ws / SID / 作成日 / 更新日 / サイズ (ファイルサイズ) / 検索マッチテキストのサマリ (ユーザ・エージェントメッセージの区別がつく形) をブロックにしてリスト表示。

結果の下に、どこまで探したかを 1 行で出す:

| 止まった理由 | 文 |
|---|---|
| 全部読んだ | `182 ファイルを全部探した` |
| timeout | `候補 182 ファイルのうち 84 ファイル、13 日前まで探した結果` |
| 50 件 | `新しい順に 50 件。候補 182 ファイルのうち 84 ファイル、13 日前まで探した結果` |

「N 日前」は読み終えた一番古いファイルの更新時刻から。1 日未満は時間、1 時間未満は分で言う。

### 2.4 選択 → セッションのブックマーク

語: この節の「ブックマーク」はセッション単位のもの (SESSIONS の Bookmarks、セッションのヘッダと検索結果の ☆⭐)。TL の項目のブックマーク ([DR-0058](./DR-0058-timeline-bookmarks.md)) とは別物で、名前の分け方は [DR-0043](./DR-0043-sidebar-folds-and-globals.md) §11

- クリックでそのセッションを選択 → **SESSIONS の Bookmarks**に保存・マーキング
- ブックマークの identity はセッションの **作業ディレクトリ (`cwd`)** (kawaz 2026-10-02)。同じディレクトリで動くセッションは基本 1 つで、世代交代すると新しい sid が同じディレクトリで動き出すため、ブックマークはディレクトリに付ける (新セッションで付け直さずに済む)。repo 単位 (`repo_root`) には束ねない — 同じ repo でも worktree / workspace ごとに役割が違うため
- key は接続中 peer の `PeerInfo.cwd` と検索結果の `SessionSearchHit.cwd` の文字列そのもの (両者は同じ「セッションの作業ディレクトリ」を指すので導出なしで揃う)。`cwd` が null の検索結果 (jsonl から復元できなかった) はブックマークできない (☆ を出さない)
- Files ツリーのお気に入りも同じ `cwd` を key にする (同じ理由で worktree ごとに分ける)
- 表示規則: ブックマークしたディレクトリに接続中 peer が 1 つ以上あれば、その全員をそのブックマークの下に列挙する (世代交代中の旧・新セッションをどちらも落とさない)。0 ならブックマークした時に凍結した検索ヒットを表示する
- SESSIONS サイドバーに表示され、Files (パスが現存するなら) / TL 等が閲覧可能
- ccmsg 接続なしで daemon 仲介のみで動く (transcript_read は path ベースで拡張が要る —現行は hello 済みセッションの announce した path しか読めない、§ 3 設計判断)

## 3. 設計判断 (SS-Q1=a / SS-Q2=a 裁定済み)

### 3.1 daemon 側: 新 op 群

- `session_search`: § 2.1 のパラメータ → § 2.2 の 3 段 → § 2.3 の行データを返す。クエリ parser は protocol package の直列化可能な AND/OR 正規表現構造を webui と共有する
- 過去セッションの transcript / files 閲覧 (**SS-Q1=a**): daemon が jsonl から cwd を復元し「仮想 session」として既存 transcript_read / fs_list / fs_read を path ベースで拡張。
  認可は user role のみ (webui 経由限定)
- 走査範囲は daemon が既に agents poll で検出している config_dir 群の projects/ 配下に限定
- 同じ接続から次の `session_search` が来たら、その接続で走っている検索を止め、`search_superseded` で答える (kawaz 2026-11-24)。前の検索の答えはもう待たれていない。接続が切れた時も止める。1 つの session id 丸ごと (UUID) で引く検索 (終了済みのセッションを開いた時の `SessionView` の引き。1 ファイルで一瞬) は止める・止められるの対象にしない。Session Search のパネルと同じ接続を使うので、対象にするとパネルの検索を止めてしまう。違う接続の検索は互いに止めない

### 3.2 セッションのブックマークの保存先 (**SS-Q2=a**)

webui localStorage。daemon 側の永続化はしない。

- key `ccmsg.sessionBookmarks`、値は `{ v: 1, bookmarks: [...] }`。ブックマークはブックマークした時に凍結した記録で、形は webui が自分のスキーマ (`SessionBookmarkSchema`: sid、cwd、repo、ws、title、transcript の file、updated_at、model / effort) で持ち、protocol の `SessionSearchHit` とは切り離す。protocol が検索結果に field を足しても保存済みのブックマークは読める ([DR-0038](./DR-0038-json-is-parsed-by-schema.md) §3)
- 読み込みは保存されうる形の union で読む: 今の `{ v: 1, bookmarks }` と、`SessionSearchHit` をそのまま並べた配列 (ブックマークに要る field だけを取り、`cwd` が null の記録はブックマークにならない)。どの形でも読めない値は丸ごと読まず (ブックマークなし)、読めなかったことと理由を console に出す。読んだブックマークは `cwd` で索引し、同じ `cwd` の記録が複数あれば `updated_at` が最新のものを採る
- 凍結した記録の repo/ws・title は、その sid のセッションが接続中・稼働中の間 live 側の値で補修する

## 4. Phase 分割

| Phase | スコープ |
|---|---|
| Phase 0 | 本 DR + 裁定 |
| Phase 1 | daemon: session_search op (3 段検索) + 過去セッション transcript 読み出しの拡張 |
| Phase 2 | webui: 検索フォーム + 結果リスト |
| Phase 3 | webui: セッションのブックマーク (サイドバー統合、Files/TL 閲覧) |

## 5. 関連

- kawaz (要件全文)
- DR-0009 (transcript access) — 読み出し経路の拡張元
- DR-0020 (session status) — grep→parse→strict の前例
