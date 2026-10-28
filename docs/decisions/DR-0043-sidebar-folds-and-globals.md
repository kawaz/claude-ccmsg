# DR-0043: サイドバーを開閉できる区画 (SESSIONS / ROOMS / GLOBALS) の列にし、GLOBALS に繋ぎ先の切り替え・版・Claude Code の更新を置く

- Status: Proposed
- Date: 2026-10-28

## Context

webui の画面全体に効く情報と操作の置き場が無い。スマホではグローバルヘッダに足す余地が無く、daemon の版はセッションごとの Status タブの最下部に置かれている。セッションに属さない情報が、セッションを開かないと見えない場所にある。

もう 1 つの要求は端末ごとの繋ぎ先の切り替え。iPhone / iPad は IPv6 だけの名前 (`ccmsg.v6-sandbox.kawaz.jp`) で繋ぎ、Mac は従来の IPv4 の名前で繋ぐ運用をしている ([runbook device-access-path](../runbooks/device-access-path.md))。エージェントが書くリンク (`ccmsg_url`) は IPv4 側の名前なので、iPhone でリンクを開くと IPv4 の経路に戻り、そこから v6 の名前へ移る口が webui に無い。

### 読んで分かった前提 (既存コード)

- サイドバーは `Sidebar.tsx` の `#sidebar-lists` に `#sessions-panel` (`<h2>` に Sessions の文字と、+New・🔍・並び順・↻ のボタンが入る) と `#rooms-panel` が縦に並び、`#sidebar-lists` 全体が 1 つの縦スクロールを持つ (app.css の `#sidebar-lists, #sidebar-form` の規則)
- ROOMS は既に閉じた状態で始まる `Fold` (`<details>`) で、開いた時に room の一覧を取る (`RoomList.tsx`)。`Fold.tsx` はこの UI の開閉部品の共通形で、`<details>` / `<summary>` をブラウザに任せる。SessionList の中の Pinned 等の区分 (`groupSessionsBySection`、`.session-section`) も `Fold`
- Status タブに出ている版は最下部の `daemon v<version>` の 1 行だけ (`StatusPanel.tsx` の `.status-daemon-version`)。値は webui が接続のたびに送る `ping` の返事の `version` (`ws.ts` の handshake の最後、store の `daemonInfo`)
- Claude Code の版は、セッションごとのプロセスの版 (agents の行の optional の `version`、[DR-0020](./DR-0020-session-status-tab.md) Addendum 2026-10-25) が TL 下ミニパネルの ctx 行の末尾に `claude v<version>` で出るだけ (`utils.ts` の `sessionProcessParts`)。Status タブには無い。agents の行はプロセスの起動の時刻 `startedAt` も持つ
- この Mac の `claude` は native installer の形 (`~/.local/bin/claude` が `~/.local/share/claude/versions/<version>` への symlink、binary は 264 MB)。`claude --version` は `2.1.312 (Claude Code)` の 1 行を出す (2026-10-28 観測)
- `webui_url` は hello ではなく `ping` の返事に載る (`response-host.ts` の `PingResponseSchema`)。daemon の `webuiUrlOf` (`http.ts`) が、`CCMSG_HTTP_ALLOW_ORIGIN` → tailscale serve の自動許可 → `allowed-origins.json` (`ccmsg origins add`) の順に並べた Origin のうち、正しい origin の形で、http(s) で、host が loopback でない最初の 1 つを返す。hooks module はこれを `ccmsg status` で読み、最初の turn の前の案内の `ccmsg_url: <url>` に使う ([DR-0039](./DR-0039-all-mods-and-typed-tools.md) §5)
- env の Origin と tailscale の自動許可は同じ `Set` (`httpAllowOrigin`) に入り、tailscale の分は起動の後に非同期で足される。file の Origin は mtime で読み直される (`origins-file.ts`)
- セッションへの操作 (終了・再起動) は Status タブの危険ゾーンに置く ([DR-0028](./DR-0028-session-kill.md))。本 DR の GLOBALS はセッションに属さないもの (daemon、このホストの Claude Code、webui を開いている origin) だけを持ち、セッションの操作はそちらのまま

## Decision

### 1. サイドバーは開閉できる区画の列にする (kawaz 裁定)

