# DR-0030: canddy sandbox origin 経由の非信頼コンテンツ配信 (生ファイル / HTML / 大出力)

Status: Proposed
Date: 2026-08-04
Sponsor: kawaz r99 mid=38 (「別ドメインの canddy 設定がしてあるんじゃなかったっけ」)
関連 issue: `docs/issue/2026-07-29-sandbox-origin-raw-content-serving.md` (要件の正本)、
`docs/issue/2026-07-11-origin-isolated-app-reverse-proxy.md` (本 DR が supersede、§8)

## 1. 背景

webui の配信経路は same-origin の `/fs-serve` だけで、画像拡張子 allowlist に限定されている
(fs-serve.ts のヘッダコメントが理由を明記: 任意 MIME を same-origin で返すと
content-sniffing / script 実行の経路になる)。このため以下ができない。

- FileViewer で HTML を**実表示**する (現状はソース表示のみ)
- 任意バイナリの**生ダウンロード**
- TL の長大 bash 出力を**別タブで全文表示**する

一方 canddy-app-proxy には **sandbox ドメインが既に用意済み**で、ccmsg 用の route が
コメントアウト状態で待機している (canddy `Caddyfile`、「ccmsg 側の実装が入ったら有効化」)。
apps 側 `*.kawaz-mbp16-20211217.kawaz.jp` と sandbox 側
`*.kawaz-mbp16-20211217.tmpspace.net` は **eTLD+1 が別**なので、passkey 窃取 /
cookie tossing / SameSite 無効化が構造的に封じられている (canddy
`docs/design/tailnet-local-apps-design.md` §3)。ccmsg はこの器を未活用。

## 2. 決定

ccmsg daemon に **sandbox origin 専用の第 2 リスナ**を持たせ、そこでのみ MIME 制限なしの
生配信を行う。認可は **既存 fs_read 系 3 op と完全に同一の境界**を毎リクエスト再評価し、
その上に **URL capability トークン**と**有効期限**を重ねる。

以下 §3〜§7 が決定事項、§9 が Open question。

## 3. 配信経路

### 3.1 canddy → ccmsg の routing

canddy 側は既存のコメントアウト済みブロックを**そのまま有効化するだけ**でよい
(本 DR は canddy 側の設定変更を要求しない — canddy リポは別管理)。

```caddyfile
@files host_regexp ^ccmsg-files-([a-z2-7]+)\.kawaz-mbp16-20211217\.tmpspace\.net$
handle @files {
    reverse_proxy 127.0.0.1:8643 {
        header_up X-Sandbox-Token {re.1}
    }
}
```

この形が決める制約は 2 つ。

- **ホスト名ラベルの文字集合は `[a-z2-7]+`** (小文字 base32)。ccmsg が発行する grant id は
  この charset に収めないと Caddy の regexp にマッチせず 404 になる
- **upstream は `127.0.0.1:8643`**。ccmsg 側はこのポートで待つ

`header_up` は既存値を**置換**するので、client が送りつけた `X-Sandbox-Token` は
Caddy を通る限り上書きされる。ただし 127.0.0.1:8643 は同一 UID の任意プロセスが直接叩けるため、
この header は「Caddy が抽出したラベルの写し」以上の信頼度を持たない
(同一 UID 境界は DR-0001 §5 / DR-0015 §2.1 と同じ扱い)。**ccmsg は
`X-Sandbox-Token` を認可判断に使わない** — 権限は §4 の URL トークンだけが持つ。

### 3.2 別ポートにする (同一リスナの Host 判定にしない)

**別ポート (`127.0.0.1:8643`) の第 2 `Bun.serve` を立てる**。既存 8642 のリスナに Host 判定で
相乗りさせない。理由:

- 既存リスナは `/ws`・webui fallback・attachment・webhook を同居させている。Host 判定の
  分岐を 1 本入れ忘れる / 順序を間違えるだけで **`/ws` が sandbox origin から到達可能**になる。
  物理的にリスナを分ければこの事故が構造的に起きない
