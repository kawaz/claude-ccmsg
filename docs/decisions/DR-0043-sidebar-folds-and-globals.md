# DR-0043: サイドバーを開閉できる区画 (SESSIONS / ROOMS / GLOBALS) の列にし、GLOBALS に繋ぎ先の切り替え・版・Claude Code の更新を置く

- Status: Accepted (2026-10-28、kawaz 裁定) — ✅ 実装済み (§1〜§5 のサイドバーの区画の列 (`SidebarFold`) と GLOBALS、§6 の op `claude_update`、§7 の `webuiUrlsOf`、§8 の `ping` の `webui_urls` / `claude_version` と `ev: "claude_version"`)
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
- user role の購読者へホスト全体の値を配る push の前例に `ev: "llm_status"` がある (`stream-event.ts`)
- セッションへの操作 (終了・再起動) は Status タブの危険ゾーンに置く ([DR-0028](./DR-0028-session-kill.md))。本 DR の GLOBALS はセッションに属さないもの (daemon、このホストの Claude Code、webui を開いている origin) だけを持ち、セッションの操作はそちらのまま

## Decision

### 1. サイドバーは開閉できる区画の列にする

- サイドバーの一覧の段を、開閉できる区画の列にする。区画は SESSIONS・ROOMS・GLOBALS の 3 つ
- 区画は見出しと本体からなる。見出しは 1 行の高さ、本体は開いている時だけ出す。見出しを押すと開閉が入れ替わる
- 区画はそれぞれ独立に開閉でき、同時に複数開いてよい (1 つ開くと他が閉じる排他にしない)
- 初期表示は一番上の SESSIONS だけ開き、ROOMS と GLOBALS は閉じる。ROOMS の「開いた時に一覧を取る」振る舞いはそのまま区画の開く操作に付く
- 開閉の状態は保存しない。窓を開くたび・再読み込みのたびに初期表示から始まる。Status タブの TODO の fold ([DR-0020](./DR-0020-session-status-tab.md) Addendum 2026-10-25) と ROOMS の fold も保存しておらず、URL の文法も fold の開閉を載せない ([webui-url-grammar](../design/webui-url-grammar.md))
- グローバルヘッダには何も足さない (スマホで狭い)

### 2. 見出しのボタンは開閉を動かさない (構造で保証する)

- SESSIONS の見出しには +New (hello の `launch_available` の時)・🔍・並び順・↻ を置く。これらを押しても区画は開閉しない
- これを構造で保証する: 見出しの中で、開閉を担う要素とボタン群を兄弟にし、ボタン群を開閉の要素の子孫にしない。ボタンの click は開閉の要素に届かないので、`stopPropagation` で止める必要が無い。入れ子の button (対話要素の中の対話要素) を作らない
- 開閉の要素は見出しのうちボタン群を除いた全幅を占め、見出しのどこを押しても (ボタンの上以外は) 開閉する
- 区画の名前は見出し (`h2`) として残し、支援技術で見出しをたどれるようにする

### 3. 区画の部品 `SidebarFold`

- 部品は `SidebarFold` (`components/SidebarFold.tsx`)。部分は見出し (`head`) と本体 (`body`)。props は `title`・`tools` (見出しのボタン群)・`defaultOpen`・`children`
- DOM の形:
  - 見出し行 `<div class="sidebar-fold-head">` の中に、`<h2><button class="sidebar-fold-toggle" aria-expanded aria-controls>Sessions</button></h2>` とボタン群 `<div class="sidebar-fold-tools">` を兄弟で並べる。行は flex で、`h2` と button が残りの幅を占める
  - 本体は `<div class="sidebar-fold-body" role="region" aria-labelledby>` で、閉じている時は `hidden`
  - 全体は `<section class="sidebar-fold">`
