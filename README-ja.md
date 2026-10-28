# claude-ccmsg

> 🇬🇧 [README.md](./README.md)

ccmsg web UI を支える中央デーモン。
この plugin の役目は daemon を起こしておくことだけで、hooks module はセッションの開始時に daemon が落ちていれば起動し、セッションのコンテキストには何も足さない。daemon は web UI のために常駐し (人間がセッション・transcript と、過去の room の読み取り専用のログを閲覧する)、web UI からの入力を Claude Code セッションの入力欄に入れて送る (そこで打ったのと同じ入力になる)。セッション同士は plugin の `send` tool で送り合い、daemon がそのメッセージを受け手のセッションへ直接届ける (`send_message`、[DR-0039](./docs/decisions/DR-0039-all-mods-and-typed-tools.md) §3)。

## Status

**MVP + web UI 実装済み。** アーキテクチャは [DR-0001](./docs/decisions/DR-0001-central-daemon-architecture.md) / [DR-0002](./docs/decisions/DR-0002-daemon-supervision.md) / [DR-0003](./docs/decisions/DR-0003-wire-protocol.md) / [DR-0004](./docs/decisions/DR-0004-webui-architecture.md) に記録し、その根拠は [docs/research/](./docs/research/) の逐語一次資料に置いてある。daemon / CLI / protocol / webui は `packages/` 配下に実装・テスト済み。

## インストール