- サイドバーの一覧の段を、開閉できる区画の列にする。区画は SESSIONS・ROOMS・GLOBALS の 3 つ
- 区画は見出しと本体からなる。見出しは 1 行の高さ、本体は開いている時だけ出す。見出しを押すと開閉が入れ替わる
- 区画はそれぞれ独立に開閉でき、同時に複数開いてよい (1 つ開くと他が閉じる排他にしない)
- 初期表示は一番上の SESSIONS だけ開き、ROOMS と GLOBALS は閉じる。ROOMS の「開いた時に一覧を取る」振る舞いはそのまま区画の開く操作に付く
- グローバルヘッダには何も足さない (スマホで狭い)

### 2. 見出しのボタンは開閉を動かさない (構造で保証する、kawaz 裁定)

- SESSIONS の見出しには +New (hello の `launch_available` の時)・🔍・並び順・↻ を置く。これらを押しても区画は開閉しない
- これを構造で保証する: 見出しの中で、開閉を担う要素とボタン群を兄弟にし、ボタン群を開閉の要素の子孫にしない。ボタンの click は開閉の要素に届かないので、`stopPropagation` で止める必要が無い。入れ子の button (対話要素の中の対話要素) を作らない
- 開閉の要素は見出しのうちボタン群を除いた全幅を占め、見出しのどこを押しても (ボタンの上以外は) 開閉する
- 区画の名前は見出し (`h2`) として残し、支援技術で見出しをたどれるようにする

### 3. 上に付く区画と下に付く区画はサイドバーのレイアウトで決める (kawaz 裁定)

- 「上に付く / 下に付く」は区画の部品の prop にせず、サイドバーの CSS で決める。一覧の段を `display: flex; flex-direction: column` にし、SESSIONS と ROOMS は上から並び、GLOBALS は `margin-top: auto` で下端に付く
- 開いている区画の本体が、見出しの残りの高さを分け合う。本体はそれぞれ自分の縦スクロールを持つ (`min-height: 0` + `overflow-y: auto`)。段全体の 1 本のスクロールにはしない (長い SESSIONS が GLOBALS を画面の外へ押し出さないため)
- [提案] 高さを分け合うのは一覧の区画 (SESSIONS・ROOMS) だけにし、GLOBALS の本体は中身の高さだけを取る。GLOBALS の中身は 3 行程度で伸びる必要が無く、分け合うと一覧の行が減るだけになる。これもサイドバーの CSS で区画の id を名指して決め、部品の prop にはしない

### 4. GLOBALS に置くもの (kawaz 裁定)

#### 4.1 繋ぎ先 (endpoint) の表示と切り替え

- `endpoint: [ccmsg.v6-sandbox.kawaz.jp ▾]` の 1 行。今このページを開いている origin を表示し、選ぶと別の名前の origin へ移る
- 候補は §5 の一覧。今の origin が候補に無い時 (daemon の bind を直接開いた loopback 等) も、今の origin を選択中の項目として出す
- [提案] 部品は素の `<select>`。スマホでは OS の選択 UI が出る。表示は host (`URL.host`)、`https:` 以外の候補だけ scheme を添える。今の origin のほかに候補が無ければ、選ぶ部品にせず文字だけを出す
- 切り替えは、今の URL の origin だけを選んだ候補に差し替えて普通に遷移する (`location.assign`)。path はそのまま (kawaz 裁定)。[提案] query と hash もそのまま運ぶ: URL が画面の状態の正本なので ([webui-url-grammar](../design/webui-url-grammar.md)、`sb.*` のサイドバーのフォームを含む)、運べば移った先でも同じ画面になる。履歴に 1 つ積まれるので、戻るで元の origin に戻れる
- origin ごとの localStorage / sessionStorage (下書き・ピン・並び順・ペインの寸法) は引き継がない。origin で閉じているものはそれで正しい (kawaz 裁定)
- 今の origin と同じ候補を選んでも遷移しない

#### 4.2 daemon の版

- `daemon v<version>` の 1 行。値は今と同じ `ping` の返事の `version` (store の `daemonInfo`)
- Status タブから移す。Status タブの最下部の行は消し、2 か所に出さない

