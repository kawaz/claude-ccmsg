# DR-0043: サイドバーを開閉できる区画 (SESSIONS / ROOMS / GLOBALS) の列にし、GLOBALS に繋ぎ先の切り替え・版・Claude Code の更新を置く

- Status: Accepted (2026-10-28、kawaz 裁定) — ✅ 実装済み (§1〜§5 のサイドバーの区画の列 (`SidebarFold`) と GLOBALS、§6 の op `claude_update`、§7 の `webuiUrlsOf`、§8 の `ping` の `webui_urls` / `claude_version` と `ev: "claude_version"`、§9 の SESSIONS のクイックフィルタ、§10 の SESSIONS の owner → 組の木、§11 のセッションのブックマーク、§12 の Errors / Waiting)
- Date: 2026-10-28

## Context

webui の画面全体に効く情報と操作の置き場が無い。スマホではグローバルヘッダに足す余地が無く、daemon の版はセッションごとの Status タブの最下部に置かれている。セッションに属さない情報が、セッションを開かないと見えない場所にある。

もう 1 つの要求は端末ごとの繋ぎ先の切り替え。iPhone / iPad は IPv6 だけの名前 (`ccmsg.v6-kawaz-mbp.kawaz.jp`) で繋ぎ、Mac は従来の IPv4 の名前で繋ぐ運用をしている ([runbook device-access-path](../runbooks/device-access-path.md))。エージェントが書くリンク (`ccmsg_url`) は IPv4 側の名前なので、iPhone でリンクを開くと IPv4 の経路に戻り、そこから v6 の名前へ移る口が webui に無い。

### 読んで分かった前提 (既存コード)

- サイドバーは `Sidebar.tsx` の `#sidebar-lists` に `#sessions-panel` (`<h2>` に Sessions の文字と、+New・🔍・並び順・↻ のボタンが入る) と `#rooms-panel` が縦に並び、`#sidebar-lists` 全体が 1 つの縦スクロールを持つ (app.css の `#sidebar-lists, #sidebar-form` の規則)
- ROOMS は既に閉じた状態で始まる `Fold` (`<details>`) で、開いた時に room の一覧を取る (`RoomList.tsx`)。`Fold.tsx` はこの UI の開閉部品の共通形で、`<details>` / `<summary>` をブラウザに任せる。SessionList の中の Errors / Waiting / Bookmarks の区分 (`.session-section`) も `Fold`
- Status タブに出ている版は最下部の `daemon v<version>` の 1 行だけ (`StatusPanel.tsx` の `.status-daemon-version`)。値は webui が接続のたびに送る `ping` の返事の `version` (`ws.ts` の handshake の最後、store の `daemonInfo`)
- Claude Code の版は、セッションごとのプロセスの版 (agents の行の optional の `version`、[DR-0020](./DR-0020-session-status-tab.md) Addendum 2026-10-25) として agents の行にある。TL 下ミニパネルの ctx 行の末尾にはそのセッションのプロセスの版として出し (`utils.ts` の `sessionRuntimeParts`)、Status タブには出さない。agents の行はプロセスの起動の時刻 `startedAt` も持つ
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
- GLOBALS の開閉の状態は sessionStorage (`ccmsg.sidebarFold.sidebar-globals`、値は `open` / `closed`) に覚え、その窓の再読み込みでは最後の状態で始まる (kawaz 2026-11-10: この程度の高さなら PC では開いたままにしたく、スマホでは閉じておくことが多い)。窓ごとの状態なので localStorage には書かず、まだ切り替えていない窓は初期表示 (閉じる) から始まる。SESSIONS と ROOMS の開閉の状態は保存せず、窓を開くたび・再読み込みのたびに初期表示から始まる。Status タブの ENV の fold ([DR-0020](./DR-0020-session-status-tab.md) Addendum 2026-11-09) と ROOMS の fold も保存しておらず、URL の文法も fold の開閉を載せない ([webui-url-grammar](../design/webui-url-grammar.md))
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
- 名前の根拠: この UI では開閉する区画を一貫して fold と呼ぶ (`Fold.tsx`、`fold-open-store.ts`、Status タブの ENV の fold)。WAI-ARIA APG の語では、サイドバーの列が Accordion (見出しの中の button + region、複数同時に開いてよい)、各区画が Disclosure に当たる
- 開閉の部品は `Fold` (`<details>`、見出しにボタンを持たない) と `SidebarFold` (見出しにボタン群を持てる) の 2 種類になる。使い分けをそれぞれの doc comment に書く

### 4. 上に付く区画と下に付く区画はサイドバーのレイアウトで決める

- 「上に付く / 下に付く」は区画の部品の prop にせず、サイドバーの CSS で決める。一覧の段を `display: flex; flex-direction: column` にし、SESSIONS と ROOMS は上から並び、GLOBALS は `margin-top: auto` で下端に付く
- 開いている区画の本体が、見出しの残りの高さを分け合う。本体はそれぞれ自分の縦スクロールを持つ (`min-height: 0` + `overflow-y: auto`)。段全体の 1 本のスクロールにはしない (長い SESSIONS が GLOBALS を画面の外へ押し出さないため)
- 高さを分け合うのは一覧の区画 (SESSIONS・ROOMS) だけにし、GLOBALS の本体は中身の高さだけを取る。GLOBALS の中身は数行で伸びる必要が無く、分け合うと一覧の行が減るだけになる。これもサイドバーの CSS で区画の id を名指して決め、部品の prop にはしない

