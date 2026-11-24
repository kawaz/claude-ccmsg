---
title: "ターンの途中で終わった teammate が、止めるまで動いている扱いのまま残る"
status: open
category: bug
created: 2026-11-24
origin: "自リポ TODO (worker のコードの読みの副産物)"
---

# ターンの途中で終わった teammate が、止めるまで動いている扱いのまま残る

## 現象 (コードの読み。実機の transcript での再現は未了)

daemon (`packages/daemon/src/session-status.ts`) が teammate の state を変えるきっかけは 3 つだけ。

- `spawned`: 起動の結果を観測した時 (`foldTeammateSpawn`)
- `active` / `idle`: その teammate からメッセージが届いた時 (`foldTeammateRelay`。本文が `idle_notification` なら `idle`、それ以外は `active`)
- `stopped`: 本体がその teammate を TaskStop した時 (`applyTaskStop`)

ターンの途中で終わった teammate (API のエラー、プロセスの終了、shutdown) は何もメッセージを送らないので、最初の指令の途中なら `spawned`、2 回目以降なら `active` のまま残る。終わりを知らせる `teammate_terminated` (送り主が `system`) を、`foldTeammateRelay` は state を変えずに読み飛ばしている。最上位の teammate は最後の書き込み時刻での生死の見立て (depth 1 以上の agent にはある) の対象でもない。

## 影響

- エージェントのリストで、終わった teammate が働いている区画に出続ける
- TL の末尾の `N active agent(s)` (DR-0054 §4) の数に入り続け、本体が待っているように見える

## 未特定

- 今の Claude Code が `teammate_terminated` をどの形で残すか (本文の `X has shut down.` は 2026-02〜03 の観測)
- プロセスが落ちた時に、その知らせ自体が残るか

## 手の候補

- `teammate_terminated` を読み、名前の teammate を `stopped` にする。知らせが残る場合の穴は塞がる
- teammate にも最後の書き込み時刻での見立てを足す。長い tool 呼び出しの途中で書き込みの無い teammate も止まったと見なすので、その間は数が実際より少なく出る

## 特定に要る観測

- 実機の transcript で、teammate が shutdown で終わった時・エラーで終わった時・プロセスが落ちた時のそれぞれに、本体の transcript に何の行が残るか
