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
- graceful stop: 新規受付停止 → 接続中 client に `{ev:"restarting"}` → 後継 daemon と競合する全資源 (listen port、pid file、lock 等) の解放 → UDS listener 停止 → exit。UDS 接続不能が旧 daemon の停止完了を示す唯一の境界なので、UDS close は競合資源の後片付けの最後に行う。socket pathname は lock を得た後継の起動時 cleanup に委ねる。sidecar は自動再接続する
- plugin update 直後の「新 CLI vs 旧常駐 daemon」はこれで自動解消する
- **追補 (2026-07-10)**: 不一致判定は等値ではなく **newer-wins** (client が自分の version と daemon の version を比較し、client の方が厳密に新しい場合のみ shutdown+respawn。daemon が同じか新しければ何もしない)。理由: gradual rollout で新旧 client が同時に daemon へ接触すると、等値比較では互いに相手を降格させ合うフラッピングが発生する (docs/issue/2026-07-10-daemon-version-flapping-on-gradual-rollout.md)。比較は `@ccmsg/protocol` の `compareVersions`

#### 設計意図: 最新であるべきは daemon プロセスだけ (2026-09-03)

- **`subscribe` は daemon の更新をまたいで生き続ける**。daemon が新しくなっても subscribe プロセスは再起動しないし、更新されたことをセッションに通知もしない。subscribe の責務は「通知をセッションに出す」ことだけで、自分自身の version は責務ではない
- 根拠: 以前は daemon 更新のたびに subscribe を自動再起動していたが、その通知と再接続がセッションのコンテキストを毎回浪費するので撤廃した。同じ理由で「daemon が新しいので張り直してください」という案内も出さない
- subscribe プロセスは起動時の plugin cache (`$CLAUDE_CONFIG_DIR/plugins/cache/ccmsg/ccmsg/<version>/`) から bun がソースを実行するが、**起動後はその cache ディレクトリに依存しない** (CLI 経路に動的 import は無く、必要なコードは起動時にオンメモリ。稼働中の subscribe が開いている cache 内ファイルは lsof で 0 件、2026-09-05 実測)。旧 version のディレクトリが消えても走行中の subscribe は影響を受けない
- したがって **subscribe が使う経路 (hello / subscribe / イベント配信 / 再接続) を変えるときは、旧 version の subscribe が通らなくなることを意識的に決める**。壊れるかどうかを先に確認し、壊すなら次項の手順 (DR に記録) を踏む。壊さないために互換分岐を足すのではない (次々項)
- **「旧 subscribe が黙って再接続を続ける」のは仕様であって不具合ではない**。再起動しないこと自体を不具合と見て「直さねば」と動かない (fail-fast も自動再起動も、上のコンテキスト浪費に戻る)
- **後方互換は原則実装しない** (host 単位で丸ごと進化するイメージ。ccmsg は kawaz の 1 ホストに閉じた系で、新旧が併存する配布先を持たない)。互換のために形を残す・分岐を足すのは禁止で、必要に見えた時は**実装せず kawaz に相談する** (kawaz r259m33)
- **互換を切る場合は意図的な判断として DR に理由を書く**。切った時点で旧 subscribe は再接続しても通らなくなるので、**セッション側での張り直しが必要になる**ことも併せて記録する。実例: v0.136.0 の `request_id` 必須化 (DR-0029 追補) — 互換経路は意図的に設けない裁定 (kawaz r259m32) で、旧 subscribe は張り直しで解消する

### 5. Crash 回復 [提案]

- 監視プロセスは置かない。crash → 次のクライアント接触 (ターン毎 hook 含む) で再 spawn される = 自然回復
- crash loop 対策はクライアント側: spawn 後の接続確立を短い間隔 (25ms → 3000ms、計 12 回) でリトライし、
  全て失敗したら `throw` してエラーを呼び出し元に伝播させる。hook 側の warn-once + 沈黙のような専用状態管理は置かない
  (エラーは hook の `try/catch` を通じて自然に表面化するため、追加の通知ロジックを持つ複雑さに見合う価値がない)
- **追補 (2026-07-10)**: 当初案は「5 回連続失敗で 1 回だけ警告し以降そのセッション中は沈黙する」だったが、
  実装 (`packages/cli/src/client.ts` の `connectWithSpawn`) は上記の retry→throw のみで完結しており、
  セッション単位の警告状態は持っていない。乖離が codex レビュー (2026-07-10, Minor 2) で指摘され、
  実害が小さい (daemon 起動失敗時に best-effort の hook が理由を出せないだけ) ことを確認したうえで、
  DR を実装の実挙動に合わせて簡略化した (詳細評価: `docs/findings/2026-07-10-codex-review-evaluation.md`)

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

## Next steps

1. bun 検証結果 (ロック手段 / UDS / compile) を findings で確認し、§3 の実装手段を確定
2. MVP 実装 (`packages/daemon`) で本 DR を実装
