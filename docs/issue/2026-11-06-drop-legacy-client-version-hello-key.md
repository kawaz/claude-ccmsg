---
title: hello の旧名 client_version の受け口を外す
status: open
category: task
created: 2026-11-06T10:22:39+09:00
last_read:
open_entered: 2026-11-06T10:22:39+09:00
wip_entered:
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

# hello の旧名 client_version の受け口を外す

## 概要

hello の wire field `client_version` は `ccmsg_version` に改名した (`claude_version` と並ぶと何の client の版か読めないため)。移行期間として、daemon は `daemon.sock` の hello (`HelloRequestSchema` / `OtherGenerationHelloRequestSchema`、`packages/protocol/src/request-sessions.ts`) と `POST /op` の body の hello (`OpHelloSchema`、`packages/daemon/src/op-http.ts`) で旧名 `client_version` も受け、`helloCcmsgVersion` で `ccmsg_version` として扱う (両方あれば `ccmsg_version`)。名前を変える前に読み込まれた module はセッションを再起動するまで旧名で送るため。

## 背景

旧名を受けないと、再起動していない旧 module のセッションが peer の行で「版数不明」になり、TL 下の状態行の `ccmsg v…` も出なくなる。前例は issue `drop-legacy-session-launcher-keys`。kawaz 2026-11-06 の裁定。

## 受け入れ条件

- [ ] 旧 module (改名前の版) のセッションが全部再起動されたことを確認する (旧 module が全部再起動された後に落とす)
- [ ] `HelloRequestSchema` と `OpHelloSchema` から `client_version` を外し、`helloCcmsgVersion` を `hello.ccmsg_version` の直読みに戻す (`server.ts` の `readClientBuild` / `claimedHello`、`http.ts` の `pinHelloToUser`、`op-http.ts` の greeting)
- [ ] `OtherGenerationHelloRequestSchema` の `client_version` は、別世代の古い client が送り続けるので残すかどうかをその時に判断する
- [ ] 移行のテストを外す (`packages/daemon/test/protocol-version.test.ts` の「a hello naming its build by the old name client_version is read as ccmsg_version」、`packages/daemon/test/op-http.test.ts` の「the build the hello names, by the old name client_version too」)
- [ ] DR-0046 §3 の「移行期間」の項を消す
