---
title: bun test フルスイート並列実行時に稀に 1 件 fail する flaky の追跡
status: wip
category: bug
created: 2026-07-12T17:40:21+09:00
last_read: 2026-07-21T02:56:29+09:00
open_entered: 2026-07-12T17:40:21+09:00
wip_entered: 2026-07-21T03:05:15+09:00
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered:
discard_reason:
pending_reason:
close_reason:
blocked_by:
origin: 自リポ TODO
---

# bun test フルスイート並列実行時に稀に 1 件 fail する flaky の追跡

## 概要

`bun test` をフルスイートで並列実行したとき、稀に 1 件だけ fail するケースが観測されている。
`test-failure-no-tampering` ルールに基づき、根拠なく「flaky」ラベルで蓋をせず、
fail するテスト名の確定と不安定さの軸の特定を進めるための追跡 issue。

## 背景

観測事実 (いずれも未確定 / 単発観測):

- (a) 2026-07-12 Wave6 worker が `hooks/user-prompt-submit.test.ts` の fail を 1 回観測。
  単独実行では green、フルスイート再実行でも green (再現せず)
- (b) 同日メイン監査で 705 tests 中 1 fail を 1 回観測。直後の再実行 2 回は green。
  fail したテスト名はログ取得前に流れてしまい未特定

傾向 (推測含む、要検証):

- フルスイート並列実行 (31 ファイル、daemon プロセス多数 spawn) の高負荷時のみ発生する模様
- 再現率は体感 1/4 程度 (サンプル数不足、機械的閾値ではない)

未特定事項:

- fail するテスト名の確定 (b の事例は未特定のまま)
- 不安定さの軸: プロセス数上限 / ポート競合 / tmpdir 競合 / タイマ遅延のいずれが原因か未特定

## 受け入れ条件

- [ ] `bun test` フルスイート実行の出力を `tee` 等でファイルに保存する監査手順を確立し、fail 時にテスト名を確実に確定できるようにする
- [ ] 上記手順で複数回のフルスイート実行を行い、fail するテスト名を再現込みで確定する
- [ ] 不安定さの軸 (プロセス数上限 / ポート競合 / tmpdir 競合 / タイマ遅延) を観測データで切り分ける
- [ ] 軸が特定できたら根本対策 (fixture 分離 / タイムアウト調整 / 並列度制御等) を実施するか、対策不能なら `#[ignore]` 相当の明示 skip + 追跡理由を残す

## TODO

- [ ] `bun test` 実行を `tee` でログ保存するラッパー/手順を用意する
- [ ] フルスイートを複数回 (最低 3-5 回) 実行してログを収集する
- [ ] 収集ログから fail テスト名と発生パターンを集計する

## 追記: 2026-07-16 別ケースの flaky を観測

v0.39.0 CI (run 29502365995, ubuntu-latest) で別の flaky を観測 —
`packages/cli/test/reconnect.test.ts:170`「daemon 再起動を跨いで subscribe が生存し、
跨ぎ前後の post が両方 stdout に出る」が 10154ms で fail (timeout 様)。
webui のみの変更 (daemon/cli 無変更) なので変更起因ではなくフルスイート並列時の timing。
単発 rerun --failed で追試中。既知の tailscale origin 系 (上記 (a)(b)) とは別ケースとして記録。

## 追記: 2026-07-21 tailscale origin auto-allow の真因を実機確定 (opus47-high 調査)

最頻 fail である tailscale origin auto-allow について真因を実機で確定した。

- `tailscale-origin.ts` の subprocess timeout 1000ms (`AbortSignal.timeout`) が、高負荷時に
  fake-tailscale を gate 到達前に SIGKILL してしまう
- 結果として空の Set が返り、`waitForOriginAllowed` が 4000ms で fail する
- 8 並列実行で 5/8 fail を再現。timeout を 30s に伸ばすと 8/8 pass する反証実験で機序を確認済み

