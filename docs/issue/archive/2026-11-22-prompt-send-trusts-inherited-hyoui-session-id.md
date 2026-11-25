---
title: prompt.send の Enter が、継いだだけの HYOUI_SESSION_ID の端末 (別のセッションの端末) に押されうる
status: resolved
category: bug
created: 2026-11-22
close_reason: implemented
---

# prompt.send の Enter が、継いだだけの HYOUI_SESSION_ID の端末 (別のセッションの端末) に押されうる

## 観測 (2026-11-22)

DR-0062 段階 2 の「測ること」3 で、ccmsg のセッションの Bash から tmux の中に試験用の claude を起こした時、`HYOUI_SESSION_ID` を外し忘れた。隔離 daemon から user_prompt と comment_add (send_now) を送ると、試験用セッションの hooks module が自分の composer に fill した後、`hooks/prompt-send.ts` の `hyouiEnterArgv` で `HYOUI_SESSION_ID` の端末に Enter を押した。その端末は試験用セッションのものでなく、起こした側の統括のセッションの端末だった (2 回、試験用セッションの側はどちらも `not_submitted`)。その時は統括の composer が空でダイアログも無く、実害は無かった。

## やること

- module が Enter を押す端末が、自分の claude のプロセスが走っている端末であることを確かめてから押す (例: hyoui の端末のプロセスの木に自分の claude が居るか)。確かめられなければ押さずに `not_submitted` の理由を返す
- 確かめ方の決め方は module の責務。verify skill の「継承の変数を外す」一覧には `HYOUI_SESSION_ID` を足した (運用の手当て)

## 結果 (2026-11-25)

module は、`HYOUI_SESSION_ID` の端末の子の pid (`hyoui status` の `child_pid`) が自分の claude の pid (子の shell の `$PPID`) と一致することを確かめてから、その端末を名乗り、キーを押す。確かめられなかった時の理由は `not_submitted` ではなく `no_terminal` (Enter を押していないので。daemon は次の run へ進む)。決まりは [DR-0035](../../decisions/DR-0035-user-input-via-composer-fill.md) §3、実測は [findings 2026-11-25-prompt-send-enter-terminal-check](../../findings/2026-11-25-prompt-send-enter-terminal-check.md)。
