---
title: e2e の harness で daemon の socket のパスを決める所を @kawaz/sockat に差し替える
status: resolved
category: task
created: 2026-11-22
close_reason: implemented
---

# e2e の harness で daemon の socket のパスを決める所を @kawaz/sockat に差し替える

## 何をするか

`packages/webui/e2e/harness.ts` の `socketDir` は、daemon に state dir の実体の代わりに `/tmp` に置いた短い symlink を渡し、Unix socket のパスを sun_path の上限に収めている。Bun / Node から長いパスのまま bind / connect できる [@kawaz/sockat](https://github.com/kawaz/sockat-ts) (0.2.0、`@kawaz/sockat/bun` の `listen` / `listenEx` / `connect`、`resolveForBind` / `resolveForConnect`) が出たので、ここを差し替える。

- daemon の bind (`daemon.sock`、`http.sock`) は長命のプロセスなので、`listenEx` を使い、`stop()` の前に `file.remove()` を呼ぶ
- `Bun.serve({ unix })` に渡す所は `resolveForBind` で短い綴りを作って渡す
- e2e を繰り返す環境では `sweep()` を時々呼ぶ
- playwright 自身の socket (`PWTEST_SOCKETS_DIR`) は playwright が bind するので対象外

## 決めること

- daemon 本体 (packages/daemon) の socket の bind も同じく差し替えるか (今は state dir が短い前提)
- 依存に足す版 (`@kawaz/sockat` を devDependencies か dependencies か、版の固定)

## 結論

sockat も短い symlink も要らない。harness の `socketDir` を消し、daemon には run の一時 dir の下の state dir をそのまま渡すようにした。

- daemon (bind) も、それに繋ぐ CLI・テストのコード (connect) も Bun で動き、Bun は sun_path を超えるパスを自分で bind / connect できる ([findings](../../findings/2026-10-18-unix-socket-long-path-bun.md))。daemon 本体と依存の 2 つの「決めること」は、どちらも足さないで決まる
- 実測 (Bun 1.4.4、macOS): state dir を 178 バイトの `daemon.sock` になる深さにし、symlink を通さず daemon に渡して、`packages/webui/e2e/session-folds.e2e.ts` と `prompt-steps.e2e.ts` が 34 pass / 0 fail。215 バイトの state dir でも daemon の `daemon.sock` と `http.sock` の bind、テストのコードからの connect と hello、`fetch` の `unix` での `POST /op` が通った
- playwright 自身の socket (`PWTEST_SOCKETS_DIR`) は playwright が深い dir を断るので、`/tmp` 直下の短い dir を向けたまま
