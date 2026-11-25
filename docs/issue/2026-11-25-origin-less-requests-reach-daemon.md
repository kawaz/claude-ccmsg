---
title: "sandbox だけの iframe の中からの要求が、Origin ヘッダ無しで daemon に届く"
status: open
category: bug
created: 2026-11-25
origin: "自リポ TODO (svg のスクリプトの実行の実測で気づいた)"
---

# sandbox だけの iframe の中からの要求が、Origin ヘッダ無しで daemon に届く

## 観測 (2026-11-25、Chromium 159 と WebKit 27.2)

`sandbox` だけ (CSP 無し) の iframe の中からの画像の読み込みと no-cors の fetch の GET は、両ブラウザで `Origin` ヘッダ無しで届いた。WebKit では、sendBeacon の `Origin` が webui の origin になる場合もあった。表は [findings 2026-11-25-svg-script-run-sandbox](../findings/2026-11-25-svg-script-run-sandbox.md) の「sandbox だけの時に webui 役のサーバへ届いた要求」。

daemon の HTTP は `Origin` の無い要求を通す。`packages/daemon/src/http.ts` のコメントは「ブラウザは fetch に必ず Origin を付ける」と書いていて、観測と合わない。

## 未確認

- 今 webui が出している sandbox の iframe (sandbox origin のファイルの表示、[DR-0030](../decisions/DR-0030-sandbox-origin-serving.md)) の中の文書から、この形で daemon のどの口に届き、何ができるか (応答は読めない見込みだが、届くだけで作用する口があるか。`/ws` の upgrade、`/webhook`、`/fs-serve`、`/attachment`)
- 送信元の IP の allowlist や他の検査で止まっている口と、止まっていない口

## やること

- 上を、隔離した daemon と試験用の文書で観測する
- 届くだけで作用する口があれば、止め方を決める (`Origin` の無い要求の扱い、`Sec-Fetch-Site` などブラウザが付けるヘッダでの見分け)。`http.ts` のコメントを観測に合わせる