### 5. GLOBALS に置くもの

#### 5.1 繋ぎ先 (endpoint) の表示と切り替え

- `endpoint: [ccmsg.v6-kawaz-mbp.kawaz.jp ▾]` の 1 行。今このページを開いている origin を表示し、選ぶと別の名前の origin へ移る
- 候補は §7 の一覧。今の origin が候補に無い時 (daemon の bind を直接開いた loopback 等) も、今の origin を選択中の項目として出す
- 部品は素の `<select>`。スマホでは OS の選択 UI が出る。表示は host (`URL.host`)、`https:` 以外の候補だけ scheme を添える。今の origin のほかに候補が無ければ、選ぶ部品にせず文字だけを出す
- 切り替えは、今の URL の origin だけを選んだ候補に差し替えて別の origin へ遷移するだけ (`location.assign`)。path・query・hash はそのまま運ぶ: URL が画面の状態の正本なので ([webui-url-grammar](../design/webui-url-grammar.md)、`sb.*` のサイドバーのフォームを含む)、移った先でも同じ画面になる
- origin ごとの localStorage / sessionStorage (下書き・ブックマーク・並び順・ペインの寸法) は引き継がない。origin で閉じているものはそれで正しい
- 今の origin と同じ候補を選んでも遷移しない

#### 5.2 daemon の版

- `daemon v<version>` の 1 行。値は今と同じ `ping` の返事の `version` (store の `daemonInfo`)
- 版は ccmsg の CHANGELOG のその版の節を新しいタブで開くリンク ([DR-0048](./DR-0048-changelog-and-version-links.md) §5)
- Status タブから移す。Status タブの最下部の行は消し、2 か所に出さない

#### 5.3 Claude Code の版と更新

- `claude v<version> [↻]` の 1 行。出す版は **最後に起動したセッションのプロセスの版** (agents の行のうち `startedAt` が最も新しく `version` を持つ行の `version`)。版の最大は取らない: 自動更新が有効なら新しいセッションは起動の時に最新へ上がるので、最後に起動したセッションの版がこのホストの今の版を言う
- 版は Claude Code の CHANGELOG のその版の節を新しいタブで開くリンク ([DR-0048](./DR-0048-changelog-and-version-links.md) §5)
- 版の横にリロードのアイコンボタンを置く。押すと daemon が `claude update` を実行する (§6)。`claude` は daemon の PATH のもの。`claude update` の結果は `claude --version` の実測で見る。binary は上がるが、走っているプロセスには再起動 ([DR-0028](./DR-0028-session-kill.md) の restart) まで効かない
- `claude update` が終わったら、daemon は `claude --version` を実行し直して版を覚え直し、表示にはその版を使う。`claude update` の出力は解釈しない (kawaz 実測)。`claude --version` の出力は先頭の版の語だけを読む (`2.1.312 (Claude Code)` → `2.1.312`)
- 2 つの源の組み合わせは「後に観測した方が勝つ」: 最後に起動したセッションの `startedAt` と、daemon が覚え直した時刻 (§8 の `observed_at`) を比べ、新しい方の版を出す。update の後に起動したセッションがあれば、その版が出る。どちらも無ければ (走っているセッションが無く、update もしていない) 行は `claude —` とボタンだけにする
- 失敗した時は、`claude update` (または `claude --version`) の stderr の要点 (空でない末尾の行を 1〜2 行、長ければ切り詰める) を GLOBALS の版の下に短く出す。次の成功で消える。webui の state に持ち、保存しない
- 押している間はボタンを disabled にして「更新中…」を出す。確認のダイアログは出さない (走っているプロセスに影響しない操作なので)

#### 5.4 userscript

- `userscript: none | enabled | disabled [edit]` の 1 行。none は保存なし、enabled / disabled はこのブラウザでの有効 / 無効。中身と op は [DR-0057](./DR-0057-webui-userscript.md) §3

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
- **描画するリンクは今の origin に移す**: webui は描画する `<a href>` の origin が一覧のうち今の origin 以外の名前なら、origin だけを今の origin に差し替える (path・query・hash はそのまま、表示の text は変えない)。エージェントが書く `ccmsg_url` は一覧の先頭を指すが、別の名前で開いている端末からは先頭に届かないことがあるため ([device-access-path](../runbooks/device-access-path.md))。一覧に無い origin には触れず、一覧が届く前 (`ping` の返事の前) は何もしない

### 8. daemon から webui への渡し方

