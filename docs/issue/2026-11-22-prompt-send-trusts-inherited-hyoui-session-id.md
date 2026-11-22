---
title: prompt.send の Enter が、継いだだけの HYOUI_SESSION_ID の端末 (別のセッションの端末) に押されうる
status: open
category: bug
created: 2026-11-22
---

# prompt.send の Enter が、継いだだけの HYOUI_SESSION_ID の端末 (別のセッションの端末) に押されうる

## 観測 (2026-11-22)

DR-0062 段階 2 の「測ること」3 で、ccmsg のセッションの Bash から tmux の中に試験用の claude を起こした時、`HYOUI_SESSION_ID` を外し忘れた。隔離 daemon から user_prompt と comment_add (send_now) を送ると、試験用セッションの hooks module が自分の composer に fill した後、`hooks/prompt-send.ts` の `hyouiEnterArgv` で `HYOUI_SESSION_ID` の端末に Enter を押した。その端末は試験用セッションのものでなく、起こした側の統括のセッションの端末だった (2 回、試験用セッションの側はどちらも `not_submitted`)。その時は統括の composer が空でダイアログも無く、実害は無かった。

## やること

- module が Enter を押す端末が、自分の claude のプロセスが走っている端末であることを確かめてから押す (例: hyoui の端末のプロセスの木に自分の claude が居るか)。確かめられなければ押さずに `not_submitted` の理由を返す
- 確かめ方の決め方は module の責務。verify skill の「継承の変数を外す」一覧には `HYOUI_SESSION_ID` を足した (運用の手当て)
