---
title: HTTP を配る daemon は、起動直後の webui の bundle と圧縮で非同期のファイル操作を 1 秒前後待たせる
status: open
category: bug
created: 2026-11-12T00:39:42+09:00
origin: macOS の CI の flaky の調査で worker が見つけた (2026-11-12)
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