- **`ping` の返事に `webui_urls: string[]` (optional) を足す**。中身は §7 の一覧で、`webui_url` はその先頭と同じ値。名前を `webui_urls` にするのは、`webui_url` との関係 (その先頭) を名前で示すため。値は `webui_url` と同じく origin (`scheme://host[:port]`)。webui は handshake の最後で既に `ping` を呼んで `daemonInfo` を取っているので往復は増えない。`ccmsg status` の出力にも並ぶので、人が CLI で確かめられる
- **`ping` の返事に `claude_version: { version, observed_at }` (optional) を足す**。daemon が覚え直した版と時刻で、覚えていなければ無し。`observed_at` は daemon の時計の epoch ms (agents の行の `startedAt` と同じ単位)。接続した時点の値をこれで受け取る
- **覚え直した時に全タブへ push する**: `ev: "claude_version"` (`{ ev, version, observed_at }`)。`ev: "llm_status"` と同じく user role の購読者向け。押したタブも他のタブ・他の端末も、これで揃って表示が変わる。押したタブは `claude_update` の返事でも変わる (同じ値)
- `ping` は user role 以外 (CLI・session role) にも答える。返事には既に `httpAllow` 等の設定由来の値があり、Origin の一覧と Claude Code の版はホストの設定と状態を並べるだけなので、出してよい
- [DR-0039](./DR-0039-all-mods-and-typed-tools.md) の tool の規約は MCP tool の話で、webui の wire には直接かからない

### 9. SESSIONS のクイックフィルタ

セッションが増えると、一覧の中から目当ての行を探すのに時間がかかる (kawaz 2026-11-21: Files タブにあるようなクイックフィルタが欲しい)。Files タブのファイル名検索と同じ操作感・同じ一致の仕方で、SESSIONS の行を絞り込む。

- **置き場**: SESSIONS の区画の本体の一番上 (`.session-filter`、`#session-list` の前の兄弟)。見出しの行には足さない (+New・🔍・並び順・↻ で詰まっている)。本体の縦スクロールに対して上端に貼り付き (`position: sticky`)、一覧を下まで読んでも入力欄は見えたまま。`#session-list` の外に置くので、行と一緒に横スクロールされない
- **入力欄**: `type="search"` の 1 行で、幅は本体の全幅。placeholder は `Filter sessions by name`、aria-label は「セッションを名前で絞り込む (空白区切りで AND、-語 で除外)」。🔍 の Session Search ([DR-0021](./DR-0021-session-search.md)、transcript の中身の検索) とは別物で、placeholder が「名前で絞る」ことを言う
- **一致の仕方**: Files の検索と同じ文法を同じ parser (`parseFileSearchQuery`) で読む。空白区切りの語を AND、大文字小文字を区別しない部分一致、`-語` で除外、`+語` は語をそのまま (先頭の `-` / `+` を文字として探す)
- **一致の対象**: 行が自分を名乗る文字。セッション名 (行の 2 行目、無ければ cwd の末尾・sid の先頭)、repository (`owner/name`)、workspace、branch、cwd、sid の先頭 8 文字。どれか 1 つの中に語があれば当たり。語はフィールドをまたがない (2 語が別々のフィールドに当たるのはよい)
  - sid と cwd は行に出ている分だけを見る。sid は先頭 8 文字、cwd は repo も ws も無い行 (cwd を 4 行目に出す行) でだけ見る。見えない部分だけに当たって残った行は、なぜ残ったかが画面から分からない。cwd は同じ置き場 (`…/repos/github.com/<owner>/`) の下で長い先頭を共有するので、そこの語 (`github` 等) でほぼ全部の行が残ってしまう
  - branch は workspace を出している行でも見る。ws の表示は workspace が無ければ branch に落ちる (`peerWorkspaceLabel`) ので行に出うる語で、名前の具体さも workspace と同じ
  - Bookmarks の行は行に出す repo/ws (`sessionBookmarkLabel`、繋がっていれば live の値) と、繋がっている間は branch を見る
