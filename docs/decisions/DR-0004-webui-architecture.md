# DR-0004: webui アーキテクチャ (HTTP/WS transport + UI)

- **Status**: Accepted (2026-07-10、kawaz レビュー裁定「何でも良い」= 一任により承認)
- **Date**: 2026-07-09
- **Author**: AI agent (一次資料の kawaz 発言に基づく)
- **一次資料**: [docs/research/2026-06-29-kawaz-design-statements.md](../research/2026-06-29-kawaz-design-statements.md) §3, §4 回答 1・3, §7
- **前提 DR**: DR-0001 §7 (transport)・§8 (クライアント 3 種)、DR-0003 (wire protocol)

## 記述規約 (attribution)

DR-0001 と同じ: **[kawaz]** = 一次資料に逐語あり / **[提案]** = エージェント由来 / **[保留]** = 意図的に未決。

## Context

DR-0001 §7 が [保留] にした「HTTP を daemon 内蔵にするか別 bridge プロセスにするか」を含め、webui phase の設計を確定する。制約は DR-0001 で確定済み:

- socket と web は「セキュリティに関しての層」を挟んで**同じプロトコル**を喋る [kawaz]
- bind は 127.0.0.1 + tailscale interface のみ、認証は tailscale 側に委ねる [kawaz]
- 言語は bun + hono [kawaz]
- webui は kawaz の直接 UI (= 問題 (5) kawaz 混入コストの解消の仕上げ)。スマホからは tailscale 経由 [kawaz]

## Decision

### 1. HTTP は daemon 内蔵 (別 bridge プロセスにしない) [kawaz 発言に整合]

- 一次資料 §3「ユーザ ui はデーモンプロセスに web api 持たせて、ui 自体は別サブプロジェクトにしても良い」の通り、**web API は daemon プロセスが持つ**。DR-0001 §7 の [保留] はこれで解消
- 別 bridge プロセス案は不採用: supervision (DR-0002) 対象プロセスが 2 つに増え、bridge 自身の ensure/version mismatch/lock を二重に作ることになる。daemon 内蔵なら既存 lifecycle にただ乗りできる

### 2. WS で同一プロトコル、transport 差分は identity pinning に隔離 [提案]

- `Bun.serve` の WebSocket endpoint `/ws` が **UDS と同一の line protocol** (1 メッセージ = 1 JSON、op/イベントの shape も同一) を喋る。API surface の二重化 (REST 変換層) はしない
- **セキュリティ層 = identity pinning**: HTTP/WS 経由の接続は hello の申告に関わらず **role を `user` (uid 0) に固定**する。AI セッション (role: session) は UDS 経由のみ。daemon が from を刻印する DR-0003 の原則の transport 版
  - 根拠: `/ws` に到達できるのは source-IP allowlist (§3) と `Origin` 検証 (2026-07-10 追補) の両方を通過した接続のみで、これは「このデーモン自身の webui、または明示許可した origin」に絞られる。browser を session として参加させる要件はない
- daemon 内部の seam: `Conn` の write を socket 直書きから transport 非依存の `write(line)` に抽象化する。dispatch / delivery / subscribe は一切 transport を知らない

### 3. bind と source-IP allowlist [kawaz 制約 + 提案の既定値、2026-07-10 追補で allowlist を追加、同日 Critical 修正で loopback へ戻す]

- 既定 bind: `127.0.0.1:8642,[::1]:8642` (loopback のみ)。env `CCMSG_HTTP_BIND` で上書き (カンマ区切りで複数 bind 可)。`off` で無効化
- 既定 allow: `127.0.0.0/8,::1` (loopback)。env `CCMSG_HTTP_ALLOW` で上書き (カンマ区切り CIDR/IP)。source IP が allowlist に無い接続は fetch (WS upgrade 前を含む) で 403、判定不能 (`requestIP` が null 等) も拒否側に倒す
- **trust boundary は source-IP allowlist ではなく `Origin` 検証** (下記 Critical trust-model 修正の追補参照): source IP は「このマシン自身」までしか絞れず、ブラウザベースの脅威 (§2) に対しては allowlist は defense-in-depth の belt に過ぎない
- `ccmsg status` / `ping` 応答に http bind + allowlist 情報を出す (observability、DR-0002 §7 の延長)