#### 4.3 Claude Code の版と更新 (kawaz 裁定 2026-10-28)

- `claude v<version> [↻]` の 1 行。出す版は **最後に起動したセッションのプロセスの版** (agents の行のうち `startedAt` が最も新しく `version` を持つ行の `version`)。版の最大は取らない: 自動更新が有効なら新しいセッションは起動の時に最新へ上がるので、最後に起動したセッションの版がこのホストの今の版を言う
- 版の横にリロードのアイコンボタンを置く。押すと daemon が `claude update` を実行する (op は下記)。`claude` は daemon の PATH のもの。`claude update` の結果は `claude --version` の実測で見る。binary は上がるが、走っているプロセスには再起動 ([DR-0028](./DR-0028-session-kill.md) の restart) まで効かない
- `claude update` が終わったら、daemon は `claude --version` を実行し直して版を覚え直し、表示にはその版を使う。`claude update` の出力は解釈しない (kawaz 実測)。`claude --version` の出力は先頭の版の語だけを読む (`2.1.312 (Claude Code)` → `2.1.312`)
- [提案] 2 つの源の組み合わせは「後に観測した方が勝つ」: 最後に起動したセッションの `startedAt` と、daemon が覚え直した時刻を比べ、新しい方の版を出す。update の後に起動したセッションがあれば、その版が出る。どちらも無ければ (走っているセッションが無く、update もしていない) 行は `claude —` とボタンだけにする
- 失敗した時は、`claude update` (または `claude --version`) の stderr の要点 (空でない末尾の行を 1〜2 行、長ければ切り詰める) を GLOBALS の版の下に短く出す。次の成功で消える。webui の state に持ち、保存しない
- [提案] 押している間はボタンを disabled にして「更新中…」を出す。確認のダイアログは出さない (走っているプロセスに影響しない操作なので)

#### 4.4 op `claude_update` (user role)

- request: `{ op: "claude_update" }`
- response: `{ ok: true, version, exit_code: 0 }`。`version` は覚え直した版 (`claude --version` の先頭の語)
- error:
  - `bad_request`: user role でない (session role のエージェントがホストの binary を更新できてはいけない)
  - `claude_not_found`: daemon の PATH に `claude` が無い
  - `claude_update_failed`: `claude update` が 0 以外で終わった。msg に終了コードと stderr の要点
  - `claude_version_unreadable`: `claude update` は 0 で終わったが、`claude --version` が 0 以外で終わったか、先頭の語が版の形でない。msg に stderr の要点か出力の先頭
  - `claude_update_busy`: 前の `claude_update` がまだ走っている (同時に 2 つ起こさない)
  - `claude_update_timeout`: [提案] 300 秒で打ち切る。根拠: native の binary は 264 MB (上の観測) で、2 MB/s の回線でも取得は約 130 秒、その倍強の余裕。実測した所要時間ではないので、実装の時に測って直す
- 返事は update の所要時間まで遅れるので 2-phase にし、同じ接続の他の依頼を待たせない ([DR-0028](./DR-0028-session-kill.md) の `session_kill` と同じ理由)
- daemon.log に 1 行: `claude_update: exit_code=<N> version=<v> [error=<code>]`
- 覚え直した版と時刻は daemon のメモリに持つ (daemon が起こし直されると消え、表示は最後に起動したセッションの版に戻る)。webui への渡し方は論点 6

### 5. 繋ぎ先の候補と、リンクに使う名前の規則

既存の `webuiUrlOf` が暗黙に持っている「先頭がリンクに使う名前」という規則を、ここで定める。新しい config キーは足さない (kawaz 裁定)。

- **候補の一覧**: daemon が信頼する Origin のうち、daemon 自身の bind を除き、正しい origin の形 (`new URL(o).origin === o`) で、scheme が http(s) で、host が loopback (`localhost`・`127.x.x.x`・`[::1]`) でないもの。並びは `CCMSG_HTTP_ALLOW_ORIGIN` の並び → tailscale serve の自動許可 (見つけた順) → `allowed-origins.json` の並び。同じ origin が 2 度出たら先の位置に置く
- **リンクに使う名前**: 一覧の先頭。`webui_url` と `ccmsg_url` ([DR-0039](./DR-0039-all-mods-and-typed-tools.md) §5) はこれ。リンクの名前を変えたい時は、その Origin を並びの先頭に置く
- 一覧とリンクの名前は daemon の 1 つの関数から出す (一覧を作る関数があり、`webui_url` はその先頭)。2 つの絞り込みを別々に書かない
- 一覧は起動の後にも伸びる (tailscale の自動許可は非同期、file は書き換えると次の読みで変わる)。webui が受け取るのは接続のたびの値 (論点 3)

