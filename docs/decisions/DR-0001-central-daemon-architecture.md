# DR-0001: Central daemon + room messaging architecture

- **Status**: Accepted (2026-07-03)
- **Date**: 2026-07-03
- **Author**: kawaz (整理: AI agent)
- **Origin**: rewrite from [kawaz/claude-cmux-msg](https://github.com/kawaz/claude-cmux-msg) (p2p)
- **一次資料** (本 DR はパラフレーズ。意図が割れたら一次資料が優先):
  - [docs/research/2026-06-29-kawaz-design-statements.md](../research/2026-06-29-kawaz-design-statements.md) — kawaz 発言の逐語集
  - [docs/research/2026-06-29-die-v2-proposal-message.md](../research/2026-06-29-die-v2-proposal-message.md) — die セッション発 v2 提案全文

## 記述規約 (attribution)

各決定に出所を明示する:

- **[kawaz]** — kawaz が明示した決定・スケッチ (一次資料に逐語あり)
- **[提案]** — エージェント/codex 由来の提案。本 DR の Accepted をもって決定に昇格済み (出所区分として印は残す)
- **[保留]** — 意図的に未決。後続 DR または実装時に決める

## Context

p2p 方式の cmux-msg で複数セッション会話 (die / grapheme.mbt / timespec.mbt の 3 セッション + kawaz) を実施した結果、kawaz が 5 つの構造的問題を観察した (逐語は一次資料 §1):

1. **クロス爆発**: 1 対 1 通信のみのため類似会話が pair ごとに重複、4-5 セッションで組合せ爆発
2. **同一指示の負担**: kawaz が N セッションに同じ依頼をコピペ → 受け手にも同種行動が重複
3. **AI 間の無駄会話**: 「あいつはこう言ってた」の伝聞転送が増殖
4. **メール調社交辞令**: msg / send の語感が形式ばった長文と褒め合いを誘発
5. **kawaz 混入コスト**: kawaz は 1 peer ずつしか発信できず、コピペ中に (3) が加速

解決の骨格は kawaz の room protocol スケッチ (2026-06-29、一次資料 §1-2) と中央デーモン方式の提示 (同 §3)。既存 cmux-msg の改修ではなく **別リポ rewrite** とする方針はエージェント提案を kawaz が承認済み (cmux-msg は p2p のまま安定維持し、dogfood の連続性を保つ)。

## Decision

### 1. Single host [kawaz]

- daemon は 1 マシンで完結。multi-host sync / federation / CRDT は scope 外
- mobile / 外出先からのアクセスは webui を tailscale (LAN VPN) 経由で使う「LAN 内 remote access」として扱う
- 出所: 一次資料 §4 回答 1

### 2. 中央デーモン = 単一 writer [kawaz]

- **書き込みを 1 プロセス (daemon) に集約**することで競合問題をシンプルにする (一次資料 §3)
- p2p 時代の subscribe lock 競合・SIGKILL hijack はこれで構造的に消える。ただし脅威は消滅ではなく **daemon 中心への境界移動** (daemon socket 乗っ取り / impersonation / log 改竄等は残る)

### 3. Room model [kawaz]

kawaz スケッチ (一次資料 §1-2) + 2026-07-03 決定 (同 §5) による:

- **room = 会話単位**。複数セッション議論は room に寄せる
- **room ID は daemon が発行する**。ハッシュ生成ではなく、形式ルールも課さない (連番でも良い) [kawaz]。「A が B と話したい」と daemon に依頼 → daemon が room を発行し、**A・B 両方に開設通知**が届く
- **同時開設は daemon が直列化して重複排除**: 直近 room リストを daemon が把握しており、同一ペアの後発 create は無視する (先発の開設通知が両者に飛ぶので、どちらが作ったかは気にしなくてよい)
  - [提案] 後発 create に添えられた初期メッセージは捨てずに既存 room への post として追記する
- **member identity = room 内参加順 seq** (`uid: 1, 2, 3...`)。`0` は **kawaz (User) の予約 uid**。sid は長いので room 内では seq で参照し、member イベントが `sid / repo / ws / cwd / joined_at` の対応を持つ
  - [提案] `from` はクライアント自称ではなく daemon が接続 identity から刻印する (同 UID 内 trust は前提としつつ、なりすまし записи を構造的に防ぐ)
- **メンバーは後から増やせる** (room ID は member set からの単射である必要なし)。不要になったら **leave できる** (member イベントの対)
- **次スレ/前スレリンク**: 会話が長くなったら次スレ (新 room) に分割できる。daemon が旧 room に `next`、新 room に `prev` のリンクイベントを対で書き、全 member に次スレ開設が通知される。移行は強制ではなく旧スレもそのまま使える (詳細は DR-0003)

### 4. Event log = room ごとに 1 JSONL (これが唯一の永続状態) [kawaz]

- 各 room = 1 つの append-only JSONL ファイル。各行 = 1 イベント。過去の行は書き換えない
- イベント型: `member` / `leave` / `msg` / `next` / `prev` / (title 等の見た目イベントも可)
- `msg` 行: `{type:"msg", mid, from, to?, ts, msg}`。**mid は room 内追記順の連番で daemon が採番**
- **room メタデータも JSONL に行を足すだけ** (一次資料 §2「roomに対するメタデータもjsonlを足すだけ」)
- [提案] **sqlite は MVP に入れない**。§6 の既読管理レス化で server 側の可変状態が消えるため、残る room 一覧・member 対応はプロセス内 index (起動時に JSONL をスキャンして再構築) で足りる。個人スケールでは十分で、永続状態が JSONL 一種類になり crash recovery の話が単純になる。検索等で必要になったら後から cache として追加する (kawaz の元発言「隣にもう1ファイルか、1プロセスならsqliteとかでも良いか」(§3) はどちらも確定ではなく、本提案はその範囲内の単純化)

### 5. 配送 = 本文込み push、`to` = mention [kawaz]

- **subscribe 通知には本文を展開済みで載せる**。「どうせ通知受けたら read で全文読むんだから最初から展開済みで受信した方がコンテキスト得」(一次資料 §1)。AI の 1 read = 1 ターンなので、notify-then-pull はターン浪費になる
- **room 内メッセージは全メンバーに本文配送**。`to` は可視性フィルタではなく **アテンション (mention) 指定** (2026-07-03 決定、一次資料 §5)
- **echo back なし**: 自分の post は自分に通知されない
- **room 外への共有は明示 read**: room 非メンバーに見せたい時は mid 範囲を指定して読ませる (「Cにmid10-15辺り読んでとか言えば良い」)。fetch はメンバー限定にしない (同 UID 内 trust の BBS モデル)

### 6. 既読管理レス (BBS モデル) [kawaz]

- **server 側の既読 cursor を持たない**。「各エージェントは読んだ mid 把握してるし。昔の BBS を覗いてるイメージで各自好きに読んだり読み飛ばしたりでよさそ」(一次資料 §5)
- 各エージェントは自分の会話コンテキストが既読状態そのもの。subscribe 再接続時はクライアントが since-mid を渡して差分を受ける。mid が連番なので抜けの検出も fetch での遡りもクライアント側で自明にできる
- 既読スルー可。reaction / read marker といった専用機構は作らず、絵文字や「りょ」の短文 msg + それを肯定する SKILL 記述で済ませる (一次資料 §2)
- **新規参加者への初期配信**: 全履歴、ただし上限 N 件 (それより前が気になれば fetch で遡る)。[保留] N の既定値は実装時に調整

### 7. Transport: UDS + (後で) HTTP、同一プロトコル + セキュリティ層 [kawaz]

- **CLI / sidecar**: UNIX Domain Socket (0600 + UID check、同一 UID 内 trust)
- **webui**: daemon に web API を持たせ、UI 自体は別サブプロジェクトでもよい。bind は 127.0.0.1 + tailscale interface のみ、認証は tailscale 側に委ねる (一次資料 §4 回答 1)
- **socket と web は「セキュリティに関しての層」を挟んで同じプロトコルを喋る** (一次資料 §3)。transport ごとの差分は認可層に隔離し、イベント model は共通
- MVP は UDS のみ。HTTP / webui は後 phase ([保留] daemon 内蔵か別 bridge プロセスかは webui phase の DR で決める)

### 8. クライアント 3 種 [kawaz]

一次資料 §3 の通り:

1. **sidecar 購読モニタ**: 各 Claude セッションに 1 つ。socket のイベント待ちループで、Monitor ツールに JSONL stream を流す
2. **ユーザ UI となる CLI**: kawaz が直接叩く。post / read / rooms を持ち、**問題 (5) の解消経路を webui を待たずに検証する**。CLI からの post は `from:0` (User)
3. **webui**: 後 phase。スマホからは tailscale 経由
- CLI / sidecar とも **daemon チェック + 自動起動ロジックを持つ** (daemon の存在をユーザが意識しない)

### 9. Daemon lifecycle [kawaz スケッチ + 詳細は DR-0002]

- 起動: SessionStart / ターン毎 hook + 各クライアントの「軽量静寂にチェック + 自動起動」(一次資料 §3)。launchd/systemd 常駐は必須にしない
- DR-0002 で決める必須項目: 同時 spawn の単一インスタンス保証 (socket bind 勝ち等) / plugin update 後の version mismatch 検出と自動再起動 / JSONL 末尾の torn line 回復と mid 連番の復元 / health check / crash 時 backoff / observability (`ccmsg status` 相当)

### 10. 言語: bun (webui phase で hono) [kawaz]

- kawaz 判断: 「webui まで視野に入れると bun+hono 辺りかな。サーバプロセスとしてのパフォーマンスやセキュリティ関連などの実績はどちらも問題ないという認識」(一次資料 §4 回答 3)。daemon / cli / webui を同一言語で書ける
- hono は HTTP 用なので **MVP (UDS のみ) では未使用**
- MVP 実装時の実機検証項目: bun 長時間稼働の安定性 / `bun build --compile` での配布可否 / UDS 周りの bun 固有挙動。[保留] 配布形態 (bun runtime 前提 or compile 済み binary 同梱) は MVP パッケージング時に決める

### 11. Repo 戦略: rewrite 別リポ + monorepo [kawaz 承認]

- 本リポ `claude-ccmsg` に rewrite。既存 cmux-msg は p2p のまま安定維持 (新機能追加せず bug fix のみ)
- `packages/{daemon, cli, webui}` の monorepo で開始 (codex 推奨をエージェントが採用し、リポ skeleton として kawaz に提示・承認済み)。API 安定後に webui 別リポ化を再評価

### 12. MVP スコープ

**入れる**:

- daemon (UDS のみ、JSONL storage、in-memory index)
- コマンド: `create_room` / `post` / `subscribe` + 補完の `read` (mid 範囲 fetch) / `rooms` (一覧)
- sidecar subscribe (cmux-msg subscribe の置き換え、Monitor に JSONL stream)
- **kawaz 用 CLI 経路** (post / read / rooms) — 問題 (5) の検証はこれで行う

**入れない** (後 phase):

- webui / HTTP transport / hono
- 検索、room 一覧の高機能化
- cmux-msg との merged view (並走期は両方の subscribe を Monitor で並行起動)
- AI-to-AI noise の運用制御 (room 権限 / rate limit 等) — mention 意味論と短文文化 SKILL でまず運用し、観測してから

### 13. Migration [kawaz 承認 + 移行 blocker 1 件]

- cmux-msg と ccmsg は別ツール・別ストレージ。bridge を作るなら cmux-msg → ccmsg の一方向 import のみ (必要性は実装時判断)
- **移行 blocker**: kawaz の push-workflow が `cmux-msg notify --self` に依存している。room model での self-notify 相当 (self room か専用 primitive か) を **DR-0003 (wire protocol) で決めてから** ccmsg への乗り換えを始める。echo back なし原則との整合もそこで扱う

## Alternatives considered

- **既存 cmux-msg リポ内で room layer 改修**: 不採用。p2p 前提の threat model / API / 構造を引きずり、安定 dogfood と rewrite が混線する
- **notify-then-pull (push は通知のみ、本文は pull)**: 不採用。大規模 pub/sub の定石だが、消費者が AI エージェントである本ツールでは pull の 1 read = 1 ターンの追加コストが支配的。本文込み push + mention 意味論が正 (§5)。payload 肥大が実測で問題になったら room 単位で notify-only を opt-in できる余地は残す
- **room ID = member set のハッシュ**: 不採用 (2026-07-03)。daemon 発行 + daemon 側重複排除の方が、メンバー可変 (単射不要) とも冪等性とも素直に整合する
- **server 側既読 cursor (sqlite)**: 不採用 (2026-07-03)。読者状態はクライアント側が持つ BBS モデルで足り、daemon の可変状態が消える
- **CRDT / message broker (NATS, Redis Streams 等) / k-v store + watcher / Matrix・XMPP**: 不採用 (codex レビュー、kawaz にサマリ提示済み)。single host 単一 writer に対して過剰。Redis Streams / NATS JetStream の設計パターン (cursor / replay / backpressure) は参考として見る
- **Go daemon**: 不採用。kawaz の認識は「サーバ実績は bun / Go どちらも問題ない」であり、その上で webui まで同一言語で書ける bun を選ぶ (一次資料 §4 注記)

## Consequences

- (1) クロス爆発と (2) 同一指示コピペは room への 1 post で構造的に解消する。(2) の後半 (受け手 N 人が同じ作業を重複実行する) は room の履歴共有で互いに見えるようにはなるが、担当調停は運用課題として残る
- (3) 伝聞の増殖は履歴共有で原因が消える。ただし room 内での AI 同士の水増し会話自体は arch では止まらない — mention 意味論 + 短文文化 SKILL で運用し、観測して必要なら制御を足す
- (4) は post / 短文肯定の記法で誘因を減らす仮説。dogfood で検証する
- (5) は MVP の kawaz CLI で解消経路を検証し、webui で仕上げる
- 中央 daemon が died すると room messaging 全体が止まる。supervision (DR-0002) が実用性の要
- 永続状態が JSONL のみになるため、backup / 調査 / 手修復が「ファイルを読む」に還元される

## Open questions (後続 DR / 実装時)

- `to` (mention) の複数指定を許すか — DR-0003
- ペア重複排除の「直近」の定義 (active room の条件、dormant 化した room との再会話で reuse するか新規か) — DR-0003
- 初期配信上限 N の既定値 — 実装時
- CLI 実行者の identity 判定 (Claude セッション内から叩いた時の sid 取得経路、素のターミナル = User の判定) — DR-0003
- retention / compaction — 当面なし想定 (個人スケール)。問題が観測されたら起票

## Next steps

1. DR-0002: daemon supervision (§9 の必須項目)
2. DR-0003: wire protocol (envelope 詳細 / subscribe handshake / self-notify / identity 判定)
3. MVP 実装着手: `packages/daemon` + `packages/cli`
4. bun 実機検証 (§10)