修正方針: `CCMSG_TAILSCALE_STATUS_TIMEOUT_MS` env の読み口を追加し、テスト側は `extraEnv` で
10000ms に設定する。production のデフォルトは 1000ms のまま据え置き (DR-0004 の判断を維持)。
現在実装中。

注: issue に記載した他のテストの散発 fail (hooks / reconnect 等) が同一機序かどうかは
未調査のため、この issue はまだ close しない。

## 追記: 2026-07-21 2 件目の同型根治

`hooks/session-start.test.ts` の `getRepoWsFromVcs` 系 5 テスト (v0.68.3) で同型の flaky を根治。

真因は共通 deadline 方式の `timeoutMs:500` が 8 並列負荷下で `sh` spawn 遅延により
超過し、空フォールバックとなること (503-506ms fail を実測)。テスト側の保険値を
10000ms に引き上げて対応 (timeout 機構検証テストと production のデフォルトは据置)。
8 並列 x 8 反復で 0 fail を確認。

パターン確立: 「短い固定 timeout × 高負荷」が本 issue の主な機序と判明
(tailscale origin の件と同型)。残りの散発 fail (TranslationHelperService の
watchdog 系 / bin/ccmsg self-update の timeout 系 / agents polling 系 /
reconnect timeout) も同型の疑いが濃厚。次に full suite で fail を観測した際、
同パターンで各個撃破する。

## 追記: 2026-07-21 08:06 tailscale origin auto-allow の第 2 故障モードを確認

push gate で tailscale origin auto-allow が再 fail。ただし v0.68.2 で根治した機序
(`waitForOriginAllowed` 4000ms timeout) とは別モードで、`tooSoon` fetch
(`http-transport.test.ts:641`) が 127ms で `ConnectionRefused` — daemon HTTP port へ
接続不可。issue 当初観測 (ConnectionRefused) は実在する第 2 の故障モードだったことが
確定 (前回調査の「ConnectionRefused は誤り」は当該再現分についてのみ正しかった)。

単体 rerun green、fail 時 load 16。

次回調査時の観点: `startTestDaemon` の HTTP listen ready 判定 (`waitConnectable` が
UDS のみで HTTP port の listen を待っていない可能性)、port 払い出しと listen 完了の race。

## 追記: 2026-07-21 3 件目の根治 (v0.71.1) — tailscale origin auto-allow 第 2 モードの根治

tailscale origin auto-allow の第 2 モード (`tooSoon` fetch の `ConnectionRefused`) を根治。

真因は構造的な race: 当該テストのみ `freeTcpPort` の pre-known port を使い、
`httpAddress()` (UDS ping = HTTP bind 完了後にしか返らない implicit wait) を
経由しないため、UDS ready → HTTP bind 完了までの ~100ms の窓に fetch が刺さる。
port 奪取説は失敗形態 (`ConnectionRefused` ≠ 別プロセス応答) で棄却、高負荷起因説は
load<8 での再現で棄却。

修正: fetch 前に `waitHttpConnectable` (25ms retry / 5s 上限) を挿入。daemon full
suite で 5 連続 0 fail を確認。これで tailscale origin の既知 2 モードは両方根治した。

残る散発 fail 候補 (いずれも「短い固定 timeout × 高負荷」同型の疑い、未調査):
TranslationHelperService watchdog 系 / agents polling 系 / bin/ccmsg self-update
timeout 系 / reconnect timeout。

## 追記: 2026-07-22 4-5 件目の根治 (commit 53825794)

`translate-helper.test.ts` (parallel queue の deadline 800ms ギリギリ設計 +
realHelperTest の Swift cold spawn 5000ms 不足) と `bin/ccmsg.test.ts`
(bash launcher spawnSync が負荷下 5000ms 超過) を根治。いずれも「短い固定
timeout × 高負荷」同型、8 並列で 100% 再現 → 0 fail。

残り 2 系統 (agents polling / reconnect) は 24 並列でも再現せず — 後続改修
での緩和 or load 16+ 限定の可能性、次に full suite fail を観測した時に
再調査する運用とする。既知 flaky はこれで全て根治 or 再現不能となったため、
次の安定期間を見て issue close を検討。
