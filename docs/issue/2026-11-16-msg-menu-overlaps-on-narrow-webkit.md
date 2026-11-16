---
title: WebKit の 390px 幅で、画面の下端の ☰ のメニューが上へ折り返さず吹き出しに重なる
status: open
category: bug
created: 2026-11-16
---
# WebKit の 390px 幅で、画面の下端の ☰ のメニューが上へ折り返さず吹き出しに重なる

## 観測 (2026-11-15、headless の WebKit、v0.267.0 の作業中)

- TL の assistant の吹き出しの ☰ を、画面の下端に置いて押すと、メニューは画面の中には収まるが、上へ折り返さずに ☰ の行と吹き出しを覆う (☰ 823.9〜843、メニュー 716.8〜844)。項目は押せる
- Chromium の 390px と、両エンジンの 1280px では、上へ折り返して画面の中に収まる
- WebKit の 390px では ☰ の右端が x=261.9 で、メニューの幅は 277px。`position-try-fallbacks` の候補 3 つがどれも横に収まらず (左に 15px、右に 121px はみ出る)、最初の配置のまま画面の中へずらされている、と計測から見ている
- v0.267.0 で入れた `anchor-scope` が起こしたものではない。それまではメニューが文書の最後の ☰ に吊られていて、この形が外から見えなかった

## 分かっていないこと

- WebKit の 390px で ☰ が x=234〜262 にある理由 (Chromium は 317〜344)
- 実機の iPhone の Safari で同じになるか

## 決めること

- 直すか。直すなら折り返しの候補の作り直し (`flip-block` で横の位置は任せる等) が要り、メニューの開き方が変わる

## 関連

- packages/webui/src/public/app.css の `.tl-msg-menu` の `@supports` の節
- [findings 2026-11-15-timeline-base-cost](../findings/2026-11-15-timeline-base-cost.md)