- **除外だけの語**: `-語` だけの入力は「その語を含まない行を全部残す」。Files は除外だけの入力で何も出さない (含める語の無い走査はリポ全体の列挙になり、上限で切れるため)。SESSIONS の行は既に全部手元にあるので、その理由が無い
- **区画の見せ方**: 絞り込み中は Errors・Waiting・Bookmarks・owner の木のどれも一致した行だけを出し、見出しの件数は一致した数にする。Bookmarks の件数はブックマーク (ディレクトリ) の数で、一致した行が残っているものを数える。一致が 0 の区画と fold は出さない (Files の検索が当たりの無いグループを出さないのと同じ)。どこにも残らなければ「該当なし」の 1 行を出す
- **キー操作**: Esc で入力欄を空にする (blur はしない)。Files と同じく、隠している原因が入力の文字なので「絞り込みをやめる」と「空にする」は同じ意図。入力のたびにすぐ絞り込む (debounce しない。Files の debounce は daemon の走査を起こすためで、手元の照合には要らない)
- **状態**: 入力の文字は SessionList の component の state で、URL にも storage にも書かない。リロードで消える。行を押して別のセッションへ移っても消えない (Files の入力はセッションの切り替えで消えるが、SESSIONS の一覧はセッションに属さないので切り替えの単位が無い)
- **語の保存** (kawaz 2026-11-24): よく使う語を保存しておき、押すだけで入力欄に入れられる。SESSIONS のクイックフィルタと Files のファイル名検索 (Files のツリーの上の入力欄) に同じ部品 (`FilterField`) で付く
  - **保存の操作**: ⌘Enter (Ctrl+Enter も同じ。入力欄の送信のキーと同じ判定) か、入力欄の中の save のピル。保存するのは入力の両端の空白を除いた語で、空 (空白だけ) と既に保存してある語は足さない。IME の変換中の Enter は保存にしない。入力のたびにすぐ絞り込むのは今のまま
  - **save のピル**: 入力があり、まだ保存していない語の時だけ、入力欄の枠の中の × (入力を消す) の左に出す。見える文言は `save`。× はブラウザ標準の検索欄の × を消して自前で描く (標準の × は input の中にエンジンごとの幅で描かれ、外の要素をその左に揃えられない)。× は入力を空にし、Esc と同じ
  - **保存した語の並び**: 入力欄の下に、保存した順で小さい字のピルを折り返して並べる。ピルは語のボタンと × のボタンの 2 つで、語を押すと入力欄にその語が入って入力と同じ経路で絞り込みが効き、× を押すと一覧から消える (入力欄の中身は変えない)。いまの入力 (両端の空白を除く) と同じ語のピルは、入り切りのピルの「入」と同じアクセントの地で示す (`aria-current`)。長い語は省略し、全文を title に出す
  - **支援技術とキーボード**: 語と × は別々のボタンで、名前は「<語> で絞り込む」(Files は「<語> で検索する」) と「<語> を保存から消す」。save は「<語> を保存」、入力欄の × は「入力を消す」。どれも Tab で届き Enter / Space で押せる。キーボードで押して消えるボタン (save と ×) の後は、フォーカスを入力欄に戻す
  - **フォーカス**: 入力欄にフォーカスがある時に save・×・保存した語を押しても、押し始めの既定の動きを止めてフォーカスを入力欄に残す (入力の箱のピルと同じ考え、DR-0062 §3)。スマホのソフトキーボードがしまわれない
  - **保存先**: localStorage の内容 (`storage.ts` の表)。SESSIONS は `ccmsg.sessionList.savedFilters`、Files は `ccmsg.fileSearch.savedFilters` で、Files の一覧はセッションごとでなく全体で 1 つ。値は語の JSON 配列で、valibot のスキーマで読み、配列でない・語でない値は空の一覧として扱う (同じ語・空の語は読む時に除く)。ページの中では一覧を 1 つ持ち、同じ一覧を見るどの入力欄 (残しているセッションの画面ごとの Files) にも同時に映す。保存と削除は localStorage の今の値から作り直して書くので、別のタブ・ウィンドウで足した語を消さない。別のタブの変化はこのページの次の保存・削除かリロードで映り、`storage` event では追わない (SESSIONS の fold の開閉と同じ)

### 10. SESSIONS のセッションを owner → 組 (接頭辞 / repo) → セッションの 1 本の木にする

同じ owner・同じ repo のセッションが散らばって並ぶと、目当ての repo の行を探しにくい (kawaz 2026-11-21: owner/repo でフォルディングしたい)。

- **木の形**: SESSIONS のすべてのセッションを、Bookmarks の区画 (§11) の下の 1 本の木に、owner の fold → 組 → セッションの行の 3 段で並べる。fold するのは owner と `others` だけで、組は開閉しない (下の「組の見出しは開閉しない」)。状態 (応答中・待機・module の有無・ccmsg の接続・transcript の有無) で区画を分けない (kawaz 2026-11-21: Active じゃないセッションも claude agents --json に出てくれば補足できるので、Active の段の意味が無い)。人の対応が要る状態だけを、木の上の Errors / Waiting に重ねて出す (§12)。owner と repo 名は repository の `owner/name` を最後の `/` で分けたもの (owner に `/` を含む GitLab の group もそのまま owner になる)
- **組 (owner の下の段)**: 接頭辞の組か repo の組のどちらか。中はどちらもセッションの行を平らに並べ、常に出す (開閉しない。kawaz 2026-11-21、2026-11-23)
  - repo 名の接頭辞を `^(\w+)(-|$)` の 1 つ目の括弧とする (`\w` は ASCII の英数字と `_`)。最初の `-` の手前の語で、`-` が無ければ名前全体。この形に当たらない名前 (`.github`、`foo.bar`) は接頭辞を持たない
  - 同じ owner の中で同じ接頭辞を持つ repo が 2 つ以上あれば、それらの repo のセッションは全部、接頭辞を名前にした「接頭辞の組」に入る。接頭辞の組は repo の組より優先し、その中に repo ごとの組は作らない (同じ repo のセッションが 2 つ以上あっても)
  - それ以外の repo (接頭辞を共有する別の repo が無い、接頭辞を持たない) は、repo 名を名前にした「repo の組」
  - 例: `sockat` / `sockat-go` / `sockat-py` / `sockat-rs` → 組 `sockat`。`claude-ccmsg` と `claude-rules-personal` → 組 `claude`。`hyoui` だけ → 組 `hyoui` (repo の組)。`ab` と `abc` → 接頭辞が違うので別々の repo の組。`sockat-go` だけ (セッションが 2 つでも) → 組 `sockat-go` (repo の組)。別の owner の `claude-x` と `claude-y` → 組にならない
  - 接頭辞の組の中の行は、1 行目の `repo@ws` で repo が分かる。repo の組の中の行は見出しが repo 名なので、1 行目に repo を出さない (下の「木の中の行」)
  - 絞り込み中 (§9) は残った行だけで組を決める。一致した repo が 1 つだけになった接頭辞は、その間 repo の組として出る