- 既存リスナの `isAllowedOrigin` は sandbox からのリクエストを**必ず弾く**
  (sandbox origin は allowlist に無い)。同居させると sandbox 用だけ Origin チェックを
  スキップする例外分岐が必要になり、その例外が `/ws` に波及するリスクを常に抱える

sandbox リスナの性質 (既存リスナとの差分):

| 項目 | 既存 8642 | sandbox 8643 |
|---|---|---|
| bind | `CCMSG_HTTP_BIND` (tailnet 可) | **loopback 固定**。client は Caddy だけ |
| source-IP allowlist | `CCMSG_HTTP_ALLOW` | loopback のみ |
| Origin チェック | あり (信頼境界の本体) | **無し**。top-level navigation は Origin を送らず、送る場合も cross-site で必ず不一致になる。認可は URL トークンが持つ |
| `/ws` | あり | **無し** |
| webui fallback | あり | **無し** (404) |

### 3.3 ccmsg 側のパス設計

```
https://ccmsg-files-<gid>.kawaz-mbp16-20211217.tmpspace.net/<token>/<relpath>
```

- `<gid>`: grant id。**秘密ではない** origin 分離キー。base32 小文字
- `<token>`: capability トークン (§4)。**秘密**
- `<relpath>`: grant の scope root からの相対パス

**トークンを query (`?t=...`) ではなくパス接頭辞に置く**のが要点。HTML が
`./style.css` のような相対参照を持つとき、パス接頭辞ならブラウザの相対解決が
自動でトークンを引き継ぐ。query 方式は相対サブリソースで必ずトークンが落ちて 403 になる
(= HTML 実表示という主目的が成立しない)。

**トークンをホスト名ラベルに埋めない**理由 (canddy 設計 §8 との差分、§9-Q5 で canddy へ
フィードバックする候補): sandbox ドメインは wildcard A レコードなので、client は
`ccmsg-files-<label>....tmpspace.net` の**完全な名前を公開 DNS に問い合わせる**。ラベルが
秘密だと、その秘密が再帰リゾルバ (ISP / パブリックリゾルバ / Route53) の QNAME として
第三者に漏れる。TLS SNI も平文で同じラベルを載せる。github.io / googleusercontent が
ラベルに非秘密の識別子 (ユーザ名) を置き、秘密を別レイヤに持つのはこのため。ccmsg も
同じ形に倣う。

## 4. capability トークン

### 4.1 発行 (mint)

**新 op `sandbox_grant` (user role 限定)** を daemon に追加する。webui が
「HTML として開く」「生ダウンロード」を押した時点で 1 回呼ぶ。

- 入力: `{ sid, path, kind }` — `kind` は既存 `fs-serve` と同じ
  `contained | external | workspace`
- daemon は**発行時点で `fsResolveForServe` を通す**。読めないパスの grant は最初から
  発行しない (エラーは既存の `path_forbidden` / `not_found` をそのまま返す)
- 出力: `{ gid, token, url, exp }`

grant は daemon の**メモリ上のテーブル**に持つ (fs を触らない = DR-0029 準拠、
daemon 再起動で全失効)。保持するのは `{ gid, token, sid, kind, scopeRoot, exp }`。

**canddy 設計 §8 のステートレス HMAC 方式を採らない理由**: あの方式は payload を
DNS ラベル 63 文字に収める必要があり、target 領域が 8 B しかない。ccmsg が束縛したいのは
`(sid, kind, path)` の 3 つ組で、パスは可変長なので入らない。加えて ccmsg は常駐 daemon で
既にセッション状態を持っており、状態テーブルの追加コストが実質ゼロ。ステートレスが
買っていた「プロセス再起動をまたぐ一貫性」は、ここではむしろ**再起動で失効してほしい**
性質なので利点にならない。トレードオフとして「daemon 再起動で開いていたプレビューが
切れる」を受け入れる。

### 4.2 検証

sandbox リスナは 1 リクエストごとに次を全て通す。1 つでも落ちたら配信しない。

1. `gid` をホスト名 (`Host` ヘッダ) から取り出し、grant テーブルを引く。無ければ 404
2. URL 先頭の `<token>` を grant の token と**定数時間比較**。不一致なら 404
   (403 でなく 404 なのは gid の存在自体を漏らさないため)
