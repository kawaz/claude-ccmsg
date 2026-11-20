---
title: HTTP を配る daemon は、起動直後の webui の bundle と圧縮で非同期のファイル操作を 1 秒前後待たせる
status: resolved
category: bug
created: 2026-11-12T00:39:42+09:00
origin: macOS の CI の flaky の調査で worker が見つけた (2026-11-12)
close_reason: implemented
---

# HTTP を配る daemon は、起動直後の webui の bundle と圧縮で非同期のファイル操作を 1 秒前後待たせる

## 観測 (2026-11-11〜12)

- bun の非同期のファイル操作 (node:fs の promise 版) は、プロセスに 1 つの thread の pool で走る。thread の数は UV_THREADPOOL_SIZE、無ければ core の数 (bun 1.4.4 のソースで確認: src/threading/work_pool.rs、src/bun_core/util.rs の get_thread_count)
- webui の client の Bun.build と br / gzip の圧縮はこの pool で走る。pool の thread が全部埋まっている間、非同期の stat / readFile は待つ (同期の操作と event loop は待たない)
- GitHub の macOS の runner (3 core) で、daemon の起動直後に非同期の stat が 1046〜1104ms 待った (run 43045653045、daemon の fs の探り針)。sample では pool の 3 本が bun の中で計算していた
- 手元で UV_THREADPOOL_SIZE=3 にして webui の app を作った直後から測ると、非同期の stat の最大の待ちは bun 1.4.4 で 441ms、bun 1.4.2 で 174ms。既定 (10 core) では 19〜23ms
- 2026-11-12 の変更で、HTTP の listener を持たない daemon (CCMSG_HTTP_BIND=off、bind が全部失敗) は bundle を作らなくなった (DR-0004 §4、DR-0005 §3)。HTTP を配る daemon (本番の既定 127.0.0.1:8642) は、listener が立った直後に今までどおり作る

## 影響

- core の少ない機械では、HTTP を配る daemon の起動直後の約 1 秒、hello の所在の導出と send の state file の走査 (期限 1 秒) が待つ。起動直後の send が ended / no_peer_socket になりうる
- packages/daemon/test/http-transport.test.ts の Origin check は GET / で shell の用意を丸ごと待つ。手元の検査で 1 度、5000ms の期限で落ちた (ECONNRESET、原因は未確認)。テストの注記の「no fallback wired -> 404」は、テストの daemon が run.ts を通って webui の fallback を持っている今の形と合っていない

## 決めること (worker の挙げた選択肢)

- (a) 先読みを最初の HTTP のリクエストまで遅らせる。起動直後は pool を使わないが、最初の page load が build と圧縮の全部を待つ
- (b) build と圧縮を別の process に出す。daemon の pool を使わないが、成果物を受け渡す口が要る
- (c) br の圧縮を後回しにする (最初は gzip だけで配る)。pool を占める時間が短くなる
- (d) UV_THREADPOOL_SIZE を core の数より大きくする。thread が増えるだけで、3 core なら計算は同じく取り合う
- Origin check のテストは、shell を待たない path で Origin の判定だけを確かめる形にするか (テストの主張は変えない)

## 関連

- docs/issue/2026-10-18-send-message-served-dir-test-flaky-macos-ci.md (この pool の待ちが原因だった)
- docs/decisions/DR-0004-webui-architecture.md §4、DR-0005-webui-frontend-architecture.md §3

## 裁定 (kawaz 2026-11-20)

brotli を後回しにする: 起動直後は gzip だけで配り、brotli は出来たら切り替える。

## 解決 (2026-11-20)

- webui は起動直後に bundle と gzip だけを作って配り始める。brotli (quality 11) は gzip が揃った後に 1 asset ずつ (node:zlib の callback 形で) 作り、全部出来たら以後のリクエストを brotli で返す。生成の仕方と理由、ETag の扱いは DR-0005 §3
- 待ちの元は brotli を全 asset 並べて投げていたこと (Bun.build と gzip の間の待ちは数 ms)。隔離した daemon で測ると、起動から 4 秒の非同期の stat の最大の待ちは、UV_THREADPOOL_SIZE=3 で 177〜372ms → 3〜9ms、最初の GET / は約 1.2 秒 → 65〜100ms (gzip)。brotli は約 2.4 秒後に揃う。前後の表は docs/findings/2026-11-20-webui-brotli-later-pool-wait.md
- daemon の prepare は全部出来た時に解決する Promise になり、`http: the fallback has prepared (N ms)` / `http: the fallback's prepare failed after N ms: …` を log に出す
- 切り替えの性質 (brotli の前は gzip、後は brotli、中身は同じ、ETag は coding ごと) は packages/webui/test/app.test.ts の「brotli after gzip」と packages/webui/test/encoded-asset.test.ts で固定した
- 手を付けていないこと: 「影響」の 2 つ目の Origin check のテスト (packages/daemon/test/http-transport.test.ts) の注記と形。GET / が待つのは bundle と gzip だけになった。CI の 3 core の runner の上での前後は測っていない
