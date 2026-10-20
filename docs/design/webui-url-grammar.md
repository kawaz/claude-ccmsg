# webui の URL 文法

webui の画面は 1 本の URL で完全に表せる。ブックマーク・リロード・戻る・
リンク共有のどれでも同じ画面になり、「これ見て」で状態ごと渡せる。

URL は 3 つの独立した名前空間でできている。**互いに触らない**のが規約:

| 名前空間 | 何を表すか | 書式 |
|---|---|---|
| **path** | メインペインの中身 (どこを見ているか) | `/r/<room>`、`/s/<sid>/<tab>`、`/usage/…` |
| **ページ固有 query** | その path が持つ引数 | `?path=` `?lines=` `?from=` `?days=` |
| **`sb.` 付き query** | サイドバー由来のフォームパネル | `?sb.panel=` `?sb.template=` `?sb.<PARAM>=` `?sb.search=` |

**hash は使わない** — Timeline のレコードアンカー (`#msg-…`) が既に使っており、アプリの状態表現に重ねると衝突する。**JSON 値も使わない** — 値は素の文字列で、複数行の値も URL エンコード (`%0A`) で足りる。

正本の実装は `packages/webui/src/client/locator.ts` (path + ページ固有 query) と`packages/webui/src/client/sidebar-url.ts` (`sb.*`)。両者は別のパーサで、locator は `sb.*` を見ないし、その逆も同じ。

## path

| path | 画面 |
|---|---|
| `/` | ルーム未選択 |
| `/r/<room>` | ルームのログ (読み取り専用、DR-0036 §2) |
| `/r/<room>/m<mid>` | ルームの特定メッセージへアンカー |
| `/s/<sid>` | セッションの最後に見ていた画面へリダイレクト |
| `/s/<sid>/files` | Files タブ |
| `/s/<sid>/timeline/<position>` | Timeline (`head` または レコード uuid) |
| `/s/<sid>/timeline/agent/tm/<name>` | teammate の TL |
| `/s/<sid>/timeline/agent/sub/<agentId>` | サブエージェントの TL |
| `/s/<sid>/timeline/agent/wf/<runId>/<agentId>` | workflow 内エージェントの TL |
| `/s/<sid>/terminal` · `/status` | 各タブ |
| `/usage` | LLM クオータ |
| `/usage/stats/<period>` | 使用量 (`daily` / `weekly` / `monthly`) |
| `/catalog` | コンポーネントカタログ |

## ページ固有 query

その path だけのもので、他の path へ遷移すれば消える。

| キー | 付く path | 意味 |
|---|---|---|
| `path` | `/s/<sid>/files` | 開いているファイル。セッションの containment root からの相対パスか絶対パス。`~/` 始まりは daemon ユーザの HOME 基準で、開いた時点で相対 / 絶対の形に置き換わる |
| `lines` | `/s/<sid>/files` | 選択行 (`<start>-<end>`) |
| `from` | `/s/<sid>/files` | リンク元ドキュメント (「もしかして」復帰用) |
| `days` | `/usage/stats/<period>` | 集計日数 (単位の既定値と同じなら省略) |

## `sb.*` (サイドバーのフォームパネル)

新規セッション / Session Search の 2 つ。**メインペインの中身を置き換えない**ので path には載せない — `/s/<sid>/timeline` を開いたまま横で使うものであり、「どこを見ているか」とは別の軸になる。逆に言えば「どのセッションを見ながら、どのフォームを何の値で開いているか」が 1 本の URL に収まる。

| キー | 値 | 意味 |
|---|---|---|
| `sb.panel` | `new` / `search` | どのパネルが開いているか (2 つは排他) |
| `sb.template` | テンプレ名 | ランチャーのテンプレを名指しで固定 |
| `sb.<PARAM>` | 任意の文字列 | ランチャー params の初期値。名前は**大文字** |
| `sb.search` | 検索語 | Session Search の検索語 |

規則:

- **`sb.panel` が無ければ他の `sb.*` は一切見ない**。閉じたパネルの値だけがURL に残る状態を作らない。未知の `sb.panel` 値も「閉じている」扱い。
- **予約キーは小文字** (`panel` / `template` / `search`)、**params は大文字**。
  この形の違いだけで 2 つの名前空間が衝突なく同居する。
- **`sb.template` を省くと、載っている params から recipe を選ぶ**:
  `RESUME_AT` があれば fork 用、`SESSION_ID` だけなら resume 用、どちらも無ければ通常起動用。アプリ内のボタンはどれも `sb.template` を書かない — config が recipe を何と呼んでいるかを呼び出し元は知らないため。名指しはブックマークや手打ちのためのもので、存在しない名前は無視される。
- **テンプレが宣言していない `sb.<PARAM>` は採用されない**。見えない入力が起動内容を決めない。
- **path 遷移では `sb.*` が引き継がれる**。検索結果を選んで Timeline へ移ってもパネルは開いたまま (DR-0021)。閉じる側は明示的に指定する。
- **パネルの開閉自体が遷移** (push)。戻るで閉じられる。

例:

```
/s/<sid>/timeline/head?sb.panel=new&sb.SESSION_ID=<sid>&sb.RESUME_AT=<uuid>
  Timeline を見ながら、そのセッションのその地点から fork するフォームを開く

/r/<room>?sb.panel=search&sb.search=deploy
  ルームを見ながら "deploy" で過去セッションを検索

/s/<sid>/files?path=src/a.ts&sb.panel=search
  ファイルを見ながら過去セッションを検索する (2 つの query は互いに無関係)
```

### URL に載せないもの

「貼って共有する意味があるか」で決まる。載せないのは、その画面を**見る人ごとに違ってよい**もの:

- フォームに入力中の値 (`sb.*` は開いた時の初期値であって、以後の打鍵はフォーム自身のもの。打鍵ごとに履歴を積まない)。Session Search だけは検索を**実行した**時に `sb.search` を replace で書き戻す — 実行した検索は共有する意味があり、そこに至る途中の文字列には無い
- SESSIONS の並び順 (`state.peerSortKey`、localStorage に永続)
- ペイン幅、fold の開閉、サイドバーの在り / 無し (どのフォームが開いているかは `sb.panel` が持つが、それを収めるサイドバーが出ているかは持たない —画面共有のために消した状態はその窓限りのもので、貼って共有する意味がない)。
  サイドバーと本文が横に並びきらない幅では消す操作自体が無く、代わりに「今どちらを見ているか」になるが、これも同じ理由で URL には載せない(開いた直後にどちらを見せるかは `path` が対象を名指しているかで決まるので、リンクを貼れば相手も同じ側から始まる)
