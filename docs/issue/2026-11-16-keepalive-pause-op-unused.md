---
title: keepalive の停止の op (llm_keepalive_pause) を呼ぶものが webui に無くなった
status: open
category: task
created: 2026-11-16
---
# keepalive の停止の op (llm_keepalive_pause) を呼ぶものが webui に無くなった

## 概要

SESSIONS の行の keepalive の停止ボタンを消した (kawaz 2026-11-16「いらん」)。webui の側の部品・状態・呼び出し口は一緒に消したが、protocol と daemon の側は残っていて、今は呼ぶものが無い。残すか消すかを決めて片付ける。

## 残っているもの

- `packages/protocol`: `request-host.ts` の op `llm_keepalive_pause`、hello 応答の `llm_keepalive_pause_available`、ErrorCode の `llm_keepalive_pause_not_configured` と `llm_keepalive_pause_unavailable`
- `packages/daemon`: `src/server.ts` の op の処理と hello の flag、`src/llm-keepalive-pause.ts`、`src/config.ts` の `llm_keepalive_pause_url` (コメントが webui のセッション行の停止操作を述べている)、`test/llm-keepalive-pause-op.test.ts`
- `docs/design/protocol-package.md` の op の列挙

`CacheWindow.cache_paused` はアバターに巻く cache の輪が読んでいるので、この件の対象ではない。

## 決めること

- kawaz の「いらん」が行のボタンだけを指すのか、停止の機能ごとを指すのか。機能ごとなら上を全部消す (op を消すので PROTOCOL_VERSION を上げる)。ボタンだけなら、停止を出す別の場所が要るかを決める

## 受け入れ条件

- [ ] 上の裁定が出ている
- [ ] 裁定どおりに、消すか、呼ぶ場所を持つかのどちらかになっている (呼ぶものの無い op が残っていない)