> **2026-07-10 追補**: kawaz 要望「tailscale 経由でスマホから繋ぎたい、127.0.0.1 と tailscale レンジ以外は弾く」を受けて、bind を `127.0.0.1:8642` 固定から `0.0.0.0:8642` + source-IP allowlist (loopback + tailscale レンジ) に変更した。同日中に Critical trust-model 修正 (下記) でこの allowlist 方式自体が「reachable == user」の前提を壊す設計だったと判明し、bind を loopback 固定に戻し、tailscale アクセスは `CCMSG_HTTP_ALLOW_ORIGIN` 経由に切り替えた。

### 4. UI は packages/webui、ビルドステップなし [提案] (クライアント実装方式は DR-0005 が supersede)

- **hono** app を `packages/webui` が export し、daemon の HTTP handler が `/ws` 以外を mount する (UI の責務分離。kawaz の「ui 自体は別サブプロジェクトにしても良い」の monorepo 内実現)
- クライアントは **vanilla ESM JS + CSS (フレームワーク・bundler なし)**。理由: UI スコープ (room 一覧 / room view / post / live 追記) は素の DOM で足りる規模で、build 成果物が無ければ plugin 配布 (bun run 直実行) がそのまま成立する。dist/ は .gitignore 済みで配布に乗らないため、build 前提の SPA は配布形態を複雑化する
- UI が使う op は既存のみ: `hello` / `rooms` / `subscribe` / `read` / `post` / `peers`。**webui のための protocol 拡張はしない** (必要が観測されたら DR 追補)

### 5. ロケータ記法を webui の URL/anchor として採用 [kawaz §7 メモの採用判断]

- room 選択は `/#rXXXX`、メッセージ位置は `/#rXXXX-mNN` (fragment がそのまま locator になる)。member 表示は uid (`uNN`) を添える

> **Superseded by [DR-0006](./DR-0006-id-scheme-v2.md)**: member 表示は uid ではなく型付き文字列 `id` (`u1`/`a2`...) をそのまま添える (`#r7-u1` / `#r7-a2`)。
- issue `2026-07-03-locator-syntax-for-rooms-and-messages` の「webui 設計時に採否判断」への回答: **`#r` / `#m` / `#u` を採用、`#t` は不採用** (kawaz 2026-07-09 回答: thread 想定だった可能性、room 系列は `#r` で足りる)
- member イベントの repo/ws/cwd から Finder / VSCode / gh を開く機能 [kawaz §7] は本 MVP では**表示のみ** (リンク起動は後続。ブラウザ→ローカルアプリ起動は tailscale 越しスマホでは意味を持たないため設計を分ける必要がある)

### 6. webui MVP スコープ

**入れる**: room 一覧 (title/members/最新 mid、live 更新) / room view (msg・member・leave・next/prev の描画、live 追記、`#m` anchor、次スレ/前スレのリンク遷移) / post (uid 0 として送信、`--to` 相当の mention 指定) / peers 表示

**入れない** (後 phase): 検索 / room 作成 UI (AI 側が作る運用。User は既存 room に post する) / reaction 等の専用機構 (DR-0001 §6 の通り作らない) / repo/ws/cwd からのアプリ起動 / 認証機構 (tailscale 委譲)

## Alternatives considered

- **別 bridge プロセス (webui が UDS client として仲介)**: 不採用。§1 の通り supervision の二重化。プロトコル変換層も増える
- **REST API 変換層**: 不採用。「同じプロトコル」[kawaz] に反し、op 追加のたびに二重メンテになる。WS で line protocol をそのまま通す方が薄い
- **SSE + POST**: 不採用ではなく非優先。WS 1 本で双方向が済む。bun/hono の WS 実績も問題ない
- **preact/react + vite の SPA**: 不採用 (現スコープ)。§4 の通り配布とビルドの複雑化に見合う UI 要件がまだない。UI が育ったら再評価 (packages/webui に隔離してあるので置き換えは局所)
- **HTTP でも hello 申告を尊重 (session role 許可)**: 不採用。tailscale 越しに AI セッションを繋ぐ要件がなく、pinning の方が threat model が単純