- 開閉の状態はコンポーネントの state (boolean 1 つ、初期値は `defaultOpen`)。見出しの button の click の handler が入れ替える。Effect は使わない
- ページ内検索で閉じた本体の語に当たった時に開けるよう、`hidden="until-found"` と `beforematch` で開く。Safari で効くかは未検証 (効かなければ `hidden` と同じく隠れたまま)
- 区画の id は `#sidebar-sessions` / `#sidebar-rooms` / `#sidebar-globals`。今の `#sessions-panel` / `#rooms-panel` は、panel の語がサイドバーのフォーム (`state.sidebar.panel`、`sb.panel`) と衝突するので改める
- 見出しの文字は Sessions / Rooms (読み取り専用) / Globals (今と同じく CSS で大文字にする)
- 名前の根拠: この UI では開閉する区画を一貫して fold と呼ぶ (`Fold.tsx`、`fold-open-store.ts`、Status タブの TODO の fold)。WAI-ARIA APG の語では、サイドバーの列が Accordion (見出しの中の button + region、複数同時に開いてよい)、各区画が Disclosure に当たる
- 開閉の部品は `Fold` (`<details>`、見出しにボタンを持たない) と `SidebarFold` (見出しにボタン群を持てる) の 2 種類になる。使い分けをそれぞれの doc comment に書く

### 4. 上に付く区画と下に付く区画はサイドバーのレイアウトで決める

- 「上に付く / 下に付く」は区画の部品の prop にせず、サイドバーの CSS で決める。一覧の段を `display: flex; flex-direction: column` にし、SESSIONS と ROOMS は上から並び、GLOBALS は `margin-top: auto` で下端に付く
- 開いている区画の本体が、見出しの残りの高さを分け合う。本体はそれぞれ自分の縦スクロールを持つ (`min-height: 0` + `overflow-y: auto`)。段全体の 1 本のスクロールにはしない (長い SESSIONS が GLOBALS を画面の外へ押し出さないため)
- 高さを分け合うのは一覧の区画 (SESSIONS・ROOMS) だけにし、GLOBALS の本体は中身の高さだけを取る。GLOBALS の中身は数行で伸びる必要が無く、分け合うと一覧の行が減るだけになる。これもサイドバーの CSS で区画の id を名指して決め、部品の prop にはしない

### 5. GLOBALS に置くもの

#### 5.1 繋ぎ先 (endpoint) の表示と切り替え

- `endpoint: [ccmsg.v6-sandbox.kawaz.jp ▾]` の 1 行。今このページを開いている origin を表示し、選ぶと別の名前の origin へ移る
- 候補は §7 の一覧。今の origin が候補に無い時 (daemon の bind を直接開いた loopback 等) も、今の origin を選択中の項目として出す
- 部品は素の `<select>`。スマホでは OS の選択 UI が出る。表示は host (`URL.host`)、`https:` 以外の候補だけ scheme を添える。今の origin のほかに候補が無ければ、選ぶ部品にせず文字だけを出す
- 切り替えは、今の URL の origin だけを選んだ候補に差し替えて別の origin へ遷移するだけ (`location.assign`)。path・query・hash はそのまま運ぶ: URL が画面の状態の正本なので ([webui-url-grammar](../design/webui-url-grammar.md)、`sb.*` のサイドバーのフォームを含む)、移った先でも同じ画面になる
- origin ごとの localStorage / sessionStorage (下書き・ピン・並び順・ペインの寸法) は引き継がない。origin で閉じているものはそれで正しい
- 今の origin と同じ候補を選んでも遷移しない

#### 5.2 daemon の版

- `daemon v<version>` の 1 行。値は今と同じ `ping` の返事の `version` (store の `daemonInfo`)
- Status タブから移す。Status タブの最下部の行は消し、2 か所に出さない

#### 5.3 Claude Code の版と更新

- `claude v<version> [↻]` の 1 行。出す版は **最後に起動したセッションのプロセスの版** (agents の行のうち `startedAt` が最も新しく `version` を持つ行の `version`)。版の最大は取らない: 自動更新が有効なら新しいセッションは起動の時に最新へ上がるので、最後に起動したセッションの版がこのホストの今の版を言う
- 版の横にリロードのアイコンボタンを置く。押すと daemon が `claude update` を実行する (§6)。`claude` は daemon の PATH のもの。`claude update` の結果は `claude --version` の実測で見る。binary は上がるが、走っているプロセスには再起動 ([DR-0028](./DR-0028-session-kill.md) の restart) まで効かない
- `claude update` が終わったら、daemon は `claude --version` を実行し直して版を覚え直し、表示にはその版を使う。`claude update` の出力は解釈しない (kawaz 実測)。`claude --version` の出力は先頭の版の語だけを読む (`2.1.312 (Claude Code)` → `2.1.312`)
- 2 つの源の組み合わせは「後に観測した方が勝つ」: 最後に起動したセッションの `startedAt` と、daemon が覚え直した時刻 (§8 の `observed_at`) を比べ、新しい方の版を出す。update の後に起動したセッションがあれば、その版が出る。どちらも無ければ (走っているセッションが無く、update もしていない) 行は `claude —` とボタンだけにする
- 失敗した時は、`claude update` (または `claude --version`) の stderr の要点 (空でない末尾の行を 1〜2 行、長ければ切り詰める) を GLOBALS の版の下に短く出す。次の成功で消える。webui の state に持ち、保存しない
- 押している間はボタンを disabled にして「更新中…」を出す。確認のダイアログは出さない (走っているプロセスに影響しない操作なので)

