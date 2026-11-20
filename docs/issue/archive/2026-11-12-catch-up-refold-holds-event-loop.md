---
title: daemon の再起動の直後、live のセッションの transcript の読み直しで event loop が 100ms 以上塞がる
status: resolved
category: bug
created: 2026-11-12T00:07:17+09:00
origin: hello の transcript の探索の調査で worker が見つけた (2026-11-11)
close_reason: implemented
---

# daemon の再起動の直後、live のセッションの transcript の読み直しで event loop が 100ms 以上塞がる

## 観測 (2026-11-11)

- sidecar_hello が来てセッションが live になると、daemon はその transcript を先頭から今の大きさまで読み直す (sidecar_hello → refreshReadiness → syncLiveRelays → startCatchUp → scanTranscriptLines。packages/daemon/src/transcript-relay.ts、packages/daemon/src/transcript.ts)。各行を fold 5 つ (status、API error、最後のユーザ入力、say の未読、permit) に渡す
- 読み方の刻み: 4MB ごとに読み (SCAN_CHUNK_BYTES)、1 チャンク読む前に 1 度だけ event loop に譲る。4MB 分の行の切り出しと fold への受け渡しは譲らずに 1 ターンで進む
- 実 daemon の再起動の時、先に live になった 9 本の transcript は合わせて約 68MB (1 本 5〜12MB) だった
- 隔離 daemon で、同じ大きさの合成 transcript (行は簡素) を 12 本読み直させた時、読み直しの間の ping の往復は最大 125〜142ms、読み直しが終わるまで 300ms 前後だった
- 読み直しはほかの経路からも始まる (hello で cwd / repo_root が変わった時の relayRefold 等)

## 分かっていないこと

- 実物の transcript (行が大きく fold の処理が重い) での塞がりの長さ。合成データより長いと見られるが未計測
- 実 daemon の event loop の遅れそのもの

## 影響

- 再起動の直後は、どの op (webui への配送、POST /op、hello) も 1 チャンク分待つことがある。transcript の探索を速くした後も、読み直しの最中に来た hello の探索は 4〜220ms とばらついた (隔離 daemon)
- 待ちの長さは live のセッションの transcript の合計の大きさで決まり、セッションが長く続くほど伸びる

## 決めること

- 譲る刻みを細かくするか (バイト数や行数で。DR-0029 の「長い走査は event loop を譲る」の粒度)
- 同時に走る読み直しの数を絞るか
- 先に、本番と同じくらいの量の実データで、読み直し中の op の往復を測る

## 関連

- docs/issue/2026-11-11-hello-transcript-search-slow.md (この読み直しの最中に走った探索が 0.5 秒かかっていた)
- docs/decisions/DR-0029-async-io-principle.md

## 裁定 (kawaz 2026-11-20)

両方やる: 譲る刻みをバイトから時間 (例 8ms) にし、同時に走る読み直しの数も絞る。DR-0029 の「長い走査は譲る」の基準を時間に書き換える。

## 対応 (2026-11-20)

- 長い走査は event loop を 8ms (`TURN_SLICE_MS`) 握ったら譲る。経過は行・エントリごとに確かめる (`turnSlice`)。transcript の読み直しと一度読み (`scanTranscriptLines`) のほか、同じくバイトや件数で譲っていた Session Search の行の走査、fork_origin の uuid の走査、fs_find の walk も同じ基準にした
- live のセッションの読み直しは同時 2 本 (`CATCH_UP_LIMIT`) まで。待つものは読むバイトの少ない順。置き換えられた読み直しは次の読み・次の行の前で止まって枠を空ける
- 隔離 daemon で 9 本 (68〜72MB) を一緒に読み直させた時、ping の往復の最大は 235〜541ms → 25〜34ms (中央値 10〜16ms)。読み直しの総時間は 8〜15% 長くなった (何に掛かっているかは未特定)
- 値の理由は DR-0029 の追補「長い走査は時間で譲る」、計測は `docs/findings/2026-11-20-catch-up-yield-by-time.md`
- 「分かっていないこと」のうち、実物の transcript での塞がりは隔離 daemon で実物 9 本の複製を読み直させて測った (直す前の ping の往復の最大 252〜282ms)。実 daemon の event loop の遅れそのものは測っていない
