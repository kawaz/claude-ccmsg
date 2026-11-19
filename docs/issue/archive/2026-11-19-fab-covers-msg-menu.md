---
title: 狭い幅で画面の下端の ☰ のメニューを開くと、右下の + ボタン (FAB) がメニューの右下を覆う
status: resolved
category: bug
created: 2026-11-19
close_reason: implemented
---

# 狭い幅で画面の下端の ☰ のメニューを開くと、右下の + ボタン (FAB) がメニューの右下を覆う

## 観測 (2026-11-19、headless の WebKit、390px 幅、v0.290.0 + ☰ のメニューの折り返しの修正)

- 画面の下端の assistant の吹き出しの ☰ を押すと、メニューは上へ折り返して開く (横は画面の幅いっぱいで ☰ の中心揃え)
- 右下の + ボタン (`.session-input-fab`) がメニューより手前に描かれ、メニューの右下の説明文 (「選択を…」のあたり) を隠す
- スクリーンショットは worker の作業場所にあった (`menu-webkit/shots/after-webkit-390-bottom.png`、セッションの一時置き場)

## 分かっていないこと

- Chromium の 390px でも同じか (メニューの右端は ☰ の右端揃えで、FAB の位置と重なるかは未計測)
- メニューと FAB の重なり順 (メニューが popover の top layer に出ているか、FAB の z-index が勝っているか)

## 決めること

- メニューを開いている間は FAB より手前に出すのが筋か (メニューは一時的な操作の面なので、手前に出すのが自然と見ている)

## 原因 (2026-11-19、headless の Chromium と WebKit、390px 幅で観測)

- メニュー (`.tl-msg-menu`) は popover ではなく、top layer には出ていない。anchor positioning の節で `position: fixed` になる
- メニューと FAB の祖先に重なりの文脈を作る要素 (z-index 付きの配置、transform、filter、opacity、contain、isolation、will-change、container-type) は無く、どちらも root の重なりの文脈で比べられる
- どちらも `z-index: var(--z-composer)` (40) で同じ値なので、DOM で後ろにいる FAB が手前に描かれる。重なりの中心の `elementFromPoint` は両エンジンとも FAB を返した
- Chromium の 390px でも、画面の下端で上へ開いたメニューの右下を FAB が覆っていた (下の表)

## 対処

- 開いている間だけ出る操作の面の層 `--z-menu: 50` を `:root` に足し、メニューの z-index をそれにした。常設の FAB / 入力欄 (40) より手前、全画面の lightbox (100) より奥
- 真因が同じ値の z-index の取り合いなので、層の値で直した。popover の top layer に出す案は、開閉と外側クリックで畳む処理を JS から popover の仕組みへ移すことになり、重なりの不具合の範囲を超えるので採らなかった
- `packages/webui/test/timeline-rendering.dom.test.ts` の「an open ☰ menu stacks above the + button at the bottom right」で、メニューの z-index の算出値が FAB より大きいことを固定した (直す前の app.css では 40 と 40 で落ちることを確かめた)

## 座標 (headless、高さ 844px、15 番目の assistant の吹き出しの ☰ を画面の下端に置いて開いた)

値は (left, right, top, bottom) の px。重なりは、メニューと FAB の重なった矩形の中心で `elementFromPoint` が返した側。

| engine | 幅 | 版 | ☰ | メニュー | FAB | 重なり |
|---|---|---|---|---|---|---|
| Chromium | 390 | 直す前 | 316.7, 344.5, 814, 834.2 | 67.3, 344.5, 664.1, 809.3 | 319.6, 370.8, 773.6, 824.8 | FAB が手前 |
| Chromium | 390 | 直した後 | 11.5, 39.4, 813.8, 834 | 11.5, 288.7, 663.8, 809 | 319.6, 370.8, 773.6, 824.8 | 重ならない |
| WebKit | 390 | 直す前 | 234.1, 261.9, 814.7, 833.8 | 109.4, 386.6, 682.7, 809.9 | 319.6, 370.8, 773.6, 824.8 | FAB が手前 |
| WebKit | 390 | 直した後 | 234.1, 261.9, 814.7, 833.8 | 109.4, 386.6, 682.7, 809.9 | 319.6, 370.8, 773.6, 824.8 | メニューが手前 |
| Chromium | 1280 | 直した後 | 755.1, 783, 813.5, 833.7 | 505.8, 783, 663.5, 808.7 | 1209.6, 1260.8, 773.6, 824.8 | 重ならない |
| WebKit | 1280 | 直した後 | 671.7, 699.5, 814.1, 833.1 | 422.3, 699.5, 682.1, 809.3 | 1209.6, 1260.8, 773.6, 824.8 | 重ならない |

- Chromium の 390px の直した後で ☰ が左端に移ったのは、足元の行の折り返しの修正 (`2026-11-19-msg-footer-overflows-bubble-narrow.md`) で ☰ が 3 行目の先頭に回ったため。Chromium の 390px でメニューが FAB と重ならなくなったのはその副次で、重なった時の順は WebKit の行で確かめた
- 画面の上端・中ほどの ☰ と 1280px の開き方は、直す前と直した後で座標が同じだった (Chromium の 390px は上の ☰ の移動を除く)