### 6. op `claude_update` (user role)

- request: `{ op: "claude_update" }`
- response: `{ ok: true, version, exit_code: 0 }`。`version` は覚え直した版 (`claude --version` の先頭の語)
- error:
  - `bad_request`: user role でない (session role のエージェントがホストの binary を更新できてはいけない)
  - `claude_not_found`: daemon の PATH に `claude` が無い
  - `claude_update_failed`: `claude update` が 0 以外で終わった。msg に終了コードと stderr の要点
  - `claude_version_unreadable`: `claude update` は 0 で終わったが、`claude --version` が 0 以外で終わったか、先頭の語が版の形でない。msg に stderr の要点か出力の先頭
  - `claude_update_busy`: 前の `claude_update` がまだ走っている (同時に 2 つ起こさない)
  - `claude_update_timeout`: `claude update` と `claude --version` を合わせて 300 秒で打ち切る (`CLAUDE_UPDATE_TIMEOUT_MS`、プロセスグループごと止める)。根拠: native の binary は 264 MB (上の観測) で、2 MB/s の回線でも取得は約 130 秒、その倍強の余裕。実測 (2026-10-28、この Mac の PATH の claude、隔離 daemon から): 既に最新 (2.1.312) で取得の無い回は押してから返事まで 1.6 秒。取得のある回は新しい版が出ていなかったので測れておらず、300 秒は取得の見積もりのまま
- 返事は update の所要時間まで遅れるので 2-phase にし、同じ接続の他の依頼を待たせない ([DR-0028](./DR-0028-session-kill.md) の `session_kill` と同じ理由)
- daemon.log に 1 行: `claude_update: exit_code=<N> version=<v> [error=<code>]`
- 覚え直した版と時刻は daemon のメモリに持つ (daemon が起こし直されると消え、表示は最後に起動したセッションの版に戻る)

### 7. 繋ぎ先の候補と、リンクに使う名前の規則

既存の `webuiUrlOf` が暗黙に持っている「先頭がリンクに使う名前」という規則を、ここで定める。新しい config キーは足さない。

- **候補の一覧**: daemon が信頼する Origin のうち、daemon 自身の bind を除き、正しい origin の形 (`new URL(o).origin === o`) で、scheme が http(s) で、host が loopback (`localhost`・`127.x.x.x`・`[::1]`) でないもの。並びは `CCMSG_HTTP_ALLOW_ORIGIN` の並び → tailscale serve の自動許可 (見つけた順) → `allowed-origins.json` の並び。同じ origin が 2 度出たら先の位置に置く
- **リンクに使う名前**: 一覧の先頭。`webui_url` と `ccmsg_url` ([DR-0039](./DR-0039-all-mods-and-typed-tools.md) §5) はこれ。リンクの名前を変えたい時は、その Origin を並びの先頭に置く
- 一覧とリンクの名前は daemon の 1 つの関数から出す (一覧を作る関数があり、`webui_url` はその先頭)。2 つの絞り込みを別々に書かない
- 一覧は起動の後にも伸びる (tailscale の自動許可は非同期、file は書き換えると次の読みで変わる)。webui が受け取るのは接続のたびの値 (§8)

### 8. daemon から webui への渡し方

