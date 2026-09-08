# DR-0004: webui アーキテクチャ (HTTP/WS transport + UI)

- **Status**: Accepted (2026-07-10、kawaz レビュー裁定「何でも良い」= 一任により承認)。§4 のクライアント実装方式は [DR-0005](./DR-0005-webui-frontend-architecture.md) が、§5 の locator 記法は [docs/design/webui-url-grammar.md](../design/webui-url-grammar.md) が supersede。§4 の「webui のための protocol 拡張はしない」は実態と乖離しており (webui 専用 op が多数)、v2 では面の分離 ([protocol-v2](../design/protocol-v2.md) §2 の messaging / control) が同じ目的を担う
- **Date**: 2026-07-09
- **Author**: AI agent (一次資料の kawaz 発言に基づく)
- **一次資料**: [docs/research/2026-06-29-kawaz-design-statements.md](../research/2026-06-29-kawaz-design-statements.md) §3, §4 回答 1・3, §7
- **前提 DR**: DR-0001 §7 (transport)・§8 (クライアント 3 種)、DR-0003 (wire protocol)

## 記述規約 (attribution)

DR-0001 と同じ: **[kawaz]** = 一次資料に逐語あり / **[提案]** = エージェント由来 / **[保留]** = 意図的に未決。

## Context

DR-0001 §7 が [保留] にした「HTTP を daemon 内蔵にするか別 bridge プロセスにするか」を含め、webui phase の設計を確定する。制約は DR-0001 で確定済み:

- socket と web は「セキュリティに関しての層」を挟んで**同じプロトコル**を喋る [kawaz]
- bind は 127.0.0.1 + tailscale interface のみ、認証は tailscale 側に委ねる [kawaz] (§3 で「tailscale 経由の到達は serve/reverse proxy が loopback に forward する」形に具体化)
- 言語は bun + hono [kawaz]
- webui は kawaz の直接 UI (= 問題 (5) kawaz 混入コストの解消の仕上げ)。スマホからは tailscale 経由 [kawaz]

## Decision

### 1. HTTP は daemon 内蔵 (別 bridge プロセスにしない) [kawaz 発言に整合]

- 一次資料 §3「ユーザ ui はデーモンプロセスに web api 持たせて、ui 自体は別サブプロジェクトにしても良い」の通り、**web API は daemon プロセスが持つ**。DR-0001 §7 の [保留] はこれで解消
- daemon 内蔵なら supervision (DR-0002) の lifecycle にただ乗りできる

### 2. WS で同一プロトコル、transport 差分は identity pinning に隔離 [提案]

- `Bun.serve` の WebSocket endpoint `/ws` が **UDS と同一の line protocol** (1 メッセージ = 1 JSON、op/イベントの shape も同一) を喋る。API surface の二重化 (REST 変換層) はしない
- **セキュリティ層 = identity pinning**: HTTP/WS 経由の接続は hello の申告に関わらず **role を `user` (u1) に固定**する。AI セッション (role: session) は UDS 経由のみ。daemon が from を刻印する DR-0003 の原則の transport 版
- pinning が成り立つ前提は「`/ws` に到達できる接続 = kawaz 本人のブラウザ」。これを保証するのが §3 の `Origin` 検証で、source IP ではない (source IP は「このマシン自身」までしか絞れず、同じブラウザで開いている他のページを区別できない)
- daemon 内部の seam: `Conn` の write を socket 直書きから transport 非依存の `write(line)` に抽象化する。dispatch / delivery / subscribe は一切 transport を知らない

### 3. HTTP/WS の trust boundary [提案]

**bind**: 既定 `127.0.0.1:8642,[::1]:8642` (loopback のみ)。env `CCMSG_HTTP_BIND` で上書き (カンマ区切りで複数 bind 可)、`off` で無効化。外部 (tailscale 越しのスマホ等) からは tailscale serve や reverse proxy が loopback へ forward する。

**trust boundary = `Origin` 検証**。ブラウザの Same-Origin Policy は WebSocket 接続の確立を止めない (Fetch 仕様上 WS は SOP の対象外) ので、kawaz が任意のページを開いただけで、そのページの JS が `ws://127.0.0.1:8642/ws` に到達できる。接続元 IP はこのマシン自身になるため、ブラウザ由来の接続を「このデーモン自身の webui」に絞れる情報は `Origin` ヘッダだけである。許可する origin:

| origin | 根拠 |
|---|---|
| 各 bind の自己アドレス (`http://127.0.0.1:8642` / `http://[::1]:8642`) | このデーモンが配信したページ |
| bind が loopback のとき、同一ポートの `localhost` / `127.0.0.1` / `[::1]` を相互に許可 | この 3 名のいずれかで到達できる時点で接続元はこのマシン自身。他マシンから偽装するには `/etc/hosts` や DNS を書き換える必要があり、それができる時点で host は侵害済み |
| `CCMSG_HTTP_ALLOW_ORIGIN` (カンマ区切り) で明示追加した origin | reverse proxy 越しの `https://<machine>.<tailnet>.ts.net` 等。運用者の明示 |
| tailscale serve が**この daemon の bind ポート**へ proxy している ts.net hostname (起動時に `tailscale serve status --json` を best-effort で問い合わせ、timeout 1s、失敗は空集合 + ログ 1 行) | その origin を名乗れるページは、tailscale の認証を経てこのマシン自身が TLS 終端して配信したものだけ。proxy 先が別ポート (無関係な serve 設定) なら対象外。同 UID の別プロセスが同じポートを指す serve を仕込む経路は、下記「同 UID 内 trust」の範囲内 |
| `Origin` ヘッダ欠落 | 非ブラウザクライアント (curl・CLI ヘルスチェック・Bun 自身の `WebSocket`/`fetch`) として許可 |

リテラル `"null"` は欠落と**同等に扱わない**: ブラウザが opaque origin (`<iframe sandbox="allow-scripts">` / `file://` / `data:` URL) に対して送る値そのもので、攻撃者ページが検証を回避する手段と区別が付かない。必要なら `CCMSG_HTTP_ALLOW_ORIGIN` に明示追加する。

**source-IP allowlist**: 既定 `127.0.0.0/8,::1`、env `CCMSG_HTTP_ALLOW` で上書き (カンマ区切り CIDR/IP)。allowlist 外の source IP は fetch (WS upgrade 前を含む) で 403、判定不能 (`requestIP` が null 等) も拒否側に倒す。これは `CCMSG_HTTP_BIND` を loopback 外に広げた誤設定に対する defense-in-depth であって、trust boundary ではない。

**hello 不要 op** (`shutdown` / `rooms` / `read` / `peers`) は HTTP/WS でもそのまま到達できる。到達できる接続が `Origin` 検証で本人に絞られている以上、hello 必須化に追加の防御効果はない。`shutdown` は `ccmsg daemon stop` が hello なしで送る正当な経路でもある。

**責務外 — 同 UID 内 trust**: UDS の access control は OS のファイル権限 (`0o600`) が担う。同 UID の任意プロセスが `role: "user"` を名乗る (u1 になる)、他セッションの sid を騙る、この daemon のポートを指す serve 設定を仕込む — いずれも「同 UID でプロセスを走らせられる攻撃者」で、ローカル侵入済みの前提に立つため本 DR では扱わない。本 DR の trust model が対象にするのはブラウザ由来の脅威 (HTTP/WS transport) のみ。

`ccmsg status` / `ping` 応答に http bind + allowlist 情報を出す (observability、DR-0002 §7 の延長)。

### 4. UI は packages/webui、ビルドステップなし [提案]

- **hono** app を `packages/webui` が export し、daemon の HTTP handler が `/ws` 以外を mount する (UI の責務分離。kawaz の「ui 自体は別サブプロジェクトにしても良い」の monorepo 内実現)
- クライアント実装方式 (フレームワーク・トランスパイル) は DR-0005
- UI が使う op は既存のみ: `hello` / `rooms` / `subscribe` / `read` / `post` / `peers`。**webui のための protocol 拡張はしない** (必要が観測されたら DR 追補)

### 5. ロケータ記法 [kawaz §7 メモの採用判断]