[bun](https://bun.sh/) が必要 (CLI・daemon は bun で実行される)。

```
claude plugin marketplace add kawaz/claude-ccmsg
claude plugin install ccmsg-v1@ccmsg-v1
```

アップデート:

```
claude plugin marketplace update ccmsg-v1
claude plugin update ccmsg-v1@ccmsg-v1
```

plugin の `bin/ccmsg` は version 付きの plugin cache パス配下にあるため、既定では shell の `PATH` に無い。shell から使う時は、使いたい版の launcher を alias か、`PATH` 上の安定パスに置いた symlink で指す:

```
ln -sfn <plugin-cache>/bin/ccmsg ~/.local/bin/ccmsg
```

launcher は自分の版の CLI だけを動かし、`PATH` の `ccmsg` には触らない。plugin を update したら symlink を新しい版へ張り直す (古い版の cache が消えると symlink は切れる)。[DR-0032](./docs/decisions/DR-0032-repo-split-protocol-first.md) §2.2-4 参照。

## Web UI

daemon は既定で `http://127.0.0.1:8642` で web UI を配信する (人間用。セッション・ファイル・transcript と過去の room の読み取り専用のログの閲覧、セッションへの入力)。bind は loopback のみで、ブラウザからのアクセスは **`Origin` 検証**で制御する: loopback origin は既定で許可、このポートを前段に持つ `tailscale serve` 構成は自動検出して許可 (スマホ等の tailnet 越しリモートアクセスは追加設定なし)、その他の reverse proxy origin は `CCMSG_HTTP_ALLOW_ORIGIN` (カンマ区切り) で追加できる。source-IP allowlist (`CCMSG_HTTP_ALLOW`、既定 loopback) は defense in depth として併存し、`CCMSG_HTTP_BIND` (カンマ区切り `host:port`、`off` で無効) で bind を上書き可能。path はロケータ (`/r/<room>` = room のログ、`/r/<room>/m<mid>` = その中のメッセージ、`/s/<sid>/files` / `/s/<sid>/timeline/…` / `/s/<sid>/status` = セッション)。詳細は [webui-url-grammar](./docs/design/webui-url-grammar.md) と [DR-0004](./docs/decisions/DR-0004-webui-architecture.md)。

## `say` での発声

`ccmsg say` は引数をその位置のまま macOS の `/usr/bin/say` に渡して発声し、その前にどのセッションが喋ったかを daemon に知らせる。Claude Code セッションを複数走らせていると音声通知は「どれが鳴らしたか」が分からないため、web UI の Sessions 一覧では喋ったセッションに 📣 が付き、そのセッションの TL で発話内容と既読ボタン (押すとマーカーが消える) を確認できる。発話の記録と未読は daemon のメモリだけに持つので、daemon を再起動すると消える。発声の前に本文の単語を読み上げ辞書の読みに置き換え、`daemon` や `1Password` のような語を正しく読ませる。辞書は `${XDG_CONFIG_HOME:-~/.config}/ccmsg/say-dictionary.tsv` (`CCMSG_CONFIG_DIR` があれば `$CCMSG_CONFIG_DIR/say-dictionary.tsv`) で、1 行に `単語<TAB>読み`、`#` 始まりはコメント。ファイルを直接編集し、発声のたびに読み直す。辞書は同梱の `packages/cli/src/say-dictionary.default.tsv` にこのファイルを重ねたもので、同じ語はファイルが勝つ。1 行足すだけで始められる ([DR-0042](./docs/decisions/DR-0042-say-reading-dictionary.md))。

発声は記録に依存しない: session id が無くても、daemon が動いていなくても、daemon がイベントを拒否しても発声は行われる。`bin/say` は通常の `say` をこのコマンドに委譲する PATH shim で、これを PATH 上で `/usr/bin` より前に置けばマシン上のすべての `say` (自分・スクリプト・エージェント) がどのセッションのものか分かるようになる。PATH 上の `ccmsg` と同じ dir に**コピー** で置く (symlink にしないのは、参照先が version 付き plugin cache dir でupdate のたびに消えるため)。

## アーキテクチャ (詳細は [DR-0001](./docs/decisions/DR-0001-central-daemon-architecture.md))

- **Single host** — laptop or workstation 単独で完結、federation なし。mobile アクセスは tailscale 経由の LAN 内アクセス扱い
- **中央デーモン** (bun) — 動いているセッションの一覧を持ち、セッション間のメッセージを届け、web UI からの人の入力をセッションに入れ、web UI を配信する
- **ストレージ** — daemon はメッセージの状態を持たない: メッセージは送り手と受け手のセッションの transcript に残り、`ccmsg say` の記録はメモリだけに持つ。room のログ (`<data dir>/rooms/r<N>.jsonl`) は読み取り専用で、web UI が表示し、何も書き込まない ([DR-0036](./docs/decisions/DR-0036-retire-rooms-for-p2p.md) §2)
- **配送** — セッションは plugin の `send` tool で別のセッションに送り、daemon は受け手の peer messaging socket に直接書き込んで、届いたかを送り手に返す。後で送り直すために預かることはしない ([DR-0034](./docs/decisions/DR-0034-peer-socket-injection.md)、[DR-0036](./docs/decisions/DR-0036-retire-rooms-for-p2p.md) §1、[DR-0039](./docs/decisions/DR-0039-all-mods-and-typed-tools.md) §3)。web UI からの人の入力はセッションの入力欄に入れて送る ([DR-0035](./docs/decisions/DR-0035-user-input-via-composer-fill.md))
- **トランスポート** — ローカルクライアントは UNIX Domain Socket (`0600` + UID check)。webui は WebSocket (`/ws`) で同一プロトコル: セキュリティ層 = role を User に固定する identity pinning、接続元は loopback 限定 bind + source-IP allowlist (loopback、`CCMSG_HTTP_ALLOW`) + ブラウザ `Origin` 検証 (既定は loopback origin のみ、tailscale serve 等の追加は `CCMSG_HTTP_ALLOW_ORIGIN`) で審査
- **クライアント** — plugin の hooks module (`send` / `say` / `peers` / `launch` の tool と、人の入力を受けるサイドカー)、kawaz が直接叩くユーザ CLI (`peers`・`dump`・`status`・`daemon`・`stop` など。`notify` は justfile 等のスクリプトからセッションの会話に一言入れる)、web UI。CLI は daemon をヘルスチェックし、落ちていれば起動する

## ディレクトリ構成

```
packages/
  protocol/          # 共有型定義 (wire protocol / XDG paths / version)、概略は docs/design/protocol-package.md
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
