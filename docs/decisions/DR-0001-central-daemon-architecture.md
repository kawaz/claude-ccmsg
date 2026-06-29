# DR-0001: Central daemon architecture

- **Status**: Proposed
- **Date**: 2026-06-29
- **Author**: kawaz (with AI agent integration / codex review)
- **Origin**: rewrite from [kawaz/claude-cmux-msg](https://github.com/kawaz/claude-cmux-msg) (p2p)
- **Source materials** (cmux-msg side, will be archived after this DR is Accepted):
  - `docs/issue/2026-06-29-central-daemon-architecture.md` — kawaz 方針 + codex review + kawaz レビュー回答
  - `docs/issue/2026-06-29-room-based-messaging-v2-proposal.md` — die セッションからの v2 提案

## Context

`cmux-msg` は Claude Code セッション間 messaging を **p2p (UNIX perm + lockfile + PID 検査)** で実装してきたが、kawaz の複数セッション dogfood で **5 つの構造的問題** が観察された:

1. **クロス爆発**: 1 対 1 通信のみで N peer 増えると組合せ爆発
2. **同一指示の負担**: kawaz が複数 peer に同じ依頼 → AI 双方が同じ行動 → 受け手の負担
3. **AI 間の無駄会話**: 「相手はああ言ってた」系の伝聞が peer 間で増殖
4. **メール調社交辞令**: `msg / send / reply` の語感が長文社交辞令を誘発
5. **kawaz 混入コスト**: kawaz が 1 peer ずつ宛先指定でコピペ、その間に AI 同士で「kawaz がこんなこと」を転送し合う

room-based-messaging v2 提案 (die セッション提案、kawaz レビュー済み) で `post / create_room` 中心の room layer が示されたが、**既存 cmux-msg を改修するのではなく、別リポで rewrite** する方針を取る。

理由:
- cmux-msg は p2p の threat model / API contract / lib 構造 / branding が p2p 前提に最適化されている
- room layer 追加は実質的に新規アーキ。改修よりも別物として作る方が cognitive load が低い
- cmux-msg は p2p 機能のまま **安定維持** することで、rewrite 完成までの dogfood 連続性を保てる

## Decision

### 1. Single host (multi-host scope 外)

- 1 マシン (laptop or workstation) で daemon が完結する設計
- multi-host sync / federation / CRDT eventual consistency は **明示的に scope 外**
- mobile / 外出先からのアクセスは **webui を tailscale (LAN VPN) 経由** で「LAN 内 remote access」として扱う (= 分散 messaging ではない)
- 想定されない (= 不要) なシナリオ:
  - laptop + workstation 並用 (= kawaz は基本 1 マシン)
  - SSH/tmux 越し他 host で Claude 起動 (= Claude 自体は host 上で完結、daemon は同 host で OK)
  - リモート同僚との room 共有 (= 個人ツール)

### 2. 中央デーモン (bun + hono)

- **書き込みを単一プロセスに集約**
- 構成: `packages/daemon/` 配下に bun + hono で実装
- 言語選定理由:
  - daemon + cli + webui を **同一言語で統一**できる
  - kawaz は bun 慣れあり、開発速度で勝る
  - サーバプロセスのパフォーマンス / セキュリティ実績は bun / Go 両方とも問題なし (Go は daemon 安定性で強い trade-off があるが、webui 統一の優位性が上回る)
- MVP 実装時に **実機検証する点**:
  - crash 特性 (bun runtime の長時間稼働安定性)
  - single binary 配布 (`bun build --compile`)
  - sqlite-WAL / UDS (UNIX Domain Socket) 周りの bun 固有挙動

### 3. Storage: jsonl (source of truth) + sqlite (cache)

- **room ログ = 1 room あたり 1 JSONL ファイル** (append-only, immutable)
- 各行 = 1 event: `{t: "msg"|"member"|"move"|..., mid, from, to?, ts, payload}`
- daemon が **mid (room 内 monotonic ID) を採番**
- **既読 cursor / membership / room メタデータ = sqlite** (regenerable cache、crash 時は jsonl から再構築可能)
- **source of truth は jsonl 一択**。sqlite が壊れたら jsonl から rebuild する

### 4. Transport: UDS + HTTP

- **CLI / sidecar**: UNIX Domain Socket
  - file mode `0600` + UID check (= 同一 UID 内 trust)
  - 内部 protocol (= MVP では line-delimited JSON)
- **Web UI**: HTTP via hono
  - bind は `127.0.0.1` + tailscale interface (`100.x.x.x`) のみ
  - 認証は **tailscale ACL に委譲** (= mTLS / token rotation / public origin 制限は MVP では不要)
  - 外部公開 (= public internet exposure) は **完全に scope 外**、必要になったら別 DR
- 内部 socket と HTTP は **同じ event model を流す** (= transport bridge のみが違う)

### 5. Auth boundary

- 同一 UID プロセス間 trust が前提 (= cmux-msg と同じ threat model)
- daemon socket: `0600` + UID check で同 UID 内 trust
- Web API: tailscale interface bind + tailscale ACL に認証委譲
- **「中央デーモン化で p2p の脅威が消える」のではなく、脅威の境界が変わる** (= 同 UID 内プロセス相互の局所脅威は消えるが、daemon socket 乗っ取り / daemon impersonation / web API 露出 / token 漏洩 / log 改竄 等の **daemon 中心の脅威に集中**する)

### 6. Repo 戦略: rewrite で別リポ

- 本リポ `claude-ccmsg` を新規作成 (= 本 DR の親リポ)
- 既存 `cmux-msg` は **p2p 機能のまま安定維持** (新機能追加禁止、bug fix と small refinement のみ)
- `cmux-msg` の DR-0013 (cmux-msg → ccmsg rename) は **不要化** (= 別リポなのでリネーム不要)
- migration:
  - cmux-msg と ccmsg は **完全に別ツール、別ストレージ**
  - merged view は作らない
  - 移行期は両方の subscribe を Monitor で並行起動
  - bridge を作るなら **cmux-msg → ccmsg の片方向 import だけ** (one-shot tool、必要性は実装時判断)
  - ccmsg が安定したら cmux-msg は deprecation

### 7. Repo 構造: monorepo

- `claude-ccmsg/packages/{daemon, cli, webui}/` で MVP 開始
- API 激変期は repo 分割摩擦が大きい → monorepo で開始
- 安定後に webui の別リポ化を再評価

### 8. MVP スコープ最小化

MVP に **入れる**:
- local daemon (UDS のみ、HTTP 後送り)
- `create_room` / `post` / `subscribe` の 3 コマンド
- jsonl room log + sqlite cursor
- minimal CLI (= cmux-msg `subscribe` の置き換えとして AI agent に line-delimited JSON stream を渡せる程度)

MVP に **入れない** (= 後 phase):
- web UI (HTTP transport, hono, ブラウザ UI)
- mTLS / public exposure
- mobile emergency access (= 当面 tailscale 経由で十分)
- 検索 / room 一覧の高機能化
- merged view (= cmux-msg と並走時の統合表示)
- AI-to-AI noise 抑制 (= room 権限 / mention 必須 / rate limit は post-MVP)

### 9. Daemon supervision (= 詳細は次 DR で)

- 起動経路: SessionStart hook spawn + (任意) launchd/systemd
- PID file + socket stale 検出
- health check (= ping/pong over socket)
- crash 時の exponential backoff
- crash counter (= N 回連続 crash で警告通知)
- partial write 対策: jsonl は **fsync per record** (= 性能影響は MVP 実装時測定)

詳細は別 DR (DR-0002 想定) で起こす。

### 10. Backpressure / queue overflow

- daemon push + sidecar subscribe で詰まらないように:
  - **per-client ring buffer** + **drop policy**
  - durable cursor は sqlite (= push 漏れは pull で取り戻せる)
  - **push は通知のみ、本文取得は pull** (= push payload を最小化)
  - **無制限 queue は禁止**

## Alternatives Considered

### A. cmux-msg リポを改修して room layer を追加

不採用:
- p2p 前提の threat model / API / lib 構造を引きずる
- 改修と新規追加の境界が曖昧になり cognitive load 増
- branding (cmux-msg) と新方式 (room/daemon) の不整合

### B. CRDT eventual consistency

不採用:
- multi-host を一級要件としない (= 1 host single writer なら CRDT 不要)
- CRDT は衝突解決 / 因果順序 / 削除編集意味論まで抱えるが、append-only chat log の価値を大きく増やさない
- multi-host を本気でやる場合だけ再検討対象

### C. Message broker (NATS / Redis Streams / MQTT / ZeroMQ)

不採用:
- 「個人 local plugin として意識せず使う」運用と外部 daemon 追加が衝突
- broker 採用は「常駐基盤」化を意味し、設計目的と衝突
- 設計パターン (durable consumer / ack / replay / backpressure) は参考にする (= Redis Streams, NATS JetStream)

### D. k/v store + watcher

不採用:
- watch の信頼性 / イベント順序 / 再送 / cursor / compaction を自前で再実装することになる
- jsonl + sqlite のほうがイベントログと可変メタを分ける点で素直

### E. Go (daemon) + 別言語 (webui)

不採用:
- daemon + cli + webui を同一言語で統一できる利点を捨てることになる
- Go の daemon 安定性 / 配布 single binary は魅力だが、kawaz の開発速度 (bun 慣れ) と統一性が上回る

### F. Matrix / XMPP

不採用 (cautionary tale):
- federation / event graph / state resolution は local Claude session messenger には過剰
- XMPP の extension 地獄 / client 互換性問題を持ち込まない

## Consequences

### Positive

- 書き込み 1 点集約で **subscribe lock 競合 / SIGKILL hijack / sid spoof の局所脅威が消える**
- room layer で **5 つの構造問題の (1)–(4) が構造解決される**
- webui で **(5) も部分解決**: kawaz が同じ room に post すれば全 peer に届く

### Negative / 注意

- 脅威の **境界が変わる** だけで消えるわけではない (上記 §5)
- 中央デーモン crash で全 room messaging が止まる (= supervision 強化が必要、DR-0002 で詳細化)
- p2p 時代より **インストール / ライフサイクル管理が複雑** (= daemon spawn / lock / health check)
- cmux-msg と並走期間の cognitive load (= 2 ツールの存在を認識する必要)

### AI-to-AI noise は arch だけでは解けない

room を導入しても、AI が「ねえ X、これどう思う?」を post し続ければ context は浪費される。対策は arch ではなく **運用レイヤ**:

- room 権限 (= 誰が post できるか)
- mention 必須 (= `@user` mention がない post は宛先不明として弾く / 通知抑制)
- bot-to-bot 自動投稿制限
- per-room rate limit

これらは MVP 後に観測ベースで追加する。

## Open questions (= 後続 DR / 実装時判断)

- room ID 命名: random UUID/ULID + human display name か、hash か
- read cursor の粒度: `(room_id, principal_id, device_id?)` か単純に `(room_id, principal_id)` か
- message envelope の最小フィールド: `{type, room, mid, from, to?, ts, payload}` で十分か、`seq / causality / schema_version / client_msg_id` を MVP に入れるか
- daemon 自動起動 trigger: SessionStart hook 単独で十分か、launchd/systemd 経路も MVP に必要か
- sidecar 抽象: 「CLI subscribe コマンドの常駐実装」で十分か、独立した subscriber framework が必要か (codex は前者推奨)

## Next steps

1. **本 DR を Accepted に上げる** (= kawaz 最終確認後)
2. **DR-0002: Daemon supervision detail** を起こす
3. **DR-0003: Wire protocol** を起こす (= socket + HTTP で共通の event envelope)
4. **MVP 実装着手**: `packages/daemon/` に bun + hono の skeleton、`packages/cli/` に subscribe sidecar
5. **bun 実機検証**: crash 特性 / single binary 配布 / sqlite-WAL / UDS の dogfood