## Consequences

- kawaz は browser (スマホ含む) から全 room を閲覧し、uid 0 として直接 post できる — 問題 (5) の仕上げ
- daemon の依存に hono (webui 経由) が加わる。UDS のみで使う場合も import される (bind off でも常駐コストは無視できる規模)
- HTTP 有効時の攻撃面は「このデーモン自身の webui、または明示許可した origin からの接続 = 本人」という `Origin` 検証 (2026-07-10 追補) の前提に依存。前提が崩れる環境 (共用ホスト) では `CCMSG_HTTP_BIND=off`

## Next steps

1. daemon: Conn write 抽象化 + `/ws` transport + identity pinning + bind 設定 + status 拡張 + テスト
2. packages/webui: hono app + vanilla client + テスト
3. SKILL.md / README にロケータ記法と webui の使い方を追記
4. dogfood: tailscale 経由スマホアクセスの実機確認 (kawaz)

> **2026-07-10 追補 (Critical trust-model 修正)** [提案、codex レビューの実物検証に基づく]:
> §2 の「reachable == user」trust model は **Web ブラウザからの cross-origin
> WebSocket 接続を想定していなかった欠陥**だった。SOP (Same-Origin Policy) は
> WebSocket 接続の確立自体には効かない (Fetch 仕様上、WS はそもそも SOP の対象外)。
> このため §3 の「source IP = 127.0.0.1 or tailscale レンジなら kawaz 本人」という
> 前提は、**kawaz が悪意ある Web ページ (evil.com) を開いただけ**で崩れる:
> そのページの JS が `new WebSocket("ws://127.0.0.1:8642/ws")` を張ると、接続元
> IP は 127.0.0.1 (= ブラウザが動いているこのマシン自身) になり allowlist を通過する
> — Origin ヘッダは `evil.com` のままだが、旧実装はこれを一切検証していなかった。
> 加えて `IDENTITY_OPS` (hello 必須 op の一覧) に `shutdown` / `rooms` / `read` /
> `peers` が含まれておらず、hello なしで到達可能だった。組み合わせると:
> リモート DoS (`{"op":"shutdown"}` → `process.exit(0)`)、全 room / 全メッセージ
> 漏洩 (`rooms` / `read`)、hello 後の u1 偽メッセージ注入 (`post`) が hello 要件も
> 認証も無しに成立していた。詳細な実物検証は
> `docs/findings/2026-07-10-codex-review-evaluation.md`、受け入れ条件は
> `docs/issue/2026-07-10-webui-transport-trust-model-security-critical.md` を参照。
>
> **修正 (3 点、`isAllowed`/source-IP allowlist と直交する層として追加)**:
>
> 1. **bind を loopback のみに戻す**: `DEFAULT_HTTP_BIND` を
>    `0.0.0.0:8642` → `127.0.0.1:8642,[::1]:8642` に変更。tailscale serve (や他の
>    reverse proxy) は外部から loopback へ forward する運用を前提とする (kawaz の
>    HTTPS 化裁定と整合)
> 2. **source-IP allowlist から tailnet レンジを削除**: `DEFAULT_HTTP_ALLOW` を
>    `127.0.0.0/8,::1,100.64.0.0/10,fd7a:115c:a1e0::/48` →
>    `127.0.0.0/8,::1` に変更。`100.64.0.0/10` (tailscale CGNAT) を admin 権限の
>    代理として使う設計は、**shared tailnet で tailnet 内の他 device 全員を u1
>    として扱ってしまう**構造的な弱点だった (kawaz が個人単独 tailnet の間は
>    実害なしだが、trust boundary としては誤り)
> 3. **`fetch` に `Origin` 検証を追加**: `packages/daemon/src/http.ts` の
>    `isAllowedOrigin`。source-IP allowlist では「このマシン自身」までしか
>    絞れず、「このデーモン自身の webui」と「同じブラウザで開いている他の任意の
>    ページ」を区別できない — 区別できるのは `Origin` ヘッダだけ。許可する
>    origin は各 bind の自己アドレス (`http://127.0.0.1:8642` /
>    `http://[::1]:8642`) と、`CCMSG_HTTP_ALLOW_ORIGIN` (カンマ区切り) で
>    明示的に追加した origin (tailscale serve 越しの
>    `https://<machine>.<tailnet>.ts.net` 等) のみ。`Origin` ヘッダ**欠落**は
>    非ブラウザクライアント (curl・CLI ヘルスチェック・Bun 自身の
>    `WebSocket`/`fetch`、いずれもテストで使用) として許可するが、リテラル文字列
>    `"null"` は意図的に「欠落と同等」扱いしない: `"null"` はブラウザが opaque
>    origin (`<iframe sandbox="allow-scripts">` / `file://` / `data:` URL) に対して
>    送る値そのもので、**攻撃者ページがこの Origin 検証を回避するために使う
>    手段と区別が付かない**。このコードベースに `"null"` を必要とする正当な
>    クライアントは無いため、既定では弾く (必要になったら
>    `CCMSG_HTTP_ALLOW_ORIGIN` に明示追加する形にする)。この判断は issue の
>    受け入れ条件文言 (「`null` origin ... のみ通す」) より厳格な側に倒した
>    **意図的な逸脱** — 根拠は上記の sandboxed-iframe 回避手段としての `"null"`
>    origin の悪用可能性
>
> **`IDENTITY_OPS` は変更しない (無変更で可、と判断)** [提案]:
> `shutdown` / `rooms` / `read` / `peers` を hello 必須にする案を検討したが、
> 見送った。理由:
> - 上記 Origin 検証により、HTTP/WS 経由でこれらの op に到達できるのは
>   「このデーモン自身の webui」または明示許可した origin からの接続のみになった
>   (= DR-0004 §2 の identity pinning の前提「reachable == user」が、ブラウザの
>   実際の Origin に基づいて正しく回復された)。これ以上 hello 必須化しても
>   ブラウザ経由の脅威モデルに対する追加の防御効果は無い
> - UDS 経路には file permission (`0o600`) による OS レベルの trust boundary が
>   別途あり (Major 1、同 UID 内は信頼、次項参照)、hello 必須化はこちらには
>   効かない
> - `shutdown` を hello 必須にすると **`packages/cli` の `ccmsg daemon stop` を
>   壊す**: `runDaemonStop` は `connectIfRunning` (hello を送らない接続) 経由で
>   直接 `{"op":"shutdown"}` を送る実装になっている (`packages/cli/src/client.ts`
>   の `connectIfRunning`、`packages/cli/src/index.ts` の `runDaemonStop`)。
>   `rooms`/`read`/`peers` は CLI 側が常に `ensureDaemon` (hello 経由) 越しに
>   呼んでいるため hello 必須化しても CLI は壊れないが、`shutdown` だけ既存の
>   正当な CLI フローと衝突するため、4 op まとめて据え置く判断とした
>
> **u1 (User) の真正性は UDS 上の同 UID 内で信頼する** [提案] (Major 1 の議論の
> 明文化): `packages/cli` の `--as-user` は同 UID の任意プロセスが
> `identity.role="user"` を名乗ることを許す。daemon 側 (`server.ts` の hello
> dispatch) は UID による OS レベルの trust のみを根拠にこれを受け入れ、
> それ以上の真正性検証はしない。これは **同一マシン・同一ユーザ内で動く
> personal スケールの前提を意図的に受容**したもので、「同 UID で任意のプロセスを
> 走らせられる」攻撃者は既にローカル侵入済みという前提に立つ (=
> `--as-session <sid>` で他セッションの sid を騙ることも同様に UDS の trust
> boundary の外側)。UDS の access control は OS のファイル権限 (`0o600`) が
> 担っており、この文書の trust model の対象は HTTP/WS transport (§2/§3) の
> ブラウザ由来の脅威に限定される。
>
> **loopback 別名を Origin 検証で相互許可する** [提案、adversarial review 起因の
> 2026-07-10 追補]: `isAllowedOrigin` の完全一致判定は bind の literal hostname
> (`127.0.0.1` / `::1`) しか受理せず、kawaz が webui を `http://localhost:8642`
> で開くとページ自体は表示されるのに WS だけ Origin 不一致で 403 になり、
> 無限 reconnect ループに陥る実害があった。修正: bind が loopback
> (`127.0.0.0/8` / `::1` / `localhost`) のとき、同一ポートの `localhost` /
> `127.0.0.1` / `[::1]` の 3 origin を相互に許可する。これは trust boundary を
> 広げない — この 3 名のいずれかからこのデーモンに到達できる時点で、接続元は
> 既にこのマシン自身であることが確定している。`origin` をこれら 3 名のどれかに
> 見せかけて他マシンから到達する唯一の経路は `/etc/hosts` や DNS の
> `localhost` 解決を書き換えることだが、それを実行できる時点で host 自体が
> 既に侵害済みであり、この Origin 検証をバイパスする必要すら無い。
>
> **tailscale serve origin の zero-config 自動許可** [提案、2026-07-11 追補、
> `docs/issue/2026-07-11-tailscale-serve-origin-auto-allow.md`]: `CCMSG_HTTP_ALLOW_ORIGIN`
> は daemon が respawn されるたび (`packages/cli` は任意セッションの env から
> daemon を再起動しうる) に再設定が必要で、env を付け忘れた respawn が起きると
> ts.net 経由アクセスが再び 403 になる実地障害が起きた。これを解消するため、
> daemon 起動時に `tailscale serve status --json` を best-effort (timeout 1s、
> 失敗は黙って空集合、ログ 1 行のみ) で問い合わせ (`packages/daemon/src/
> tailscale-origin.ts`)、**このマシンの tailscale serve がこの daemon 自身の
> bind ポートへ proxy している** ts.net hostname の origin を自動で
> `extraOrigins` (isAllowedOrigin が見る Set) へ追加する。
>
> **trust 根拠**: その `https://<hostname>.<tailnet>.ts.net` origin をブラウザが
> 名乗れるページは、tailscale serve がこのマシン自身で TLS 終端して配信した
> ものだけ (serve は tailscale 側の認証を経てこのマシンにトラフィックを
> 中継する)。加えて、serve の proxy 先が **この daemon 自身が bind している
> ポート**であることを毎回確認してから許可する — 「serve 構成が存在する」
> だけでなく「その serve がこの daemon 宛て」であることを見て初めて信頼する。
> serve が同一マシン内の**別のローカルアプリ**へ向いているケース (この daemon
> とは無関係な serve 設定) は、bind ポート不一致として自動許可の対象外になる。
> 一方、同一マシン上の別プロセスが自分の serve 設定を持ち、たまたま **この
> daemon と同じポート**を指す構成に細工した場合は許可されてしまいうるが、
> これは「同 UID で任意のプロセスを走らせられる攻撃者」を前提とする既存の
> trust boundary (上記「u1 の真正性は同 UID 内で信頼する」と同根) の範囲内であり、
> 新たな trust boundary の拡張ではない。
>
> `CCMSG_HTTP_ALLOW_ORIGIN` (手動拡張) は自動許可と併存し、tailscale 以外の
> reverse proxy 等では引き続きこちらを使う。tailscale 未インストール/未 serve
> 環境では単に何も追加されず、daemon 起動自体は一切ブロックされない (`void` で
> 投げっぱなしの非同期呼び出し)。`CCMSG_TAILSCALE_BIN` はテスト専用シーム
> (`CCMSG_DAEMON_ENTRY` と同じ流儀) で、実 tailscale バイナリの代わりに
> fake script を注入できる。
