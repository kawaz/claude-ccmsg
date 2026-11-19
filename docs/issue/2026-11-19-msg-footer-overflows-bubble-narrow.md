---
title: Chromium の 390px 幅で、assistant の吹き出しの足元の行が吹き出しより右へはみ出る
status: open
category: bug
created: 2026-11-19
---

# Chromium の 390px 幅で、assistant の吹き出しの足元の行が吹き出しより右へはみ出る

## 観測 (2026-11-19、headless の Chromium、390px 幅、☰ のメニューの折り返しを直す作業の途中で見つかった)

- 足元の行 (時刻、翻訳のタブ、☰ の並ぶ行) の幅が 333px で、吹き出しの右端 (322.6px) より約 22px 右へはみ出る
- Chromium にはブラウザ内の翻訳 (Translator API) があるので、翻訳のタブが original / ja(browser) / ja(host) の 3 つになり、WebKit (2 つ) より行が長い

## 分かっていないこと

- はみ出しが見た目で問題になるか (吹き出しの外の余白の中に収まっているか)
- 足元の行は吹き出しの幅に合わせて折り返すべきか、吹き出しの外へ伸びてよいか