## 論点 (kawaz 裁定待ち)

### 論点 1. 区画の実装: `<details>` か、見出しの button + region か

推し: **案 B (`<h2><button aria-expanded aria-controls>` + `role="region"`)**。

- 案 A: `<details>` (`name` 無し、独立に開閉) / `<summary>` を区画にし、ボタン群を summary の外に兄弟で置く
- 案 B: 見出し行を `<div class="…-head">` にし、その中に `<h2><button aria-expanded aria-controls>Sessions</button></h2>` とボタン群を兄弟で並べる。本体は `<div role="region" aria-labelledby>` で、閉じている時は `hidden`。開閉の状態はコンポーネントの state (見出しの button の click の handler が入れ替える。Effect は使わない)

| 軸 | 案 A `<details>` | 案 B button + region |
|---|---|---|
| ボタン群の置き場 | 閉じた `<details>` は summary 以外の子を描かないので、ボタン群は `<details>` の外に置くしかない。見出しの行に見せるには、外側の要素を grid にして `<details>` と重ねる配置が要る | 見出し行の中で button の兄弟に置ける。行は素の flex で、button が `flex: 1` で残りの幅を占める |
| DOM の順と見た目の順 | ボタン群を `<details>` の後に置くと、支援技術とキーボードは本体の後でボタン群に来る。前に置くと、見た目は「名前 → ボタン」なのに Tab は「ボタン → 名前」になる | 一致する (名前 → ボタン群 → 本体) |
| 入れ子の対話要素 | summary は 1 つのボタンとして扱われるので、中にボタンを置くと入れ子になる (§2 で禁じる形)。外に出せば避けられる | 開閉の button とボタン群が兄弟なので構造上起きない |
| 本体の高さの分け合いとスクロール | `details[open]` の selector で伸びる区画にでき、CSS だけで済む。本体のスクロールは `::details-content` に `min-height: 0` / `overflow-y: auto` を当てる (Chrome と Safari の最新で効くかは未検証) | 本体の `div` に当てるだけ。開いている区画には `aria-expanded="true"` の見出しの兄弟の selector か class で当てる |
| 開閉の状態の持ち主 | ブラウザ (JS の state 無し)。既存の `Fold` と同じ | コンポーネントの state (boolean 1 つ) |
| ページ内検索で閉じた本体の語に当たるか | 閉じた `<details>` を開いて当てる実装が Chrome にある。この UI では Chrome・Safari とも未検証 | `hidden="until-found"` + `beforematch` で開ける。Safari で効くかは未検証 (効かなくても `hidden` と同じく隠れるだけ) |

推しの理由: kawaz の要件の芯は「見出しにボタン群が並び、それが開閉を動かさないことを構造で保証する」で、`<summary>` は見出し全体を 1 つのボタンにする要素なので、この形を表せない。案 A はボタン群を `<details>` の外に追い出し、重ねる配置と DOM / 見た目の順のずれを抱える。案 B は WAI-ARIA APG の Accordion パターン (見出しの中の button + region、複数同時に開いてよい) そのままで、DOM の順が見た目の順と一致し、行の組み方も素の flex で済む。開閉の state は人の click の handler が入れ替える boolean 1 つで、ブラウザの振る舞い (スクロール・位置) を JS で制御するものではない。

悪い面: 開閉の部品が `Fold` (`<details>`) と区画 (button + region) の 2 種類になる。見出しにボタンを持つかどうかで使い分ける、と部品の doc comment に書く。閉じた本体へのページ内検索は Safari で効かないかもしれない (未検証)。

### 論点 2. 開閉の状態を保存するか

推し: **保存しない** (開くたびに §1 の初期表示 = SESSIONS だけ開く)。

