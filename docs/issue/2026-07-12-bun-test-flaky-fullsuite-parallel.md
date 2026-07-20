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