3. `exp` 超過なら 410 Gone
4. `<relpath>` を grant の `scopeRoot` に結合し、**`fsResolveForServe(sid, 結合パス, kind)`
   を再実行**する

4 が本 DR の認可設計の核心 (§5)。grant は「どの origin か・いつまでか・どの範囲か」を
足すだけで、**読める範囲を一切広げない**。

### 4.3 寿命・失効

- **exp は短寿命**。既定値は §9-Q2 で裁定を仰ぐ (提案: 発行から 30 分)
- **daemon 再起動で全失効** (メモリ保持のため)
- **`sandbox_revoke` op** で明示失効させる。webui はプレビュータブを閉じた時に投げる
  (best-effort。失敗しても exp が拾う)
- **token rotate は grant 単位**。全体鍵を持たないので「鍵ローテートで一斉失効」は
  再起動で代替する

### 4.4 URL に載る前提のリスクと緩和

| リスク | 緩和 |
|---|---|
| ブラウザ履歴 / ブックマークに残る | 短寿命 exp。失効後は 410 で無害 |
| `Referer` で外部に漏れる | canddy が sandbox 全体に `Referrer-Policy: no-referrer` を付与済み |
| プレビュー内 JS が `location.href` を読んで外部送信 | CSP `connect-src 'self'` + `form-action 'none'` (§6)。加えて grant は単一 scope 束縛なので、漏れても他ファイルには届かない |
| 肩越しの盗み見 / スクショ | tailnet 到達性 + 短寿命。これ以上は追わない |
| DNS / SNI 経由の漏洩 | トークンをホスト名に置かない (§3.3) |

### 4.5 DR-0029 準拠

mint / 検証 / 配信の全経路を async にする。配信本体は `Bun.file()` を `Response` に
渡すストリーミング (attachment.ts と同じ流儀) とし、`readFileSync` で全読みしない
(TL 長大出力・大バイナリが対象になるため特に重要)。

なお `fsResolveForServe` は現状 `fs.lstatSync` を含む同期呼び出しで、DR-0029 の
「同期 IO をハンドラに置かない」に抵触している。既存 `/fs-serve` から引き継ぐ債務で、
issue `2026-07-31-audit-blocking-io-paths` の担当範囲。本 DR ではその解消を前提にせず、
解消されたら自動的に恩恵を受ける形にしておく (呼び出し側を async のままにする)。

## 5. 認可境界

**sandbox origin の認可は fs_read 系 3 op と同一**。新しい認可面を作らない。

- `contained`: セッションの containment root 配下 (DR-0008)
- `workspace`: `.code-workspace` の folders 配下 (DR-0026)
- `external`: transcript 由来の完全一致 allowlist (DR-0024)

`external` は**完全一致集合**なので、scope root を持つ subtree grant は原理的に作れない。
`external` の grant は**単一ファイル束縛に限定**する (相対サブリソースを持つ HTML は
`external` 経由では動かない。これは制限であって bug ではない)。

### 5.1 sandbox origin が持ってはいけないもの

以下が**構造的に成立しない**ことを確認した上での設計。

- **cookie**: cross-site なのでブラウザが送らない。ccmsg は sandbox リスナで
  `Set-Cookie` を一切出さない
- **passkey / WebAuthn**: 別 eTLD+1 なので RP ID が届かない。canddy が
  `Permissions-Policy: publickey-credentials-get=(), publickey-credentials-create=()` で
  多層防御済み
- **`/ws` への到達**: sandbox リスナに `/ws` を置かない (§3.2)
- **daemon の他 op**: sandbox リスナは配信 1 経路のみ。op dispatch へ繋がない
- **apps 側 origin の DOM / storage**: origin が別なので届かない。iframe 埋め込み時も
  cross-site なので `sandbox allow-scripts allow-same-origin` の自力解除は成立しない
  (canddy 設計 §6 案 B の議論と同じ)

## 6. レスポンスヘッダ (preview / download の 2 モード)