- §1 の初期表示の規定が、開いた窓では毎回そのまま効く。保存すると規定が効くのは初めて開いた 1 度だけになる
- 既存の前例と揃う: Status タブの TODO の fold は「開閉の状態は保持しない」([DR-0020](./DR-0020-session-status-tab.md) Addendum 2026-10-25)、ROOMS の fold も保存していない。URL の文法も fold の開閉を載せない ([webui-url-grammar](../design/webui-url-grammar.md))
- 悪い面: GLOBALS や ROOMS を開いたまま使いたい人は、再読み込み (版の更新の青いボタンを含む) のたびに開き直す
- 次点: sessionStorage に置く (`storage.ts` の 3 分類の「窓ごとの状態」)。同じ窓の再読み込みでは残り、新しい窓は初期表示で始まるので、初期表示を「新しい窓の初期表示」と読めば規定と両立する。localStorage (「内容」の分類) は取らない: 窓をまたいで伝染し、初期表示の規定が実質効かなくなる

### 論点 3. 候補を daemon から webui へ渡す経路

推し: **`ping` の返事に `webui_urls: string[]` (optional) を足す**。中身は §5 の一覧で、`webui_url` はその先頭と同じ値。

| 案 | 内容 | 評価 |
|---|---|---|
| A (推し) | `ping` の返事に配列を足す | `webui_url` が既に `ping` にあり、一覧とその先頭が同じ返事に並ぶ。webui は handshake の最後で既に `ping` を呼んで `daemonInfo` を取っているので往復が増えない。`ccmsg status` の出力にも並ぶので人が CLI で確かめられる。変更は optional の field 1 つ |
| B | hello の返事に配列を足す | hello の追加 field は user role 向けの capability (`launch_available` 等) の置き場で、性格が違う。`webui_url` (`ping`) と一覧 (hello) が別の返事に分かれ、同じ規則の値を 2 か所から読むことになる |
| C | 新しい op (`webui_origins` 等) | 往復と op の面が増え、得るものが無い |

- 名前を `webui_urls` にするのは、`webui_url` との関係 (その先頭) を名前で示すため。値は `webui_url` と同じく origin (`scheme://host[:port]`)
- 悪い面: `ping` は user role 以外 (CLI・session role) にも答える。返事には既に `httpAllow` 等の設定由来の値があり、Origin の一覧は daemon が受け付ける名前を並べるだけなので、出してよいと判断する
- [DR-0039](./DR-0039-all-mods-and-typed-tools.md) の tool の規約は MCP tool の話で、webui の wire には直接かからない

### 論点 4. 届かない候補をどう見せるか

推し: **何もしない** (選べば遷移し、届かなければブラウザの接続失敗の画面になるだけ)。

- 届くかどうかは端末の経路で決まり、daemon には判定できない (daemon の側で名前を引いて繋いでも、それは daemon の機械の経路で、端末の経路ではない)
- 端末の側で事前に試す (候補ごとに `fetch` を投げる) には打ち切りの時間が要るが、根拠のある値が無い。実測でも、この Mac から自分の Tailscale の IPv6 宛ては 8 秒の timeout だった ([runbook device-access-path](../runbooks/device-access-path.md))。候補を出すたびに試すと、GLOBALS を開くたびに通信と待ちが生まれる
- 失敗は目に見え、戻せる: 遷移は普通の navigation で履歴に積まれるので、戻るで元の origin に戻れる (同じ path を運んでいるので元の画面に戻る)。戻った時に bfcache から戻るか再読み込みになるかは未検証
- 候補は daemon の設定 (信頼する Origin) から来るもので、人が意図して並べた名前だけが出る
- 悪い面: v6 だけの名前を v4 だけの端末で選ぶと、接続失敗の画面まで待たされる。名前ごとの「v6 のみ」等の注記は持たない (config キーを足さないため)

### 論点 5. 部品の名前

推し: 部品は **`SidebarFold`** (`components/SidebarFold.tsx`)。部分は見出し (`head`) と本体 (`body`)。

