---
title: "plugin の更新の直後、依存の入れ込みの途中で呼ばれた CLI が Cannot find package で落ちる"
status: open
category: bug
created: 2026-11-25
origin: "他プロジェクトからの共有 (定期実行で ccmsg を呼ぶ利用側)"
---

# plugin の更新の直後、依存の入れ込みの途中で呼ばれた CLI が Cannot find package で落ちる

## 観測 (利用側からの共有、2026-11-25)

- 15:15 ごろ、launchd の定期実行 (15 分おき) が呼んだ `ccmsg agents` が 1 回失敗した
- その回の stderr の末尾: `error: Cannot find package 'hono' from '<config dir>/plugins/cache/ccmsg-v1/ccmsg-v1/0.414.0/packages/webui/src/index.ts'` (Bun v1.4.4、macOS arm64)
- 15:16 に手で `ccmsg agents` を実行すると成功した。同じ分に終わった次の定期実行も成功した
- plugin の cache の `0.414.0` のディレクトリの更新時刻は 15:15:51 (このリポの側で確認)。v0.414.0 の push の後処理 (plugin の更新と、新しい版の CLI で daemon に 1 回触る `_local-daemon-upgrade`) が走った時刻と重なる

## 原因の見立て (コードの読み。同時実行での再現は未了)

`bin/ccmsg` の `__ccmsg_ensure_deps` は、`node_modules` のディレクトリが在れば入れ込み済みと見なしてすぐ戻る。別のプロセスが `bun install` を実行している途中 (`node_modules` は作られたが、中身がまだ揃っていない間) に呼ばれた CLI は、入れ込みを待たずにそのまま走り、まだ無いパッケージの解決で落ちる。

`claude plugin update` は cache に版のディレクトリを作るだけで依存を入れないので、新しい版を最初に呼んだプロセスが `bun install` を始める。push の後処理・セッションの hooks・定期実行のどれが最初になるかは決まっておらず、その入れ込みの間に呼ばれた 2 番目以降が当たる。

## 特定に要る観測

- 依存の無い版のディレクトリの写しに対して、`bin/ccmsg` を 2 つ続けて起動した時に、2 つ目が同じ形で落ちるか (入れ込みにかかる時間と、落ちる窓の長さ)
- `bun install` を同じディレクトリで 2 つ同時に走らせた時の振る舞い (2 つ目が待つか、壊すか)

## 利用側の対処

していない (1 回で戻ったため)。
