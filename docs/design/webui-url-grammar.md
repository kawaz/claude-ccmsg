# webui の URL 文法

webui の画面は 1 本の URL で完全に表せる。ブックマーク・リロード・戻る・
リンク共有のどれでも同じ画面になり、「これ見て」で状態ごと渡せる。

URL は 3 つの独立した名前空間でできている。**互いに触らない**のが規約:

| 名前空間 | 何を表すか | 書式 |
|---|---|---|
| **path** | メインペインの中身 (どこを見ているか) | `/r/<room>`、`/s/<sid>/<tab>`、`/usage/…` |
| **ページ固有 query** | その path が持つ引数 | `?path=` `?lines=` `?from=` `?days=` |
| **`sb.` 付き query** | サイドバー由来のフォームパネル | `?sb.panel=` `?sb.<field>=` `?sb.search=` |

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
| `sb.<field>` | 任意の文字列 | 新規セッションのフォームの欄の初期値。名前は起動の入力 (DR-0018 §3.2) の field 名: `cwd` / `model` / `effort` / `continue` / `resume` / `resume_session_at` / `fork_session` / `name` / `prompt` |
| `sb.search` | 検索語 | Session Search の検索語 |

規則:

- **`sb.panel` が無ければ他の `sb.*` は一切見ない**。閉じたパネルの値だけがURL に残る状態を作らない。未知の `sb.panel` 値も「閉じている」扱い。
- **`sb.<field>` は上の 9 つの名前だけを読む**。それ以外の名前は見えない入力として紛れ込まないよう捨てる。
- **値の無いオプション (`sb.continue` / `sb.fork_session`) は `true` の時だけ on**。それ以外の値は off で開く。
- **`sb.model` / `sb.effort` が選択肢に無い値なら、既定の値で開く** (select がその値を出せないため。新規なら `fable` とその model の既定の effort、`--continue` か `--resume` があれば「指定しない」)。他の欄は値をそのまま入れ、読めるかどうかは送る時にスキーマが判定する。
- **アプリ内の導線は知っている値を全部リンクに載せる** (Session Search の「resume」、Timeline の「ここから fork」)。リンクだけで同じフォームが開く — 貼っても、元のセッションが切れた後に開き直しても。
- **path 遷移では `sb.*` が引き継がれる**。検索結果を選んで Timeline へ移ってもパネルは開いたまま (DR-0021)。閉じる側は明示的に指定する。
- **パネルの開閉自体が遷移** (push)。戻るで閉じられる。

例:

```
/s/<sid>/timeline/head?sb.panel=new&sb.cwd=<dir>&sb.resume=<sid>&sb.resume_session_at=<uuid>&sb.fork_session=true
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