- 一般名: WAI-ARIA APG では、見出しの button と区画を縦に積んだ集まりが Accordion (複数同時に開いてよい)、1 つの開閉の対が Disclosure。サイドバーの列が Accordion、各区画が Disclosure に当たる
- コードの語彙: この UI では開閉する区画を一貫して fold と呼ぶ (`Fold.tsx`、`fold-open-store.ts`、Status タブの TODO の fold)。section は SessionList の中の区分 (`groupSessionsBySection`、`.session-section`) が、panel はサイドバーのフォーム (`state.sidebar.panel`、`sb.panel`) が使っている。kawaz の仮名の Folder は Files タブとワークスペース ([DR-0026](./DR-0026-vscode-workspace-section.md)) のフォルダと衝突する
- 案: props は `title`・`tools` (見出しのボタン群)・`defaultOpen`・`children`。CSS の class は `.sidebar-fold` / `.sidebar-fold-head` / `.sidebar-fold-toggle` / `.sidebar-fold-tools` / `.sidebar-fold-body`。区画の id は `#sidebar-sessions` / `#sidebar-rooms` / `#sidebar-globals` (今の `#sessions-panel` / `#rooms-panel` は panel の語がフォームと衝突するので改める)
- 見出しの文字は Sessions / Rooms (読み取り専用) / Globals (今と同じく CSS で大文字にする)
- 論点 1 で案 A を取る場合も名前は同じで、`SidebarFold` が中で `Fold` を使う

### 論点 6. daemon が覚え直した Claude Code の版を webui へ渡す経路

推し: **案 A (`claude_update` の返事と、`ping` の返事の optional の `claude_version`)**。

| 案 | 内容 | 評価 |
|---|---|---|
| A (推し) | 押したタブは `claude_update` の返事の `version` で表示を変える。`ping` の返事に `claude_version: { version, observed_at }` (daemon が覚え直した版と時刻、覚えていなければ無し) を足し、他のタブは次の handshake で受け取る | 増えるのは op 1 つと `ping` の field 1 つ。`ping` は webui が handshake で既に呼んでいて `daemonInfo` (daemon の版) の源でもあるので、ホストの版の源が 1 か所に並ぶ。`observed_at` は 4.3 の「後に観測した方が勝つ」の比較に使う |
| B | A に加え、覚え直した時に全タブへ push する (`ev: "claude_version"`、`ev: "llm_status"` と同じ user role の購読者向け) | 開いている全タブ・全端末がすぐ揃う。stream event の種類が 1 つ増える |
| C | `ev: "agents"` の push に載せる | agents の行はプロセスごとの記録で、ホストの binary の版は性格が違う。押した時に agents の行は変わらないので、push を起こす契機も合わない |

- 推しの理由: update は人がたまに押す操作で、押した端末は返事ですぐ変わる。他のタブが古い版を出し続けるのは再読み込みか再接続までで、そこで押し直しても `claude update` は同じ版のまま終わるだけで害が無い
- 悪い面 (案 A): 別の端末で開いている GLOBALS は、再接続までは update の前の版 (最後に起動したセッションの版) を出す。全タブが揃うことを要件にするなら B
- `observed_at` は daemon の時計の epoch ms (agents の行の `startedAt` と同じ単位)

## Alternatives Considered

- 案: グローバルヘッダに endpoint と版を置く
  - 不採用理由: スマホでヘッダが狭い (kawaz)
- 案: 区画の部品に「上に付く / 下に付く」の prop を持たせる
  - 不採用理由: どこに付くかはサイドバーのレイアウトの責務で、部品の責務ではない (kawaz)。prop にすると部品が並べ方を知ることになる
- 案: 見出しのボタンの click を `stopPropagation` で止める
  - 不採用理由: ボタンごとに止め忘れの余地が残り、忘れたボタンだけ黙って開閉させる。兄弟にすれば止める処理自体が要らない (kawaz)
- 案: 区画を 1 つ開くと他が閉じる排他 (`<details name>` 等)
  - 不採用理由: SESSIONS を見ながら GLOBALS を開く等、同時に開きたい (kawaz)
- 案: 繋ぎ先の候補を新しい config キー (例 `webui_endpoints`) で持つ
  - 不採用理由: daemon が信頼する Origin の一覧が既に「人が webui を開く名前」の集合で、同じ名前を 2 か所に書くことになる。信頼しない Origin を候補に載せられてしまう (kawaz: キーを足さない)