同一エンドポイントで**モードを分ける**。混ぜると「HTML を実表示したい」と
「バイナリを安全に落としたい」が両立しない (CSP `sandbox` は既定でダウンロードを
ブロックするため)。

### 6.1 preview モード (既定)

実 MIME を返して**表示させる**。

- `Content-Type`: 拡張子由来 (attachment.ts の `mimeForExtension` を共有)。
  `text/html` を含む — これが sandbox origin を用意した目的
- `Content-Disposition: inline`
- `Content-Security-Policy` (canddy 設計 §6 案 B を採用):

```
sandbox allow-scripts allow-same-origin;
default-src 'self'; img-src 'self' data: blob:;
style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline';
font-src 'self' data:; connect-src 'self';
frame-ancestors https://ccmsg.kawaz-mbp16-20211217.kawaz.jp;
form-action 'none'; base-uri 'none'
```

`connect-src 'self'` が最重要 — これが無いとプレビュー内 JS が tailnet 全域
(`100.64.0.0/10`) を fetch で舐められる。`frame-ancestors` の値は
§7 の config から組み立てる (ハードコードしない)。

### 6.2 download モード (`?dl=1`)

内容を**解釈させずに落とす**。

- `Content-Type: application/octet-stream`
- `Content-Disposition: attachment; filename="..."`
- `Content-Security-Policy: sandbox` (`allow-scripts` なし。レンダリング経路を全否定)

`X-Content-Type-Options: nosniff` は canddy が sandbox サイト全体に付与済み。
ccmsg 側でも重複して付ける (canddy 無しでの直接検証時に効かせるため。重複は無害)。

## 7. webui の導線と capability gate

### 7.1 config と hello

`<dataDir>/config.json` に **`sandbox_origin_template`** を追加する。

```json
{ "sandbox_origin_template": "https://ccmsg-files-{gid}.kawaz-mbp16-20211217.tmpspace.net" }
```

daemon はこれを持つときだけ hello に **`sandbox_available: true`** を返す
(user role 限定)。`terminal_gateway_url` / `llm_usage_available` と同じ流儀
(server.ts の hello 分岐)。URL そのものは `sandbox_grant` の応答で返すので、
hello では可否だけ渡す。

**未設定環境 (canddy 無し) では webui が導線を一切出さない。** 押せば必ず失敗する
ボタンを置かない、という既存の判断 (server.ts の `llm_stats_available` コメント) に従う。

### 7.2 導線

- **FileViewer**: HTML ファイルを開いているとき「HTML として開く」ボタン。任意ファイルに
  「生ダウンロード」ボタン。いずれも `sandbox_available` が真のときだけ表示
- **TL の長大 bash 出力**: 「別タブで全文」リンク (Phase 2、§9-Q6 の裁定待ち)
- 開くのは**別タブ**を既定にする。iframe 埋め込みは `frame-ancestors` で許可済みだが、
  Phase 1 では使わない (別タブの方が「別 origin の非信頼コンテンツ」であることが
  ユーザに見えて誤解が少ない)

### 7.3 発端の URL

kawaz が挙げた
`https://ccmsg.../s/<sid>/files?path=main%2Fdocs%2Fdesign%2Farchitecture-overview.html`
は webui の FileViewer ルートで、本 DR ではここに §7.2 のボタンが増える形になる。
webui 側 URL の形は変えない。

## 8. issue 2026-07-11 (origin 分離リバースプロキシ構想) の supersede

issue `2026-07-11-origin-isolated-app-reverse-proxy.md` は **canddy として実装済み**で、
本 DR がその ccmsg 側の具体化にあたる。受け入れ条件の帰着:

| 旧 issue の受け入れ条件 | 帰着 |
|---|---|
| Caddy wildcard DNS-01 + `reverse_proxy` の PoC | canddy で実現済み (`Caddyfile` の `acme_route53`、Route53 DNS-01) |
| 公開範囲 (tailnet 限定) の方針 | canddy `tailnet_only` スニペットで実装済み。CNAME でなく A レコード直書きを採用 (canddy 設計 §4) |
| docroot ごとの origin 割当方式 | 本 DR §3.3 / §4.1 (grant id をラベルに、秘密はパスに) |
| cookie / 認証境界の扱い | 本 DR §5.1 |
| build か buy か | buy (Caddy = canddy)。自作リバースプロキシは不採用 |

