---
title: e2e の harness で daemon の socket のパスを決める所を @kawaz/sockat に差し替える
status: open
category: task
created: 2026-11-22
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
