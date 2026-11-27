---
title: http.sock の頼み手の決め方を、pid の再利用で取り違えない形にするか決める
status: open
category: task
created: 2026-11-27
origin: 自リポ (暗号・プロセス保護の文書の見直し)
---

# http.sock の頼み手の決め方を、pid の再利用で取り違えない形にするか決める

## 概要

DR-0046 §3 は、`http.sock` の相手の pid (`LOCAL_PEERPID` / `SO_PEERCRED`) と `sessions/<pid>.json` の対応で頼み手のセッションを決める。macOS の `LOCAL_PEERPID` は読んだ時点で相手側の端を最後に送受信に使った process の pid で、その process が終わっても同じ数値を返し、数値が再利用されると無関係の process を指す (procline の findings `2026-11-15-socketpair-peer-after-fork-exec`)。ファイルを残して死んだセッションの pid を別の process が得ると、その process は state file を書かずにそのセッションとして通る。

DR-0046 §5 はこの口を「偶然の名乗り間違いや雑な成りすましを止める線」と位置付けている。pid の再利用は、悪意が無くても起きる取り違えなので、その線の内側の話になる。次のどれにするかを決める。

- 今のまま (取り違えの頻度が小さいと見て、DR-0046 §5 の守れない範囲に置く)
- macOS では `LOCAL_PEERTOKEN` で audit token を読み、pid と pidversion の組で引く。state file の書き手 (Claude Code) の pidversion は state file に無いので、照らす相手 (process の開始時刻と state file の作成時刻を比べる等) も決める
- 生きている process かどうかに加えて、process の開始時刻が state file より前であることを確かめる

## 背景

- reference の `macos-process-protection` の M5 は、相手のコードの身元を pid でなく audit token で引くことを求めている。ただし M5 の対象は同じ uid の悪意ある相手で、DR-0046 はその相手を守る範囲に入れていない (state file 自体が同じ uid に書ける)。ここで決めるのは悪意の無い取り違えだけ
- `packages/daemon/src/peer-pid.ts` の冒頭のコメントは「the kernel's own record of who connected」と書く。Linux の `SO_PEERCRED` は connect の時点の記録だが、macOS の `LOCAL_PEERPID` はそうではないので、直す時に合わせる
- DR-0034 の登録簿にも、ファイルを残して死んだセッションの pid が再利用されると生きて見える同じ性質がある

## 受け入れ条件

- [ ] 上のどれにするかを決め、DR-0046 (または新しい DR) に残す
- [ ] `peer-pid.ts` のコメントを macOS の実際の意味に合わせる