旧 issue の「webui の html プレビューはセキュリティ理由で見送り」という 2026-07-11 の
kawaz 裁定は、**その前提 (origin 分離が無い) が解消されたため本 DR で解除**される。

→ 旧 issue は本 DR の Accepted をもって close (`close_reason`: DR-0030 が supersede)。

## 9. Open question (kawaz 裁定待ち — 本 DR では確定させない)

- **Q1. sandbox リスナの既定**: `127.0.0.1:8643` 固定か、`CCMSG_SANDBOX_BIND` 環境変数化か。
  また `sandbox_origin_template` 未設定時はリスナ自体を**起動しない**方針でよいか
  (提案: 起動しない。使わない port を開けない)
- **Q2. grant の既定寿命**: 提案は 30 分固定。sliding 延長を付けるか、
  preview と download でモードごとに変えるか
- **Q3. Phase 1 の grant scope**: 単一ファイル束縛か、そのファイルの**親ディレクトリ**を
  scope root にした subtree か。単一ファイルは実装が最小だが、相対 CSS/JS/画像を持つ
  HTML が崩れる (発端の `architecture-overview.html` が該当する可能性が高い)。
  subtree は「1 クリックでディレクトリ 1 つ分が読める URL が生える」ことの是非を要判断
- **Q4. gid の安定性**: 同じ `(sid, scopeRoot)` に対して gid を**再利用**するか、
  mint ごとに**新規乱数**にするか。再利用はブラウザキャッシュとリロードが効く一方、
  origin の寿命が延びる。新規乱数は分離が最強だがリロードで壊れる
- **Q5. canddy へのフィードバック**: §3.3 の「秘密をホスト名ラベルに置くと公開 DNS の
  QNAME と TLS SNI に漏れる」は canddy 設計 §8 のステートレス署名トークン方式にも
  当てはまる。canddy 側へ issue を上げるか (canddy リポは本作業の範囲外)
- **Q6. TL 長大出力の実体**: 別タブ表示の対象バイトは**ディスク上に無い**
  (transcript 内)。attachment 方式で TMPDIR に materialize するか、transcript から
  ストリームする専用 kind を足すか。後者は §5 の「3 op と同一境界」から外れるので
  設計判断が要る
- **Q7. canddy 側 route の有効化**: コメント解除は canddy リポの変更。ccmsg 側が
  必要な Caddyfile スニペットを docs に転記して runbook 化するか、canddy の
  docs を参照するに留めるか

## 10. 実装フェーズ分割

### Phase 1 — HTML プレビューが動く最小 (発端の解消)

1. `sandbox_origin_template` config + hello `sandbox_available`
2. `sandbox_grant` / `sandbox_revoke` op (protocol + daemon)
3. sandbox リスナ (`Bun.serve` on 8643、loopback 固定、`/ws` 無し、fallback 無し)
4. preview / download の 2 モード配信 (§6)
5. FileViewer の「HTML として開く」/「生ダウンロード」ボタン (capability gate 付き)
6. canddy 側 route の有効化 (Q7 の裁定次第)

Q3 が「単一ファイル」に倒れた場合、相対参照を持つ HTML は崩れた状態で表示される。
その場合 Phase 2 の subtree 対応までは既知の制限として扱う。

### Phase 2 — TL 長大出力の別タブ表示

Q6 の裁定が前提。subtree grant (Q3 が単一ファイルに倒れた場合) もここ。

### Phase 3 — attachment の sandbox 移行

現在 `/attachment/<uuid.ext>` は same-origin で `text/html` を含む MIME を返しており
(attachment.ts の `MIME_BY_EXT`)、**本 DR の問題意識がそのまま当てはまる既存経路**。
sandbox origin へ寄せるか、少なくとも HTML を落とすかを別途判断する。

> この Phase 3 の指摘は本 DR の調査中に発見した既存の穴で、Phase 1/2 とは独立に
> 優先度判断が要る (§9 とは別に、統括経由で kawaz へ)。