- **`ping` の返事に `webui_urls: string[]` (optional) を足す**。中身は §7 の一覧で、`webui_url` はその先頭と同じ値。名前を `webui_urls` にするのは、`webui_url` との関係 (その先頭) を名前で示すため。値は `webui_url` と同じく origin (`scheme://host[:port]`)。webui は handshake の最後で既に `ping` を呼んで `daemonInfo` を取っているので往復は増えない。`ccmsg status` の出力にも並ぶので、人が CLI で確かめられる
- **`ping` の返事に `claude_version: { version, observed_at }` (optional) を足す**。daemon が覚え直した版と時刻で、覚えていなければ無し。`observed_at` は daemon の時計の epoch ms (agents の行の `startedAt` と同じ単位)。接続した時点の値をこれで受け取る
- **覚え直した時に全タブへ push する**: `ev: "claude_version"` (`{ ev, version, observed_at }`)。`ev: "llm_status"` と同じく user role の購読者向け。押したタブも他のタブ・他の端末も、これで揃って表示が変わる。押したタブは `claude_update` の返事でも変わる (同じ値)
- `ping` は user role 以外 (CLI・session role) にも答える。返事には既に `httpAllow` 等の設定由来の値があり、Origin の一覧と Claude Code の版はホストの設定と状態を並べるだけなので、出してよい
- [DR-0039](./DR-0039-all-mods-and-typed-tools.md) の tool の規約は MCP tool の話で、webui の wire には直接かからない

## Alternatives Considered

- 案: グローバルヘッダに endpoint と版を置く
  - 不採用理由: スマホでヘッダが狭い (kawaz)
- 案: 区画の部品に「上に付く / 下に付く」の prop を持たせる
  - 不採用理由: どこに付くかはサイドバーのレイアウトの責務で、部品の責務ではない (kawaz)。prop にすると部品が並べ方を知ることになる
- 案: 見出しのボタンの click を `stopPropagation` で止める
  - 不採用理由: ボタンごとに止め忘れの余地が残り、忘れたボタンだけ黙って開閉させる。兄弟にすれば止める処理自体が要らない (kawaz)
- 案: 区画を 1 つ開くと他が閉じる排他 (`<details name>` 等)
  - 不採用理由: SESSIONS を見ながら GLOBALS を開く等、同時に開きたい (kawaz)
- 案: 区画を `<details>` / `<summary>` にし、ボタン群を summary の外に置く
  - 不採用理由: 閉じた `<details>` は summary 以外の子を描かないので、ボタン群は `<details>` の外に出して重ねる配置が要り、DOM の順 (Tab と支援技術の順) と見た目の順がずれる。summary の中に置けば、summary は見出し全体を 1 つのボタンにする要素なので入れ子の対話要素になる (§2 で禁じる形)
- 案: 開閉の状態を sessionStorage / localStorage に残す
  - 不採用理由: §1 の初期表示の規定が毎回は効かなくなる。localStorage は窓をまたいで伝染し、規定が実質初回だけになる
- 案: 区画の名前を Folder / Section / Panel にする
  - 不採用理由: Folder は Files タブとワークスペース ([DR-0026](./DR-0026-vscode-workspace-section.md)) のフォルダと、section は SessionList の中の区分 (`groupSessionsBySection`、`.session-section`) と、panel はサイドバーのフォームと衝突する
- 案: 繋ぎ先の候補を新しい config キー (例 `webui_endpoints`) で持つ
  - 不採用理由: daemon が信頼する Origin の一覧が既に「人が webui を開く名前」の集合で、同じ名前を 2 か所に書くことになる。信頼しない Origin を候補に載せられてしまう (kawaz: キーを足さない)
- 案: 候補の一覧を hello の返事、または新しい op で渡す
  - 不採用理由: hello の追加 field は user role 向けの capability (`launch_available` 等) の置き場で、`webui_url` (`ping`) と一覧が別の返事に分かれ、同じ規則の値を 2 か所から読むことになる。新しい op は往復と op の面が増えるだけ
- 案: 切り替えの時に localStorage 等を移った先の origin へ引き継ぐ
  - 不採用理由: origin で閉じているものはそれで正しい (kawaz)。引き継ぐには origin をまたぐ受け渡しの口が要る
- 案: 走っているセッションのプロセスの版の最大を Claude Code の版として出す
  - 不採用理由: 自動更新で新しいセッションは起動の時に最新へ上がるので、最後に起動したセッションの版で足りる (kawaz 2026-10-28)
