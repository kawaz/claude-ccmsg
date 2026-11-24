---
title: "just test で webui の bundle を作るテスト 2 件が 5 秒の timeout で落ちた (1 回目だけ)"
status: open
category: bug
created: 2026-11-24
origin: "自リポ TODO (worker の just test の記録)"
---

# just test で webui の bundle を作るテスト 2 件が 5 秒の timeout で落ちた (1 回目だけ)

## 観測

2026-11-24、worker が自分の workspace で `just test` を 2 回続けて流した。変更の中身は 2 回とも同じ。

- 1 回目: 6772 pass / 2 skip / 2 fail、全体 126.88 秒
  - `createWebuiApp > the shell points at a content-hashed bundle and requires revalidation` が 5001.02ms で timeout
  - `brotli after gzip > gzip before the brotli is made, br after, the same content in both, and each coding its own etag` が 5002.74ms で timeout
  - どちらも `packages/webui/test/app.test.ts` の周りの、bundle を作るテスト
- 2 回目: 6774 pass / 2 skip / 0 fail、全体 105.37 秒
- 同じ変更を取り込んだ push の ci (main の workspace) は 1 回で通った (6774 pass / 0 fail)

1 回目は 2 回目より全体で 21 秒ほど遅い。

## 未特定

- 落ちた原因。bundle を作る処理が 5 秒を超えた理由は分かっていない
- 1 回目の時に同じ機械で何が走っていたか。この日は別の worker が並行して隔離 daemon・playwright・テストを動かしていたが、落ちた瞬間に重なっていたかは記録が無い
- 新しく作った workspace の 1 回目に固有か (bundle の cache が無い等)、負荷に依るか

## 特定に要る観測

- 落ちた回の、その 2 件の所要時間の内訳 (bundle を作る処理そのものか、その前後か)
- 同じ workspace で cache を消してから流した時に再現するか
- 落ちた時刻の、機械の他のプロセスの負荷

## 関連

- [2026-10-10-just-test-one-timeout-unidentified](./archive/2026-10-10-just-test-one-timeout-unidentified.md) は、同じ「1 回目だけ落ちる」の形だが、落ちたのは翻訳の実物のテストで、原因も直しも別
