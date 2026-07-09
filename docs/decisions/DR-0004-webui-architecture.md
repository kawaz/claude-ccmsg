# DR-0004: webui アーキテクチャ (HTTP/WS transport + UI)

- **Status**: Proposed (2026-07-09、kawaz の「進められそうならやって欲しい」を受けて実装先行。明示レビュー待ち)
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
  - 根拠: HTTP に到達できるのは 127.0.0.1 (= 本人のマシン) か tailscale (= 本人のデバイス) のみで、いずれも「kawaz 本人」。browser を session として参加させる要件はない
- daemon 内部の seam: `Conn` の write を socket 直書きから transport 非依存の `write(line)` に抽象化する。dispatch / delivery / subscribe は一切 transport を知らない

### 3. bind と port [kawaz 制約 + 提案の既定値]

- 既定 bind: `127.0.0.1:8642`。env `CCMSG_HTTP_BIND` で上書き (カンマ区切りで複数 bind 可、例 `127.0.0.1:8642,100.101.102.103:8642` で tailscale IP を追加)。`off` で無効化
- 既定 ON (127.0.0.1 のみなので安全側)。前提: single-user マシン (127.0.0.1 は同一ホストの他 UNIX ユーザからも届く点は UDS 0600 より弱いが、個人機前提で許容)。マルチユーザ環境では `off` にする
- `ccmsg status` / `ping` 応答に http bind 情報を出す (observability、DR-0002 §7 の延長)

### 4. UI は packages/webui、ビルドステップなし [提案] (クライアント実装方式は DR-0005 が supersede)

- **hono** app を `packages/webui` が export し、daemon の HTTP handler が `/ws` 以外を mount する (UI の責務分離。kawaz の「ui 自体は別サブプロジェクトにしても良い」の monorepo 内実現)
- クライアントは **vanilla ESM JS + CSS (フレームワーク・bundler なし)**。理由: UI スコープ (room 一覧 / room view / post / live 追記) は素の DOM で足りる規模で、build 成果物が無ければ plugin 配布 (bun run 直実行) がそのまま成立する。dist/ は .gitignore 済みで配布に乗らないため、build 前提の SPA は配布形態を複雑化する
- UI が使う op は既存のみ: `hello` / `rooms` / `subscribe` / `read` / `post` / `peers`。**webui のための protocol 拡張はしない** (必要が観測されたら DR 追補)

### 5. ロケータ記法を webui の URL/anchor として採用 [kawaz §7 メモの採用判断]

- room 選択は `/#rXXXX`、メッセージ位置は `/#rXXXX-mNN` (fragment がそのまま locator になる)。member 表示は uid (`uNN`) を添える
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
- HTTP 有効時の攻撃面は「127.0.0.1/tailscale に届く者 = 本人」の前提に依存。前提が崩れる環境 (共用ホスト) では `CCMSG_HTTP_BIND=off`

## Next steps

1. daemon: Conn write 抽象化 + `/ws` transport + identity pinning + bind 設定 + status 拡張 + テスト
2. packages/webui: hono app + vanilla client + テスト
3. SKILL.md / README にロケータ記法と webui の使い方を追記
4. dogfood: tailscale 経由スマホアクセスの実機確認 (kawaz)