- room / メッセージ / member の参照記法として `r<N>` / `m<N>` / `u<N>`・`a<N>` を採用、`#t` は不採用 (kawaz 2026-07-09 回答: thread 想定だった可能性、room 系列は `r` で足りる)。webui の URL 上の形は [webui-url-grammar.md](../design/webui-url-grammar.md) が正本
- member イベントの repo/ws/cwd から Finder / VSCode / gh を開く機能 [kawaz §7] は本 MVP では**表示のみ** (ブラウザ→ローカルアプリ起動は tailscale 越しスマホでは意味を持たないため設計を分ける必要がある)

### 6. webui MVP スコープ

**入れる**: room 一覧 (title/members/最新 mid、live 更新) / room view (msg・member・leave・next/prev の描画、live 追記、メッセージ anchor、次スレ/前スレのリンク遷移) / post (u1 として送信、`--to` 相当の mention 指定) / peers 表示

**入れない** (後 phase): 検索 / room 作成 UI (AI 側が作る運用。User は既存 room に post する) / reaction 等の専用機構 (DR-0001 §6 の通り作らない) / repo/ws/cwd からのアプリ起動 / 認証機構 (tailscale 委譲)

## Alternatives considered

- **別 bridge プロセス (webui が UDS client として仲介)**: 不採用。supervision (DR-0002) 対象プロセスが 2 つに増え、bridge 自身の ensure/version mismatch/lock を二重に作ることになる。プロトコル変換層も増える
- **REST API 変換層**: 不採用。「同じプロトコル」[kawaz] に反し、op 追加のたびに二重メンテになる。WS で line protocol をそのまま通す方が薄い
- **SSE + POST**: 不採用ではなく非優先。WS 1 本で双方向が済む。bun/hono の WS 実績も問題ない
- **HTTP でも hello 申告を尊重 (session role 許可)**: 不採用。tailscale 越しに AI セッションを繋ぐ要件がなく、pinning の方が threat model が単純
- **bind `0.0.0.0` + source-IP allowlist (loopback + tailscale CGNAT `100.64.0.0/10`) を trust boundary にする**: 不採用。source IP はブラウザの他ページを区別できず (§3)、tailnet レンジは shared tailnet で tailnet 内の他 device 全員を u1 として扱う構造的な弱点を持つ。外部到達は reverse proxy → loopback に一本化
- **`shutdown` / `rooms` / `read` / `peers` を hello 必須にする**: 不採用。§3 の通り追加の防御効果がなく、UDS 側の trust boundary (ファイル権限) にも効かず、`ccmsg daemon stop` の hello なし `shutdown` を壊す
- **`Origin: null` を欠落と同等に許可する**: 不採用。§3 の通り sandboxed iframe 等の回避手段と区別が付かない
- **`CCMSG_HTTP_ALLOW_ORIGIN` の手動設定だけで tailscale origin を許可する**: 不採用 (自動検出を併存)。daemon は任意セッションの env から respawn されうるので、env を付け忘れた respawn で ts.net 経由アクセスが 403 になる (`docs/issue/2026-07-11-tailscale-serve-origin-auto-allow.md`)
- **`#t` (thread) ロケータ**: 不採用 (§5)

## Consequences

- kawaz は browser (スマホ含む) から全 room を閲覧し、u1 として直接 post できる — 問題 (5) の仕上げ
- daemon の依存に hono (webui 経由) が加わる。UDS のみで使う場合も import される (bind off でも常駐コストは無視できる規模)
- HTTP 有効時の攻撃面は「`Origin` 検証を通過した接続 = 本人」の前提に依存。前提が崩れる環境 (共用ホスト) では `CCMSG_HTTP_BIND=off`
- テスト用シーム: `CCMSG_TAILSCALE_BIN` で実 tailscale バイナリの代わりに fake script を注入できる (`CCMSG_DAEMON_ENTRY` と同じ流儀)

## Next steps

1. daemon: Conn write 抽象化 + `/ws` transport + identity pinning + bind 設定 + status 拡張 + テスト
2. packages/webui: hono app + client + テスト
3. SKILL.md / README にロケータ記法と webui の使い方を追記
4. dogfood: tailscale 経由スマホアクセスの実機確認 (kawaz)
