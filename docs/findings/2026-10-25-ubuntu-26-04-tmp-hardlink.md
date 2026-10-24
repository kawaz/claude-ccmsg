# ubuntu-26.04 の runner で writeMockBin が hard link でなく copy になる

- Date: 2026-10-25

## 判明した事実

- CI の `ci (ubuntu-latest)` の runner image が変わった。run 39915261949 (2026-10-23、Release v0.193.3、success) は `Image: ubuntu-24.04` / `Version: 20261012.334.1`、run 40143233886 (2026-10-24、docs のみの commit、failure) は `Image: ubuntu-26.04` / `Version: 20261012.163.1`。コードの変更は無い
- 失敗したのは `packages/testkit/test/mock-bin.test.ts` の `the mock is a hard link to the shared shim, and is executable` の 1 件だけ (4244 pass / 1 fail)。2 つの mock の inode が `Expected: 8639` / `Received: 8636` で一致しなかった
- Ubuntu 26.04 は systemd の `tmp.mount` を既定で有効にしており、`/tmp` は tmpfs (RAM の 50 %、`usrquota` 付き) になる。runner-images の ubuntu-26.04 もこの既定のままだった (actions/runner-images issue #14777、出典は Ubuntu 26.04 の release notes の summary-for-lts-users)
- runner-images は PR #14814 (2026-10-20 merge) で ubuntu-26.04 の image で `tmp.mount` を mask し、`/tmp` を root disk に戻した (`images/ubuntu/scripts/build/configure-environment.sh`)。この commit は image `ubuntu26/20261023.163` には含まれ、失敗した run の `ubuntu26/20261012.163` には含まれない (GitHub の compare API で確認)
- テストの temp space は preload が作る `/tmp/ccmsg-run-XXXXXX` (`packages/testkit/src/tmp.ts` の `openRunTmp`) で、runner の root disk 上の checkout とは別の場所。`/tmp` が tmpfs なら shim (repo の `packages/testkit/src/exec-shim`) と mock は別 filesystem になり、`fs.linkSync` は使えず `writeMockBin` は copy に落ちる。copy は mock ごとに別 inode なので、テストの「2 つの mock が同じ inode」が成り立たない
- macOS で shim を別 device (HFS+ の disk image を `hdiutil attach` したもの) に置き、TMPDIR は system volume のままにすると、同じテストが同じ形で落ちた (`Expected: 561845461` / `Received: 561845458`)

未検証: 失敗した run の中で `fs.linkSync` が実際に EXDEV を投げたこと。`writeMockBin` は例外を握って copy に落ちるのでログに出ない。inode が小さい連番 (8636 / 8639) なのは tmpfs の割り当てと矛盾しないが、それだけでは決め手にならない。

## 実用的な示唆 / ベストプラクティス

- `writeMockBin` が hard link を作れるのは shim と temp space が同じ filesystem の時だけで、そうでない時の copy は実装が明文化している正しい経路。テストは「常に hard link」ではなく、この 2 経路をそれぞれ固定する
- 直し方: `mock-bin.test.ts` で `os.tmpdir()` と shim の `dev` を比べ、同じなら hard link の test (mock の `dev` / `ino` が shim と一致)、違うなら copy の test (link 数が 1、mock ごとに別 inode、実行ビット、中身が shim と一致) を走らせ、もう一方は `test.skipIf` で skip する。どちらが走ったかは test の出力に出る。sidecar の script の中身の確認は経路に依らないので別の test にした
- hard link の要求 (macOS で inode ごとの評価待ちを避ける要) は、同じ filesystem の時に copy になれば従来どおり落ちる (下の検証 3)
- runner が `/tmp` を root disk に戻した image (`ubuntu26/20261023.163` 以降) では、CI でも hard link の test が走る見込み (未検証)。tmpfs の `/tmp` は Ubuntu 26.04 の既定なので、手元の Linux では copy の test が走りうる

## 検証の詳細

macOS (APFS の system volume)、bun 1.4.2。別 device は `hdiutil create -fs HFS+` で作った disk image を一時ディレクトリに mount したもの。そこに `packages/testkit/src/{mock-bin.ts,exec-shim,tmp.ts}` と `packages/testkit/test/mock-bin.test.ts` を写して `bun test` した (repo の bunfig は読まないので、TMPDIR は system volume のまま)。

| # | 置き場 | 実装 | 結果 |
|---|---|---|---|
| 1 | shim を別 device | 直す前のテスト | 7 pass / 1 fail。CI と同じ inode 不一致 |
| 2 | shim を別 device | 直した後のテスト | 9 pass / 1 skip。copy の test が pass、hard link の test が skip |
| 3 | 同じ device | `linkSync` を throw に差し替えて copy を強制 | hard link の test が fail |
| 4 | shim を別 device | `chmodSync` を外し、shim を 644 にした | copy の test が fail |
| 5 | repo (同じ device) | 直した後のテスト | 9 pass / 1 skip。hard link の test が pass、copy の test が skip |

`just test` (lint / typecheck を含む): 4250 pass / 1 skip / 0 fail (skip は上の copy の test)。