- **見出し**: owner の見出しは名前と、その owner のセッションの数を区画の見出しと同じ形 (`kawaz (12)`) で出す。組の見出しは名前だけ (kawaz 2026-11-21: owner にはカウント、repo 単位は不要)。ただしセッションが 1 つだけの repo の組は、そのセッションに ws があれば見出しを `claude-ccmsg @main` の形にし、`@ws` は行の 1 行目の ws と同じ見た目 (@ ごと別色) で出す (kawaz 2026-11-21: 1 個だと行の 1 行目が main ばかりになる)。ws が無ければ名前だけ。owner・組・`others` の見出しは普通の文字色で、文字の大きさと太さは行の 1 行目の repo 名と同じにする (kawaz 2026-11-21: 見た目の強さは元の owner/repo と同じ)。Errors・Waiting・Bookmarks の見出しは区分の見出しで、それぞれの色 (Errors は danger、Waiting は warn、Bookmarks は弱い色) で出す。owner・組は区分ではなく中身の名前なので、区分の見出しの弱い色にしない (kawaz 2026-11-21)。木の段の区別は字下げと開閉の印で付け、色や太さでは付けない
- **組の見出しは開閉しない**: 組の見出しは開閉の操作でも印 (▶ / ▼) でもなく、中のセッションの行は常に出る。開閉の状態は持たず、保存もしない。組の見出しを押した時の振る舞いは中身の数で決まる (kawaz 2026-11-23: repo 層のグルーピングは fold できなくする、repo の子が 1 つならグループのクリックは子に伝える)
  - **子が 1 つの組**: 見出しはその 1 つのセッションの行の `<a>` と同じ href (`sessionHref`) の link で、押すとその行を押した時と同じ遷移になる (修飾キー付きや中クリックで新しいタブに開けるのも同じ)。同じ行き先の Tab の止まりが 2 つにならないよう、見出しの link は `tabindex="-1"` にして Tab の対象を行の link だけにする (見出しは link として読み上げに残り、名前は見出しの文字 `repo @ws`)。押せることは cursor: pointer と hover の地 (`--surface-hover`) で示す
  - **子が 2 つ以上の組**: 押しても何も起きない。cursor も hover の色も付けず、操作に見えない普通の行にする
- **選択中のセッションの見出し**: 選択中のセッションを含む owner と組 (接頭辞の組・repo の組・`others`) の見出しに、淡い accent の地 (`--accent-surface`) を敷く (kawaz 2026-11-21: 選択セッションの親の repo と owner のグループは少しだけ目立つように)。行の選択中の塗り (accent の面) より明らかに弱く、文字色は変えない (組の見出しの `@ws` が accent の文字なので、文字色で印を付けると `@ws` と見分けが付かない)。閉じている owner・`others` の見出しにも付くので、閉じた中に選択中のセッションがあることが分かる。Errors・Waiting・Bookmarks の見出しには付けない。印は描画のたびに選択 (`currentSid`) から導き、開閉の状態には触らない
- **閉じた見出しの 🔔🔐**: owner・`others` の fold が閉じている間、見出しの名前の右に、中のセッションの未読の say (🔔) と許可依頼 (🔐) の数の合計を出す。部品と決まりは行のバッジと同じ (絵文字と数のバッジ、0 の種類は出さない、`rowBadgeKinds`)。開いている間は出さない (中の行が自分のバッジを出す)。見出しの中のバッジは link にせず (見出しは開閉の button で、その中に別の操作を置かない)、押すと見出しの開閉になる。絞り込み中は一致した行の分だけを合計する。合計は見出しに常に置き、開いている間は CSS (`details[open] > summary > .session-tree-badges`) で隠す。出し分けを要素の開閉に任せるので、開閉で何も描き直さない (下の「開閉は要素が持つ」)
- **repository の無いセッション**: 1 つの組 `others` にまとめ、owner と同じ段の、並べ替えにかかわらず一番下に置く (kawaz 2026-11-21: owner が無いケースは 1 番下に others で)。木に置き場の無いものの受け皿で、owner と並べて競わせるものではないため。見出しには owner と同じく数を出す。中は組の段を挟まずにセッションの行を並べる
- **木の中の行**: 1 行目は見出しが言っていることを繰り返さない (kawaz 2026-11-21: ツリーにした場合、owner 表示は無しにして良さそう / repo 表示もなくて良いな、owner と同じで)
  - owner は外す。接頭辞の組の中の行は `claude-ccmsg@main` の形 (見出しの接頭辞からは repo が分からないので、repo 名は残す)
  - セッションが 2 つ以上の repo の組の中の行は repo 名も外し、ws だけを出す。repo を出さない時の ws は `@` を付けない (`main`)
  - セッションが 1 つだけの repo の組 (ws がある) の行は、見出しが `repo @ws` を言うので repo と ws の行を持たない。1 行目に残る要素 (アイコンと prompt cache の輪・🔔🔐 のバッジ・古いクライアントの印・bg の札・状態の札) はタイトルの行の頭に移り、行は「アイコン + バッジ + タイトル」の行と、経過時間・model/effort・sid の行になる (kawaz 2026-11-21: アイコンは消さない)。形は repo も ws も無い行でタイトルが 1 行目に上がる形と同じ
  - 1 行目に出すものが無くなる行 (repo の組の中で ws の無い行) は、repo も ws も無い行と同じくタイトルを 1 行目に上げ、空の 1 行目を作らない。場所は組の見出しが言うので、project path の行は足さない
  - `others` の中の行は元から repo を持たない
  - 木の外の平らな一覧 (Errors・Waiting・Bookmarks) の行は見出しが owner も repo も言わないので `owner/repo@ws`。クイックフィルタ (§9) の一致の対象は今のまま `owner/name` 全体で、owner や repo の語でも当たる
