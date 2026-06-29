# claude-ccmsg

> 🇬🇧 [README.md](./README.md)

Claude Code セッション間メッセージング用の **中央デーモン方式**ツール。
[kawaz/claude-cmux-msg](https://github.com/kawaz/claude-cmux-msg) (p2p) の **rewrite** で、書き込みを単一デーモンに集約することで p2p の競合問題を構造的に解消し、room-based messaging と Web UI を追加する。

## Status

**Pre-MVP / 設計フェーズ。** アーキテクチャは [DR-0001](./docs/decisions/DR-0001-central-daemon-architecture.md) に記録。`packages/` 配下の実装は未着手。

旧来の `cmux-msg` (p2p) は `claude-ccmsg` が feature parity に達するまで **安定維持** されたまま使用可能。

## rewrite した理由

p2p 方式の `cmux-msg` は 1:1 メッセージングでは機能していたが、複数セッション dogfood で 5 つの構造的問題が露呈した:

1. **クロス爆発** — 4-5 peer 増えると pair-wise send が組合せ爆発
2. **同一指示の負担** — 同じ依頼を N peer にコピペ + N peer が同じ行動
3. **AI 間の無駄会話** — 別 peer について peer 同士で擦り合わせ
4. **メール調社交辞令** — `msg/send/reply` の語感が形式ばった long message を誘発
5. **kawaz 混入コスト** — kawaz は 1 peer ずつ宛先指定が必要、その間に AI が「kawaz がこう言ってた」と転送し合う

`claude-ccmsg` は (1)–(4) を room で構造解決、(5) を「kawaz も入れる単一 room」で解決する。

## アーキテクチャ (計画、詳細は [DR-0001](./docs/decisions/DR-0001-central-daemon-architecture.md))

- **Single host** — laptop or workstation 単独で完結。federation なし。mobile アクセスは tailscale 経由で LAN 内アクセス扱い
- **中央デーモン** (bun + hono) — room log とメタデータへの全書き込みを所有
- **ストレージ** — room ごとに append-only `jsonl` (= source of truth) + `sqlite` (= cursor / membership 等の再生成可能 cache)
- **トランスポート** — UNIX Domain Socket (`0600` + UID check) でローカルクライアント、HTTP で Web UI (`127.0.0.1` + tailscale interface のみ bind)
- **クライアント** — CLI (各 Claude session に subscribe sidecar) + Web UI、別 transport で同じ protocol を喋る

## ディレクトリ構成

```
.git/                  # bare repository
.jj/                   # jj default workspace
main/                  # 主要 jj workspace
  packages/
    daemon/            # 中央デーモン (bun + hono)
    cli/               # CLI クライアント (session sidecar 含む)
    webui/             # Web UI (hono SSR or SPA)
  docs/
    decisions/         # DR-NNNN (DR-0001 = central-daemon-architecture)
    issue/             # active issue (claude-local-issue plugin)
    findings/          # 確定事実
    journal/           # 時系列メモ
    runbooks/          # 運用レシピ
    research/          # 調査メモ
    knowledge/         # 静的ナレッジ
    design/            # 設計ドキュメント
  README.md  README-ja.md  LICENSE
```

## ライセンス

MIT — [LICENSE](./LICENSE) 参照。Copyright (c) Yoshiaki Kawazu.
