# DR-0043: サイドバーを開閉できる区画 (SESSIONS / ROOMS / GLOBALS) の列にし、GLOBALS に繋ぎ先の切り替えと版を置く

- Status: Proposed
- Date: 2026-10-28

## Context

webui の画面全体に効く情報と操作の置き場が無い。スマホではグローバルヘッダに足す余地が無く、daemon の版はセッションごとの Status タブの最下部に置かれている。セッションに属さない情報が、セッションを開かないと見えない場所にある。

もう 1 つの要求は端末ごとの繋ぎ先の切り替え。iPhone / iPad は IPv6 だけの名前 (`ccmsg.v6-sandbox.kawaz.jp`) で繋ぎ、Mac は従来の IPv4 の名前で繋ぐ運用をしている ([runbook device-access-path](../runbooks/device-access-path.md))。エージェントが書くリンク (`ccmsg_url`) は IPv4 側の名前なので、iPhone でリンクを開くと IPv4 の経路に戻り、そこから v6 の名前へ移る口が webui に無い。

### 読んで分かった前提 (既存コード)

- サイドバーは `Sidebar.tsx` の `#sidebar-lists` に `#sessions-panel` (`<h2>` に Sessions の文字と、+New・🔍・並び順・↻ のボタンが入る) と `#rooms-panel` が縦に並び、`#sidebar-lists` 全体が 1 つの縦スクロールを持つ (app.css の `#sidebar-lists, #sidebar-form` の規則)
- ROOMS は既に閉じた状態で始まる `Fold` (`<details>`) で、開いた時に room の一覧を取る (`RoomList.tsx`)。`Fold.tsx` はこの UI の開閉部品の共通形で、`<details>` / `<summary>` をブラウザに任せる。SessionList の中の Pinned 等の区分 (`groupSessionsBySection`、`.session-section`) も `Fold`
- Status タブに出ている版は最下部の `daemon v<version>` の 1 行だけ (`StatusPanel.tsx` の `.status-daemon-version`)。値は webui が接続のたびに送る `ping` の返事の `version` (`ws.ts` の handshake の最後、store の `daemonInfo`)
- Claude Code の版は、セッションごとのプロセスの版 (agents の行の optional の `version`、[DR-0020](./DR-0020-session-status-tab.md) Addendum 2026-10-25) が TL 下ミニパネルの ctx 行の末尾に `claude v<version>` で出るだけ (`utils.ts` の `sessionProcessParts`)。Status タブには無く、配布されている最新版を調べる処理も daemon に無い (論点 6)
- `webui_url` は hello ではなく `ping` の返事に載る (`response-host.ts` の `PingResponseSchema`)。daemon の `webuiUrlOf` (`http.ts`) が、`CCMSG_HTTP_ALLOW_ORIGIN` → tailscale serve の自動許可 → `allowed-origins.json` (`ccmsg origins add`) の順に並べた Origin のうち、正しい origin の形で、http(s) で、host が loopback でない最初の 1 つを返す。hooks module はこれを `ccmsg status` で読み、最初の turn の前の案内の `ccmsg_url: <url>` に使う ([DR-0039](./DR-0039-all-mods-and-typed-tools.md) §5)
- env の Origin と tailscale の自動許可は同じ `Set` (`httpAllowOrigin`) に入り、tailscale の分は起動の後に非同期で足される。file の Origin は mtime で読み直される (`origins-file.ts`)
- セッションへの操作 (終了・再起動) は Status タブの危険ゾーンに置く ([DR-0028](./DR-0028-session-kill.md))。本 DR の GLOBALS はセッションに属さないもの (daemon と、webui を開いている origin) だけを持ち、セッションの操作はそちらのまま

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

#### 4.3 Claude Code の版

- kawaz の要求は「claude の最新版の表示を Status タブから GLOBALS へ移す」だが、上の前提のとおり既存の Status タブにその表示は無い。何を出すかは論点 6

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

### 論点 6. GLOBALS に出す Claude Code の版は何か

推し: **案 a (このホストで走っているセッションのプロセスの版のうち、最も新しいもの)**。

- 案 a: agents の行の `version` (セッションのプロセスの版、[DR-0020](./DR-0020-session-status-tab.md) Addendum 2026-10-25) の最大を `compareVersions` (`@ccmsg/protocol`) で取り、`claude v<version>` で出す。webui が既に持っている agents の行から導くので、protocol の変更は無い。版の古いセッションを見つけて再起動する ([DR-0028](./DR-0028-session-kill.md) の restart) きっかけになる
- 案 b: 配布されている最新版を daemon が外に問い合わせる。daemon に外部への通信と、その失敗・cache の扱いが新しく入る。本 DR の範囲 (置き場の整理) を超えるので、採るなら別の DR に切り出す (GLOBALS はその表示の置き場になるだけで、本 DR の他の決定は変わらない)
- 悪い面 (案 a): 走っているどのセッションよりも新しい版が入っていても分からない (「最新」はこのホストで観測できた中での最新)。走っているセッションが 1 つも無ければ出せない

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

## Consequences

- Status タブから daemon の版の行 (`.status-daemon-version`) が消える。Status タブはセッションに属するものだけになる
- サイドバーの一覧の段は、1 本の縦スクロールから区画ごとのスクロールに変わる
- 縦積み (フォームが上・一覧が下) の時の一覧の既定の高さ (`SIDEBAR_LIST_DEFAULT_PX` = 220px) は「一覧の上端から 1 行目まで 75px」の実測を根拠にしているが、見出しが 3 つ (SESSIONS・ROOMS・GLOBALS) 並ぶと 1 行目までが変わり、見える行が減る。実装の時に測り直す
- リンクの名前は設定の並びで決まる、が明文になる。tailscale serve の自動許可は file の Origin より前に並ぶので、tailscale serve が動いている間は file の Origin をリンクの名前にできない (`CCMSG_HTTP_ALLOW_ORIGIN` は env なので先頭に置けるが、env を持たずに daemon が起こし直されると消える、`origins-file.ts` の冒頭)
- protocol は `ping` の返事に optional の field が 1 つ増える (論点 3 の推しの場合)。知らない client は落とす (`v.object`)
- 自作コンポーネントカタログ ([DR-0031](./DR-0031-webui-design-tokens-and-catalog.md)) に `SidebarFold` の見本を足す
- 「持たない」ことを壊す変更を止める試験の観点:
  - 見出しのボタンを押しても区画の開閉が変わらない (SESSIONS の 4 つのボタンそれぞれ)
  - 開閉の要素の子孫に button / a / input が無い
  - `webui_url` が候補の一覧の先頭と常に同じ (loopback だけ・空・重複・file のみ、の各場合)
  - 候補に loopback と http(s) 以外が入らない
  - 切り替えで path・query・hash が変わらず origin だけが変わる
  - 初期表示で SESSIONS だけが開いている

## 関連

- [DR-0020](./DR-0020-session-status-tab.md) — Status タブ。Addendum 2026-10-25 のプロセスの版
- [DR-0028](./DR-0028-session-kill.md) — セッションの終了・再起動は Status タブの危険ゾーンに置く
- [DR-0039](./DR-0039-all-mods-and-typed-tools.md) §5 — `ccmsg_url` (= `webui_url`)
- [DR-0005](./DR-0005-webui-frontend-architecture.md) — webui のコンポーネントの器
- [DR-0031](./DR-0031-webui-design-tokens-and-catalog.md) — 自作コンポーネントカタログ
- [runbook device-access-path](../runbooks/device-access-path.md) — 端末ごとの繋ぎ先
- [webui-url-grammar](../design/webui-url-grammar.md) — URL が画面の状態の正本