- **行の段組み**: アイコン (と版の印)・🔔🔐 のバッジは 1 行目の文字の頭に並ぶ普通の要素で、2 行目 (タイトル)・エラー文・3 行目 (経過時間・model/effort・sid)・4 行目 (project path) は行の左端から始める。アイコンだけの列を作って 2 行目以降をその右へ下げることはしない (kawaz 2026-11-21: セッションアイコンだけ飛び出てるデザインも意味わからん)。Errors・Waiting・Bookmarks の行も同じ
- **Bookmarks は木にしない**: 並びは人が決めたもの (更新の新しい順) なので、今のまま平らに並べる
- **並べ替えは層ごとに効く**: 見出しの並べ替え (prompt / name / created / recent) はセッションの行の基準のまま。組は「その組のセッションのうち基準で一番前に来るもの」の位置に、owner は「その owner の組のうち一番前に来るもの」の位置に並ぶ。recent なら owner の中は組の最新の順、組の中は最新の順。実装は並べ替え済みの行を前から見て、owner・組を初めて出た順に置くだけで、層ごとに並べ直さない (並べ替えの基準と木の並びが食い違う余地を作らない)。`others` だけはこの並びに入らず一番下
- **開閉の既定と保存**: owner・`others` の fold は開いて始まる。人が見出しを押して開閉したものを localStorage (`ccmsg.sessionList.folds`、§11) に覚え、別の窓でも再読み込みでもその状態で始まる (kawaz の指定。§1 の区画の開閉は保存しないが、こちらは一覧の中身の畳み方で、storage.ts の分類では「内容」)。鍵は段の種類と名前 (`owner:<owner>`、`others`)。この形でない鍵 (別の形の古い値) はどの fold にも当たらず、読まれないだけで消しも書き換えもしない。owner を閉じても、その中の待機中・エラーのセッションは木の上の Waiting / Errors に出る (§12)
- **開閉は要素が持つ**: fold は現れた時に 1 度だけ、覚えている開閉 (無ければ既定) を読んで `<details>` に渡し、以後の開閉は要素が持つ。一覧の state は開閉に一切ついて行かないので、見出しを押しても (Enter / Space も) 描き直しは起きず、1 回の操作で開閉する。人の開閉は要素の `toggle` の event で localStorage に書く。現れた時の `toggle` は覚えている値 (無ければ既定) と同じなので書かない
- **木・件数・🔔🔐 の合計は行のデータの派生値**: 木 (`sessionTree`)、見出しの件数、各 fold の 🔔🔐 の合計は、行と未読の数が変わった時にだけ作り直す。開閉で変わるのは見せ方だけで、これらは作り直さない
- **時刻で動くのは経過時間だけ**: 行の 3 行目の経過時間は 10 秒ごとに進む。進めるのはその表示だけで、全ての行が 1 本の interval を共有して同じ tick で進む。一覧・行・木は時刻では描き直さない (prompt cache の輪は自分の時刻で書き、窓が閉じる・延命に移る時刻に自分の行だけを描き直す)
- **クイックフィルタ (§9) との関係**: 絞り込み中は残った owner・`others` を全部開いて見せる (残っているものは一致したもの)。この開きは保存せず、絞り込み中に見出しを押しても保存しない。入力を空にすると、覚えている開閉に戻る。絞り込みの始まりと終わりで木と Bookmarks の fold を作り直し、現れた時の開閉 (絞り込み中は開く、それ以外は覚えている値) から始めることで、絞り込み中に閉じた fold も覚えている開閉に戻る。絞り込み中の owner と `others` の数は一致した行の数
- **字下げ**: 木の中身は 1 段ごとに行の左右の余白と同じ量 (`--space-8`) だけ下げる。390px で崩れないことだけを確かめ、詰め方の工夫は触ってから決める (kawaz 2026-11-21)

### 11. セッションのブックマーク (SESSIONS の Bookmarks)

セッションをディレクトリごとに覚えておく機能 ([DR-0021](./DR-0021-session-search.md) §2.4 / §3.2) を「ブックマーク」と呼び、SESSIONS の区画「Bookmarks」(Errors / Waiting (§12) の下、owner の木の上) に置く (kawaz 2026-11-21: pin がここだけ bookmark じゃないの意味ないので bookmark に)。

