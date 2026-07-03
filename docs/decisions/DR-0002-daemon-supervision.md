# DR-0002: Daemon supervision & lifecycle

- **Status**: Accepted (2026-07-03)
- **Date**: 2026-07-03
- **前提**: [DR-0001](./DR-0001-central-daemon-architecture.md) §9 が本 DR に委譲した必須項目を確定する
- **記述規約**: DR-0001 と同じ ([kawaz] / [提案] / [保留])

## Context

daemon は「ユーザが存在を意識せず使える」lazy 常駐が要件 [kawaz]。launchd/systemd のような外部 supervisor に頼らず、クライアント側の「軽量静寂チェック + 自動起動」で成立させる。本 DR はそのための機構 (単一インスタンス保証 / version mismatch / crash 回復 / JSONL 耐久性 / observability) を確定する。

## Decision

### 1. Filesystem layout [提案]

- **runtime**: `${XDG_STATE_HOME:-~/.local/state}/ccmsg/` — `daemon.sock` / `daemon.lock` / `daemon.pid` / `daemon.log`
- **data**: `${XDG_DATA_HOME:-~/.local/share}/ccmsg/rooms/<room-id>.jsonl`
- runtime と data を分けるのは「消えて困るのは data だけ」を構造で表すため。UDS のパス長制限 (macOS 104 bytes) にも収まる

### 2. 起動経路: 全クライアントが同一の ensure-daemon を通る [kawaz]

- CLI / sidecar は接続前に ensure-daemon: connect 成功 → そのまま使う / 失敗 → spawn 手順へ
- SessionStart hook・ターン毎 hook も **同じ ensure を叩くだけ** (専用経路を作らない)。正常時のコストは connect 試行 1 回 [kawaz「軽量静寂にチェック+自動起動」]
- launchd/systemd への登録は行わない。[保留] 将来必要が観測されたら opt-in で追加

### 3. 単一インスタンス保証 [提案]

- `daemon.lock` への排他ロック獲得を daemon の存在権とする。socket bind はロック獲得後
- 同時 spawn race: 複数クライアントが同時に spawn を試みても、ロック勝者だけが daemon 化し敗者は即 exit。クライアントは backoff 付き接続リトライで勝者に繋がる
- stale socket: ロックが取れたのに `daemon.sock` が残っている場合は unlink して bind し直す (ロック保持者が正)
- ロック手段の実機確認は bun 検証 (docs/findings/) に従う

### 4. Version mismatch [提案]

- daemon は hello / pong 応答に自 `version` を含める
- クライアントは自分の version と比較し、不一致なら `{op:"shutdown", reason:"upgrade"}` を送って graceful stop させ、ensure 手順で新 version を spawn する (クライアント主導)
- graceful stop: 新規受付停止 → 接続中 client に `{ev:"restarting"}` → flush → exit。sidecar は自動再接続する
- plugin update 直後の「新 CLI vs 旧常駐 daemon」はこれで自動解消する

### 5. Crash 回復 [提案]

- 監視プロセスは置かない。crash → 次のクライアント接触 (ターン毎 hook 含む) で再 spawn される = 自然回復
- crash loop 対策はクライアント側: spawn リトライは exponential backoff (1s → 2s → 4s → 上限 30s)、5 回連続失敗で hook は 1 回だけ警告を出し、以降そのセッション中は沈黙する (静寂原則)

### 6. JSONL 耐久性と torn tail 回復 [提案]

- 書き込みは O_APPEND の行単位 append。**fsync は per-record にしない**: 100ms debounce + idle flush。個人スケールで喪失窓 (≤100ms) は許容し、書き込み単純性を優先
- 起動スキャン: 各 room file の最終行が JSON として parse 不能 (torn line) なら、その部分行を `<room-id>.torn-<ts>` に退避して truncate し、daemon.log に記録する
- mid 連番は起動スキャンで各 room の最終 msg 行から復元する (連番の正はファイル内容)

### 7. Health / observability [提案]

- protocol の `ping` → `pong` (DR-0003) を health check とする
- `ccmsg status`: daemon 生存 / version / uptime / pid / room 数 / 接続 client 数 / data dir を表示
- `daemon.log`: サイズ上限 (10MB 目安) で 1 世代ローテ。`ccmsg daemon run --foreground` でデバッグ起動可能
- 停止は明示 `ccmsg daemon stop`。**idle auto-shutdown はしない** (常駐コストは極小で、再 spawn 頻発の複雑性の方が高くつく)

## Alternatives considered

- **launchd / systemd 常駐**: 不採用 (MVP)。インストール手順が増え「意識せず使える」要件に反する。lazy spawn + ターン毎 hook で回復性は足りる
- **daemon の自己 version 監視 (バイナリ mtime watch 等)**: 不採用。更新は必ずクライアント接触を伴うので、クライアント主導比較の方が単純で確実
- **fsync per record**: 不採用。喪失窓 100ms の許容と torn 回復 (§6) の安全網を優先。性能実測で問題が出たら再検討
- **idle auto-shutdown**: 不採用。§7 の通り

## Open questions

- daemon.log のローテ形式 / 世代数 — 実装時
- crash loop 警告の文言・通知経路 (hook stderr か say か) — 実装時

## Next steps

1. bun 検証結果 (ロック手段 / UDS / compile) を findings で確認し、§3 の実装手段を確定
2. MVP 実装 (`packages/daemon`) で本 DR を実装
