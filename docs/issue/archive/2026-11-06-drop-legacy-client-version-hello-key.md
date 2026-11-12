---
title: hello の旧名 client_version の受け口を外す
status: resolved
category: task
created: 2026-11-06T10:22:39+09:00
last_read:
open_entered: 2026-11-06T10:22:39+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-11-12T22:57:15+09:00
discard_reason:
pending_reason:
close_reason: ["implemented"]
blocked_by:
origin: 自リポ TODO
---

# hello の旧名 client_version の受け口を外す

## 概要

hello の wire field `client_version` は `ccmsg_version` に改名した (`claude_version` と並ぶと何の client の版か読めないため)。移行期間として、daemon は `daemon.sock` の hello (`HelloRequestSchema` / `OtherGenerationHelloRequestSchema`、`packages/protocol/src/request-sessions.ts`) と `POST /op` の body の hello (`OpHelloSchema`、`packages/daemon/src/op-http.ts`) で旧名 `client_version` も受け、`helloCcmsgVersion` で `ccmsg_version` として扱う (両方あれば `ccmsg_version`)。名前を変える前に読み込まれた module はセッションを再起動するまで旧名で送るため。

## 背景

旧名を受けないと、再起動していない旧 module のセッションが peer の行で「版数不明」になり、TL 下の状態行の `ccmsg v…` も出なくなる。前例は issue `drop-legacy-session-launcher-keys`。kawaz 2026-11-06 の裁定。

## 受け入れ条件

- [x] 旧 module (改名前の版) のセッションが全部再起動されたことを確認する (旧 module が全部再起動された後に落とす)
- [x] `HelloRequestSchema` と `OpHelloSchema` から `client_version` を外し、`helloCcmsgVersion` を `hello.ccmsg_version` の直読みに戻す (`server.ts` の `readClientBuild` / `claimedHello`、`http.ts` の `pinHelloToUser`、`op-http.ts` の greeting)
- [x] `OtherGenerationHelloRequestSchema` の `client_version` は、別世代の古い client が送り続けるので残すかどうかをその時に判断する
- [x] 移行のテストを外す (`packages/daemon/test/protocol-version.test.ts` の「a hello naming its build by the old name client_version is read as ccmsg_version」、`packages/daemon/test/op-http.test.ts` の「the build the hello names, by the old name client_version too」)
- [x] DR-0046 §3 の「移行期間」の項を消す

## 解決の記録 (v0.264.0)

1. v0.264.0 で外した。今の世代の hello のスキーマ (`packages/protocol/src/request-sessions.ts` の `HelloRequestSchema`、`packages/daemon/src/op-http.ts` の `OpHelloSchema`) から `client_version` を消し、版は `ccmsg_version` だけを直に読む。外した後は、`client_version` だけを送る今の世代の client は断られず、そのキーは黙って落とされて、版を名乗らない client と同じ扱いになる (スキーマが strict でないため)。`packages/daemon/test/protocol-version.test.ts` の 1 件で固定。
2. 別の major の client の hello を読んで断る経路 (`OtherMajorHelloRequestSchema` と `server.ts` の `refuseOtherMajor`) は、今も `ccmsg_version ?? client_version` を読む (別世代の client が送る形をそのまま読むためのもので、今回の対象外)。そのための関数は `otherMajorCcmsgVersion` に改名し、別の major の hello だけを受ける型にした。
3. 待っていた条件の確認 (2026-11-12): 接続中のセッションの module の版の最小は 0.240.0 で、改名した v0.214.0 より新しい。daemon.log に `hello client_version=` が最後に出たのは 2026-11-06 (webui の 0.213.2)。v0.264.0 に上げた後の `ccmsg peers` で、14 セッション全部に版が付いている。
4. `PROTOCOL_VERSION` は上げていない: DR-0002 §4 の決まり (hooks の bundle が変わるかで決める) に照らし、bundle は変わらず、module はもともと旧名を送っていない。push の check-protocol-bumped も通った。
5. 文書: DR-0046 §3 の移行期間の項を消した。
6. 残る影響: v0.214.0 より前の webui を読み込み直さずに開いたままのタブは、版数不明と表示される (読み込み直せば直る)。