- **用途**: 終わったセッションを後で起こして再開するための置き場。issue ごとにセッションを立てて調査し、相手の返事が来るまでは置いておき、数日後に反応があったら調査した時のコンテキストを持つセッションを起こして続ける (kawaz 2026-11-21)
- **区画**: 見出し `Bookmarks (N)` の fold (N はブックマークしたディレクトリの数)。0 件でも見出しを出し、中には何も出さない (kawaz 2026-11-21: 横の (0) と ▶︎▼ で空だと分かる)。中の並べ方と行の形は今のまま (平ら、`owner/repo@ws`)。走っているブックマークのセッションは下の木にも出る
- **既定で閉じる**: 常時開いていると、今動いているセッションを探す時に邪魔になる (kawaz: 常時出てると邪魔)。開くのは置いたセッションを起こしに行く時だけ。人が開閉した状態は §10 の fold と同じ保存 (下) に `bookmarks` の鍵で覚える
- **閉じた見出しの 🔔🔐**: §10 と同じく、閉じている間は中のセッションの未読の合計を出す (同じ部品)
- **クイックフィルタ (§9)**: 絞り込み中は一致があれば開いて見せ、一致が無ければ区画ごと出さない (他の区画と同じ)。覚えた開閉は書き換えない
- **語と名前**: 画面の語は「ブックマーク」(TL の項目の ⭐ と同じ語、見出しは `Bookmarks`、☆⭐ の aria-label は「ブックマーク」「ブックマーク解除」)。コードではセッション単位のものに `session` を付け (`SessionBookmark`、`sessionBookmarkRows`、`session-bookmarks.ts`、`.session-bookmarks-section`、store の `sessionBookmarks` と action `session-bookmarks/*`)、TL の項目のブックマーク ([DR-0058](./DR-0058-timeline-bookmarks.md)) は今の無印の名前 (`bookmark`、`BookmarkRow`、`listed-bookmarks.ts`) のまま。無印を項目の側にするのは、DR-0058 が既にその名前で protocol と daemon に入っているため (セッションのブックマークは webui の中だけのもの)。protocol の 1 セッション分の項目のブックマークの型は `SessionItemBookmarks` に改め、セッションのブックマークと名前で紛れないようにする (型の名前だけで wire は変わらない)
- **保存先の移し替え**: 保存は webui の localStorage だけ (daemon・wire に持たない)。key は `ccmsg.pinnedSessions` (`{ v: 1, pins }`、または検索ヒットの配列) から `ccmsg.sessionBookmarks` (`{ v: 1, bookmarks }`) に移す。起動の時に 1 度、古い key を読んで新しい key に書き、古い key を消す。新しい key に既にあればそちらを残して古い key だけ消す。古い key の値がどの形でも読めなければ残して console に出す (消すと後で読む手が無くなる)
- **fold の開閉の保存**: §10 の木の fold とこの区画の開閉は、localStorage の `ccmsg.sessionList.folds` (fold の鍵 → 開いているか) に覚える。触っていない fold は既定 (木は開く、Bookmarks は閉じる) に従う

### 12. 人の対応が要るセッションを木の上の Errors / Waiting に重ねて出す

状態で区画を分けるのをやめた (§10) 後も、人の対応を待って止まっているセッションは木の中に埋もれさせず、一番上で目に入るようにする (kawaz 2026-11-21)。

- **並び**: SESSIONS の本体は上から `Errors (n)`、`Waiting (n)`、`Bookmarks (n)` (§11)、owner の木 (§10)、`others`
- **中身**: `Errors` は harness の API エラーで turn が止まったセッション、`Waiting` は Claude Code が人の操作を待つダイアログを出しているセッション (`sessionStatus` の `error` / `waiting`)。中は木にせず、一覧の並べ替えの順に平らに並べる。行の形は Bookmarks と同じく `owner/repo@ws` (§10「木の中の行」)
- **重複して出す**: これらの行は木の中にも同じ行が出る。Errors / Waiting は木の行を取り出した写しで、木の並びを変えない
- **出し方**: 0 件なら見出しごと出さない。1 件以上になって現れた時は開いて出す。出ている間に人が閉じるのは自由で、その開閉は覚えない (localStorage に書かない)。次に 0 件から 1 件以上になって現れた時はまた開いて出る。§10・§11 の fold と違って覚えないのは、ここが「今対応が要るもの」を知らせる場所で、前に閉じたことで新しく止まったセッションが隠れてはいけないため
- **行の印**: 待機中の行は時々跳ねる動き (reduced-motion では止める)、エラーの行は停止理由の文 (danger の色) を出す。どちらも行そのものに付け、Errors / Waiting の中でも木の中でも同じ見た目。見出しの色は Errors が danger、Waiting が warn。エラーの行に跳ねる動きを付けないのは、両方が同時に出た時に動きで見分けが付かなくなるため
- **選択中の行**: 同じセッションが Errors / Waiting / Bookmarks と木の両方に出る時、選択中の塗り (accent の面) は木の行だけに付け、上の区画の行は accent の枠線だけにして文字色も変えない (Bookmarks の選択中を枠線だけにする決まりを上の区画に広げたもの)。木が行の本来の置き場で、上の区画は写しのため
- **クイックフィルタ (§9)**: 絞り込み中は一致した行だけで数え、一致が 0 なら出さない

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
  - 不採用理由: Folder は Files タブとワークスペース ([DR-0026](./DR-0026-vscode-workspace-section.md)) のフォルダと、section は SessionList の中の区分 (`.session-section`) と、panel はサイドバーのフォームと衝突する
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
- 案: クイックフィルタの入力欄を SESSIONS の見出しの行に置く
  - 不採用理由: 見出しの行は +New・🔍・並び順・↻ で詰まっていて、390px の幅で入力欄の幅が取れない
- 案: クイックフィルタを fuzzy 一致 (語の文字を順に飛び飛びで当てる) にする
  - 不採用理由: Files の検索と一致の仕方が分かれ、同じ形の入力欄で同じ語が違う意味になる
