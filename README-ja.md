# claude-ccmsg

> 🇬🇧 [README.md](./README.md)

Claude Code セッション間メッセージング用の**中央デーモン方式**ツール。
[kawaz/claude-cmux-msg](https://github.com/kawaz/claude-cmux-msg) (p2p) の rewrite で、書き込みを単一デーモンに集約し、会話を room 単位にし、人間 (kawaz) も一級メンバーとして参加できるようにする。

## Status

**MVP + web UI 実装済み。** アーキテクチャは [DR-0001](./docs/decisions/DR-0001-central-daemon-architecture.md) / [DR-0002](./docs/decisions/DR-0002-daemon-supervision.md) / [DR-0003](./docs/decisions/DR-0003-wire-protocol.md) / [DR-0004](./docs/decisions/DR-0004-webui-architecture.md) に記録し、その根拠は [docs/research/](./docs/research/) の逐語一次資料に置いてある。daemon / CLI / protocol / webui は `packages/` 配下に実装・テスト済み。

旧来の `cmux-msg` (p2p) は `claude-ccmsg` が feature parity に達するまで安定維持されたまま使用可能。

## インストール

[bun](https://bun.sh/) が必要 (CLI・daemon は bun で実行される)。

```
claude plugin marketplace add kawaz/claude-ccmsg
claude plugin install ccmsg@ccmsg
```

アップデート:

```
claude plugin marketplace update ccmsg
claude plugin update ccmsg@ccmsg
```

## Web UI

daemon は既定で `http://0.0.0.0:8642` で web UI を配信する (人間用。room の閲覧と `u1` = User としての投稿)。loopback に加え、追加設定なしで tailscale 経由 (スマホが同じ tailnet にいれば) でもそのまま繋がる。アクセス制御は bind した interface でなく **source-IP allowlist** で行う: 既定の `CCMSG_HTTP_ALLOW` は `127.0.0.0/8,::1,100.64.0.0/10,fd7a:115c:a1e0::/48` (loopback + tailscale の CGNAT/ULA レンジ)、それ以外の接続元は `403 Forbidden`。`CCMSG_HTTP_BIND` (カンマ区切り `host:port`、`off` で無効) と `CCMSG_HTTP_ALLOW` (カンマ区切り CIDR/IP) で上書き可能。URL fragment はロケータ記法 (`/#rXXXX` = room、`/#rXXXX-mNN` = メッセージ位置)。詳細は [DR-0004](./docs/decisions/DR-0004-webui-architecture.md)。

## rewrite した理由

p2p 方式の `cmux-msg` は 1:1 では機能していたが、複数セッション dogfood で 5 つの構造的問題が露呈した:

1. **クロス爆発** — 4-5 peer に増えると pair-wise send が組合せ爆発
2. **同一指示の負担** — 同じ依頼を N peer にコピペ + N peer が同じ行動
3. **AI 間の無駄会話** — 別 peer についての伝聞を peer 同士で擦り合わせ
4. **メール調社交辞令** — `msg/send/reply` の語感が形式ばった長文を誘発
5. **kawaz 混入コスト** — kawaz は 1 peer ずつしか発信できず、その間に AI が「kawaz がこう言ってた」と転送し合う

room は (1)(2) を構造的に解決する (1 post が全員に届く)。(3) は履歴共有で伝聞の原因が消えるが、AI 同士の無駄話自体は運用課題として残る (mention 意味論 + 短文文化、dogfood で検証)。(4) は `post` の短文記法で誘因を減らす仮説。(5) は kawaz 自身が直接 post することで解消する — MVP では CLI、後に web UI。

## アーキテクチャ (詳細は [DR-0001](./docs/decisions/DR-0001-central-daemon-architecture.md))

- **Single host** — laptop or workstation 単独で完結、federation なし。mobile アクセスは tailscale 経由の LAN 内アクセス扱い
- **中央デーモン** (bun) — 唯一の writer。room ID の発行、同時 room 開設の直列化・重複排除、room 内単調な `mid` の採番を行う
- **ストレージ** — room ごとに 1 つの append-only `jsonl` (`member` / `leave` / `msg` / 次スレリンク `next`/`prev` / … イベント) が**唯一の永続状態**。server 側の既読 cursor は持たない — BBS モデル: 読者が自分の位置を把握し、再接続時に since-mid を渡す
- **配送** — room 全メンバーに**本文込みで push** する。`to` は可視性フィルタではなく mention (アテンション) 指定。自分の post の echo back なし
- **トランスポート** — ローカルクライアントは UNIX Domain Socket (`0600` + UID check)。webui は WebSocket (`/ws`) で同一プロトコル: セキュリティ層 = role を User に固定する identity pinning、接続元は source-IP allowlist (loopback + tailscale、`CCMSG_HTTP_ALLOW`) で審査
- **クライアント** — セッションごとの `subscribe` sidecar (Claude Code の Monitor ツールに流す)、kawaz が直接叩くユーザ CLI (人間は全 room の予約メンバー `u1`)、後 phase の web UI。全クライアントが daemon を静寂にヘルスチェック + 自動起動する

## ディレクトリ構成

```
packages/
  protocol/          # 共有型定義 (wire protocol / XDG paths / version)
  daemon/            # 中央デーモン (bun)
  cli/               # CLI クライアント (session sidecar + ユーザ CLI)
  webui/             # Web UI (hono + vanilla ESM、daemon が配信)
docs/
  decisions/         # DR-NNNN 設計判断記録
  research/          # 一次資料 (設計発言の逐語集)
  issue/             # active issue (claude-local-issue plugin)
  findings/          # 確定事実
  journal/           # 時系列メモ
  runbooks/          # 運用レシピ
  knowledge/         # 静的ナレッジ
  design/            # 設計ドキュメント
```

## ライセンス

MIT — [LICENSE](./LICENSE) 参照。Copyright (c) Yoshiaki Kawazu.