- 案: 切り替えの時に localStorage 等を移った先の origin へ引き継ぐ
  - 不採用理由: origin で閉じているものはそれで正しい (kawaz)。引き継ぐには origin をまたぐ受け渡しの口が要る
- 案: 走っているセッションのプロセスの版の最大を Claude Code の版として出す
  - 不採用理由: 自動更新で新しいセッションは起動の時に最新へ上がるので、最後に起動したセッションの版で足りる (kawaz 2026-10-28)
- 案: 配布されている最新版を daemon が外に問い合わせて出す
  - 不採用理由: 4.3 の update のボタンで上げて `claude --version` で覚え直せば、外部への問い合わせとその失敗・cache の扱いを持たずに済む (kawaz 2026-10-28)
- 案: `claude update` の出力を解釈して上がった版を得る
  - 不採用理由: 出力は表示用で、版は `claude --version` で直接聞ける (kawaz 実測)

## Consequences

- Status タブから daemon の版の行 (`.status-daemon-version`) が消える。Status タブはセッションに属するものだけになる
- サイドバーの一覧の段は、1 本の縦スクロールから区画ごとのスクロールに変わる
- 縦積み (フォームが上・一覧が下) の時の一覧の既定の高さ (`SIDEBAR_LIST_DEFAULT_PX` = 220px) は「一覧の上端から 1 行目まで 75px」の実測を根拠にしているが、見出しが 3 つ (SESSIONS・ROOMS・GLOBALS) 並ぶと 1 行目までが変わり、見える行が減る。実装の時に測り直す
- リンクの名前は設定の並びで決まる、が明文になる。tailscale serve の自動許可は file の Origin より前に並ぶので、tailscale serve が動いている間は file の Origin をリンクの名前にできない (`CCMSG_HTTP_ALLOW_ORIGIN` は env なので先頭に置けるが、env を持たずに daemon が起こし直されると消える、`origins-file.ts` の冒頭)
- protocol は op `claude_update` が 1 つ増え、`ping` の返事に optional の field が 2 つ (`webui_urls`、`claude_version`) 増える (論点 3・論点 6 の推しの場合)。知らない client は落とす (`v.object`)
- daemon に「ホストの Claude Code の binary を更新する」能力が入る。user role 限定で、走っているプロセスには触らない。上がった binary が効くのは、以後に起動するセッション
- 自作コンポーネントカタログ ([DR-0031](./DR-0031-webui-design-tokens-and-catalog.md)) に `SidebarFold` の見本を足す
- 「持たない」ことを壊す変更を止める試験の観点:
  - 見出しのボタンを押しても区画の開閉が変わらない (SESSIONS の 4 つのボタンそれぞれ)
  - 開閉の要素の子孫に button / a / input が無い
  - `webui_url` が候補の一覧の先頭と常に同じ (loopback だけ・空・重複・file のみ、の各場合)
  - 候補に loopback と http(s) 以外が入らない
  - 切り替えで path・query・hash が変わらず origin だけが変わる
  - 初期表示で SESSIONS だけが開いている
  - `claude_update` は user role 以外を断る
  - 覚え直す版は `claude --version` の先頭の語から取り、`claude update` の出力を読まない (update が版らしい文を出しても、`--version` の値が使われる)
  - 出す版は最大でなく、後に観測した方 (最後に起動したセッション / 覚え直した時刻)

## 関連

- [DR-0020](./DR-0020-session-status-tab.md) — Status タブ。Addendum 2026-10-25 のプロセスの版
- [DR-0028](./DR-0028-session-kill.md) — セッションの終了・再起動は Status タブの危険ゾーンに置く
- [DR-0039](./DR-0039-all-mods-and-typed-tools.md) §5 — `ccmsg_url` (= `webui_url`)
- [DR-0005](./DR-0005-webui-frontend-architecture.md) — webui のコンポーネントの器
- [DR-0031](./DR-0031-webui-design-tokens-and-catalog.md) — 自作コンポーネントカタログ
- [runbook device-access-path](../runbooks/device-access-path.md) — 端末ごとの繋ぎ先
- [webui-url-grammar](../design/webui-url-grammar.md) — URL が画面の状態の正本
