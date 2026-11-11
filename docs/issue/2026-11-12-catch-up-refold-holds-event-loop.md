---
title: daemon の再起動の直後、live のセッションの transcript の読み直しで event loop が 100ms 以上塞がる
status: open
category: bug
created: 2026-11-12T00:07:17+09:00
last_read:
open_entered: 2026-11-12T00:07:17+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered:
discard_reason:
pending_reason:
close_reason:
blocked_by:
origin: hello の transcript の探索の調査で worker が見つけた (2026-11-11)
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