- 案: 配布されている最新版を daemon が外に問い合わせて出す
  - 不採用理由: §5.3 の update のボタンで上げて `claude --version` で覚え直せば、外部への問い合わせとその失敗・cache の扱いを持たずに済む (kawaz 2026-10-28)
- 案: `claude update` の出力を解釈して上がった版を得る
  - 不採用理由: 出力は表示用で、版は `claude --version` で直接聞ける (kawaz 実測)
- 案: 覚え直した版を `claude_update` の返事と `ping` だけで渡し、push しない
  - 不採用理由: 別のタブ・端末の GLOBALS が、再接続までは update の前の版を出し続ける (kawaz 2026-10-28: 全タブへ push する)
- 案: 覚え直した版を `ev: "agents"` の push に載せる
  - 不採用理由: agents の行はプロセスごとの記録で、ホストの binary の版は性格が違う。update で agents の行は変わらないので、push を起こす契機も合わない

## Consequences

- Status タブから daemon の版の行 (`.status-daemon-version`) が消える。Status タブはセッションに属するものだけになる
- サイドバーの一覧の段は、1 本の縦スクロールから区画ごとのスクロールに変わる
- 縦積み (フォームが上・一覧が下) の時の一覧の既定の高さ (`SIDEBAR_LIST_DEFAULT_PX` = 220px) は「一覧の上端から 1 行目まで 75px」の実測を根拠にしているが、見出しが 3 つ (SESSIONS・ROOMS・GLOBALS) 並ぶと 1 行目までが変わり、見える行が減る。実装の時に測り直す
- リンクの名前は設定の並びで決まる、が明文になる。tailscale serve の自動許可は file の Origin より前に並ぶので、tailscale serve が動いている間は file の Origin をリンクの名前にできない (`CCMSG_HTTP_ALLOW_ORIGIN` は env なので先頭に置けるが、env を持たずに daemon が起こし直されると消える、`origins-file.ts` の冒頭)
- protocol は op `claude_update` が 1 つ、`ping` の返事の optional の field が 2 つ (`webui_urls`、`claude_version`)、stream event が 1 つ (`ev: "claude_version"`) 増える。知らない client は field を落とす (`v.object`)
- daemon に「ホストの Claude Code の binary を更新する」能力が入る。user role 限定で、走っているプロセスには触らない。上がった binary が効くのは、以後に起動するセッション
- 自作コンポーネントカタログ ([DR-0031](./DR-0031-webui-design-tokens-and-catalog.md)) に `SidebarFold` の見本を足す
- 「持たない」ことを壊す変更を止める試験の観点:
  - 見出しのボタンを押しても区画の開閉が変わらない (SESSIONS の 4 つのボタンそれぞれ)
  - 開閉の要素の子孫に button / a / input が無い
  - 初期表示で SESSIONS だけが開いている。開閉を変えて再読み込みしても初期表示に戻る
  - `webui_url` が候補の一覧の先頭と常に同じ (loopback だけ・空・重複・file のみ、の各場合)
  - 候補に loopback と http(s) 以外が入らない
  - 切り替えで path・query・hash が変わらず origin だけが変わる
  - `claude_update` は user role 以外を断る
  - 覚え直す版は `claude --version` の先頭の語から取り、`claude update` の出力を読まない (update が版らしい文を出しても、`--version` の値が使われる)
  - 覚え直した版は `ev: "claude_version"` で、押していないタブにも届く
  - 出す版は最大でなく、後に観測した方 (最後に起動したセッション / 覚え直した時刻)

## 関連

- [DR-0020](./DR-0020-session-status-tab.md) — Status タブ。Addendum 2026-10-25 のプロセスの版
- [DR-0028](./DR-0028-session-kill.md) — セッションの終了・再起動は Status タブの危険ゾーンに置く
- [DR-0039](./DR-0039-all-mods-and-typed-tools.md) §5 — `ccmsg_url` (= `webui_url`)
- [DR-0005](./DR-0005-webui-frontend-architecture.md) — webui のコンポーネントの器
- [DR-0031](./DR-0031-webui-design-tokens-and-catalog.md) — 自作コンポーネントカタログ
- [runbook device-access-path](../runbooks/device-access-path.md) — 端末ごとの繋ぎ先
- [webui-url-grammar](../design/webui-url-grammar.md) — URL が画面の状態の正本