- 案: 一致が 0 の区画も見出しだけ `(0)` で出す
  - 不採用理由: 読み飛ばす行が増えるだけで、絞り込んだ結果の読みやすさが下がる。今も空の区画は出していない
- 案: 状態別の区画 (Active・No module・ccmsg 未起動・No transcript 等) を残し、それぞれの中に owner の木を置く
  - 不採用理由: 同じ owner・repo のセッションが状態ごとの木に分かれ、目当ての repo を探す場所が状態の数だけ増える。応答中かどうか等は行の live dot と経過時間が言い、区画にする意味が無い (kawaz 2026-11-21)
- 案: Errors / Waiting の行を木から外す (重複させない)
  - 不採用理由: 状態が変わるたびに行が木の中の位置から消えたり戻ったりし、repo の中で探す時の置き場が定まらない
- 案: Errors / Waiting の開閉を他の fold と同じく localStorage に覚える
  - 不採用理由: 一度閉じると、後で新しく止まったセッションも閉じた中に隠れる。ここは今対応が要るものを知らせる場所
- 案: 開閉を一覧の state に持ち、見出しの click で state を変えて保存し、`open` をその state から渡す
  - 不採用理由: click の中で state を変えると、描き直しが microtask でブラウザの開閉より先に走って `open` を書き、続くブラウザの開閉がそれを打ち消す (実ブラウザの操作で 1 回目が効かない。script の `click()` や happy-dom では起きない)。さらに 1 回の開閉で一覧全体 (セッション 200 で約 1300 component) を描き直す
- 案: 閉じた見出しの 🔔🔐 を行のバッジと同じく TL のフィルタへの link にする
  - 不採用理由: 見出しは開閉の button で、その中の link は入れ子の操作になる (§2 と同じ理由)。合計は複数のセッションにまたがり、行き先のセッションも 1 つに決まらない
- 案: owner / repo の並びを層ごとに基準で並べ直す
  - 不採用理由: 並べ替え済みの行を初めて出た順にまとめれば同じ並びになり、並べ直しの比較を層ごとに持つと基準と木の並びが食い違う余地が増える

## Consequences

- Status タブから daemon の版の行 (`.status-daemon-version`) が消える。Status タブはセッションに属するものだけになる
- サイドバーの一覧の段は、1 本の縦スクロールから区画ごとのスクロールに変わる
- 縦積み (フォームが上・一覧が下) の時の一覧の既定の高さ (`SIDEBAR_LIST_DEFAULT_PX`) は 292px。ROOMS と GLOBALS の見出しが SESSIONS の本体の下に並ぶぶん、行が 2 本見えて 3 本目が覗く高さが区画の列の前より高い (390x844 の実測: 一覧の上端から 1 行目まで 71px、行のピッチ 59px、SESSIONS の本体の下に 80px、[findings](../findings/2026-10-28-dr-0043-verify.md))
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
  - クイックフィルタの入力欄は `#session-list` の外にあり、空の入力では一覧が絞り込み無しと同じになる
  - 見えている sid の先頭 8 文字の外 (後半) だけに当たる語、repo か ws を出している行の cwd だけに当たる語では行が残らない
  - Esc で入力が空になり、全ての行が戻る
  - 木の並びは並べ替えの基準を層ごとに当てたもの (recent で owner は repo の最新の順、repo はセッションの最新の順)
  - Bookmarks は木にならない
  - セッションが 1 つだけの repo の組は、ws があれば見出しが `repo @ws` で行の 1 行目に repo も ws も無く、ws が無ければ見出しが名前だけ。2 つ以上なら見出しは名前だけで行は ws
  - 選択中のセッションを含む owner・組・`others` の見出しにだけ印が付き、選択を変えると移る。選択の変化で fold の開閉は変わらない
  - 接頭辞の組は同じ owner の中で接頭辞を共有する repo が 2 つ以上の時だけでき、`ab` と `abc` は組にならない
  - 閉じた見出しの 🔔🔐 は中の合計で、0 の種類は出ず、開いている見出しには出ない。link ではない
  - 閉じた owner は再 mount の後も閉じている。組は開閉の印も状態も保存も持たず、中のセッションの行が常に出る。子が 1 つの組の見出しは行と同じ href の link (`tabindex="-1"`)、子が 2 つ以上の組の見出しは押しても何も起きず pointer の cursor も付かない。絞り込みの始まりと終わり、絞り込み中の操作では保存が変わらない。絞り込み中に閉じた fold は、入力を空にすると覚えている開閉に戻る
  - fold の開閉と時刻の tick では、経過時間の表示のほかに何も描き直さない

## 関連

- [DR-0020](./DR-0020-session-status-tab.md) — Status タブ。Addendum 2026-10-25 のプロセスの版
- [DR-0028](./DR-0028-session-kill.md) — セッションの終了・再起動は Status タブの危険ゾーンに置く
- [DR-0039](./DR-0039-all-mods-and-typed-tools.md) §5 — `ccmsg_url` (= `webui_url`)
- [DR-0005](./DR-0005-webui-frontend-architecture.md) — webui のコンポーネントの器
- [DR-0031](./DR-0031-webui-design-tokens-and-catalog.md) — 自作コンポーネントカタログ
- [runbook device-access-path](../runbooks/device-access-path.md) — 端末ごとの繋ぎ先
- [webui-url-grammar](../design/webui-url-grammar.md) — URL が画面の状態の正本
