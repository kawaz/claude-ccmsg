# DR-0067: svg のスクリプトを、preview と同じ sandbox origin で実行する

- Status: Accepted (2026-11-26) — ✅ 実装済み (protocol の `sandbox_grant_svg`、daemon の `sandbox.ts` の文字を持つ grant と `server.ts` の op、webui の `FenceFigure` の「実行」の区画・`SvgFigure`・`FileViewer` の `SvgFileTabs`・`sandbox-open.ts`)
- Date: 2026-11-25

## Context

webui は、markdown の `svg` のコードブロックと `.svg` のファイルを img で図として描く ([DR-0010](./DR-0010-timeline-markdown-rendering.md) §12)。img として読んだ svg はスクリプトが動かないので、動きのある図は止まった絵になる。

kawaz の依頼 (2026-11-25、[issue](../issue/2026-11-25-lean-highlight-and-svg-script-run.md) の 2): svg のブロックとファイルに「描画 | ソース | 実行」を付ける。既定は描画で、実行は覚えない。

ccmsg は、信頼しない html のスクリプトを動かす仕組みを既に持っている。FileViewer の「HTML として開く」(preview、[DR-0030](./DR-0030-sandbox-origin-serving.md)) で、実装 (`packages/daemon/src/sandbox.ts`、`FileViewer.tsx` の `SandboxActions`) は次のとおり。

- webui が op `sandbox_grant { sid, path, kind }` (user role だけ) で URL をもらい、別のタブで開く (開き方は DR-0030 §7.2: opener を切り、`Referer` を付けない)。hello の `sandbox_available` が無い環境では導線を出さない
- URL は webui と別の site の origin (`sandbox_origin_template` の `{gid}`) にあり、path の頭に秘密の token を持つ。grant は daemon のメモリにだけあり、30 分で切れる
- daemon は要求のたびに、`fs_read` 系と同じ境界でパスを読み直す。scope は対象のファイルの親ディレクトリ
- 応答は、拡張子から決めた MIME、`Content-Disposition: inline`、`Cache-Control: private, no-store`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer` と、次の CSP

```
sandbox allow-scripts allow-same-origin; default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self'; frame-ancestors <webui の許可 origin>; form-action 'none'; base-uri 'none'
```

- sandbox origin 宛ての要求は、daemon の `/ws`・op・webui の配信に届かない。cookie は出さない

`.svg` のファイルは、今もこの仕組みで配れる。`sandbox_grant` は拡張子を見ず、MIME の表は `.svg` を `image/svg+xml` にする。webui が導線を html のファイルに限っているだけ。この応答ヘッダで svg を開いた時に svg のスクリプトにできることは、[findings](../findings/2026-11-25-svg-script-run-sandbox.md) の「preview と同じ応答ヘッダで svg を開いた時」に測ってある (スクリプトは動く。同じディレクトリのファイルは読める。外部と webui への fetch・画像・WebSocket は止まる。新しい窓は開けない。自分を外部の URL へ遷移させることはできる)。

## 目的

人が実行を選んだ svg のスクリプトを、preview の html と同じ場所・同じ守りで動かす。svg のための別の守り方を持たない。

守ること:

1. 人が「実行」を選ばない限り、スクリプトは動かない (描画の既定を変えない)。実行の選択は残らない
2. svg のスクリプトが動く場所は sandbox origin の文書で、CSP などの守りの応答ヘッダは preview と同じ
3. 読める範囲を広げない。ファイルは `fs_read` 系の境界のまま。コードブロックは webui が既に持っている文字だけ

増やしたくないもの:

- svg だけの守り (専用の受け皿、専用の CSP、webui と受け皿の間の約束)。preview の守りを変える時は、html と svg の両方に同じく効く
- webui の origin から配る、スクリプトの動く文書
- daemon の HTTP の新しい道筋

svg のスクリプトにできること・できないことは、preview の html と同じになる。preview が許していることを svg にだけ禁じない。

## 前提

| 前提 | 満たさない時 |
|---|---|
| sandbox origin が設定されている (`sandbox_available`) | 実行の区画を出さない (preview の導線と同じ) |
| sandbox origin の文書が webui の origin の `/fs-serve` の svg や `/attachment` の html へ自分を遷移させても、スクリプトが webui の origin で動かない (この 2 つの応答のヘッダの直しが入っている) | preview の html と同じ穴が svg の実行にもある。この DR では塞がない |

## Decision

### 1. `.svg` のファイル

daemon は変えない。webui は、`.svg` のファイルのビューア (`FileViewer`) のヘッダに「描画 | ソース | 実行」を出し、実行は preview と同じく `sandbox_grant` の URL を開く。

- 切り替えは、markdown のファイルの「コード | プレビュー」と同じヘッダの繋がったボタン (`.viewer-mode-toggle.joined-buttons`、aria-label「表示モード」) に置く
- 描画は今の画像の表示 (`/fs-serve` の img)。ソースは `fs_read` の中身を、ほかのテキストのファイルと同じビューア (行番号・検索・編集) で出す
- 描画 / ソースの選択はファイルごとに持たず、別のファイルを開くと描画に戻る。保存しない
- 画像の読み込みが失敗した `.svg` (img の `error`) は、実行を押せない (title が理由。§3)
- svg が相対のパスで読む同じディレクトリの画像は、scope の中なので読める

### 2. `svg` のコードブロック

コードブロックの中身はファイルでないので、`sandbox_grant` には渡せない。op を 1 つ足す。

- `sandbox_grant_svg { content }` (user role だけ)。答えは `sandbox_grant` と同じ `{ gid, token, url, exp }`
- daemon は `content` を grant と一緒にメモリに持ち、sandbox origin の今の配信の中で、`/<token>/figure.svg` に `image/svg+xml` として返す。応答ヘッダは preview と同じ。ファイルは読まない
- gid は発行のたびに新しくする (図ごとに別の origin)。期限と取り消しは今の grant と同じ (30 分、`sandbox_revoke`、daemon の再起動で消える)
- `content` は 512 KiB まで (`FS_READ_MAX_BYTES`。UTF-8 のバイト数で数える。svg のファイルを webui が読める大きさと同じにして、op の 1 行の大きさを抑える)。超える時は `invalid_args` で断り、webui は実行を押せなくして理由を出す
- 文字の grant が答える名前は `figure.svg` だけ (他の名前・空の名前は 404)。違う token・期限切れ・取り消しの後の答えはファイルの grant と同じ (404 / 410)。`?dl=1` もファイルの grant と同じ応答ヘッダでダウンロードになる
- webui が渡すのは、img が描くのと同じ文字 (根の `<svg>` に `xmlns` が無ければ足した後、[DR-0010](./DR-0010-timeline-markdown-rendering.md) §12)。足さずに渡すと、`xmlns` を省いた図は SVG の文書にならず、スクリプトも動かない

渡せるのは webui が既に持っている文字だけで、daemon が読める範囲は変わらない (DR-0030 §5)。足すのは「grant が、ファイルの代わりに渡された文字を持てる」ことだけで、道筋・origin・応答ヘッダは今のまま。

### 3. 見せ方

- コードブロックは、今の「描画 | ソース」の部品 (`FenceFigure` の `Tabs`、離れて並ぶ小さなタブ `.tl-thinking-tab`) に「実行」を 3 つ目の区画として足す。新しい見た目は作らない。`.svg` のファイルはヘッダの繋がったボタンに足す (§1)
- 実行は別のタブで開く (その場の iframe には出さない)。「実行」は切り替えでなく開く操作で、押しても選択は描画 (またはソース) のまま動かない。保存せず、URL に書かない。開き方は preview と同じで、1 つの関数 (`sandbox-open.ts`) を共有する ([DR-0030](./DR-0030-sandbox-origin-serving.md) §7.2): 押した時に空のタブを 1 つだけ開いて opener を切り、grant の後に `Referer` を付けずに URL を入れる。grant が断られたら、開いたタブを閉じる
- 押すまで `sandbox_grant` / `sandbox_grant_svg` を呼ばない
- `sandbox_available` が無い環境 (と、app の外で描く見本帳・単体の描画) では、実行の区画を出さない
- 押せない時は、区画を押せなくし、title に理由を出す
  - 描画できない svg (img の読み込みが失敗するもの): 「この SVG は描画できないので実行できない」
  - コードブロックの中身が 512 KiB を超える: 「この SVG は 512KB を超えるので実行できない」
- grant が断られた時の理由は、コードブロックは箱の知らせの文 (`.md-figure-note`)、`.svg` のファイルはヘッダの文 (`.viewer-banner`) に出す。押せる時の title は「別 origin の新しいタブで SVG として実行する」
- 付く所: `svg` のコードブロックが図になる所 (`renderCodeFence` を通る、restricted でない `MarkdownView`。エージェントの応答・ユーザの発言・下書き・人のコメントの吹き出し ([DR-0010](./DR-0010-timeline-markdown-rendering.md) §6)、Files の markdown のプレビュー、Timeline の中に出すファイルの中身、本文を書く欄の md のプレビュー) と、`.svg` のファイルのビューア。restricted の描画 (Timeline の (u1) の msg、ccmsg の人の msg) は svg のブロックを図にしないので付かない
- mermaid と数式には付けない

別のタブにするのは、svg のスクリプトを webui のタブに作用させないため。その場の iframe では、WebKit で svg のスクリプトが webui の履歴を戻し、終わらないループの間 webui が応答しなかった。別のタブではどちらも起きなかった (findings)。

### 4. 検証

- 単体 (`packages/daemon/test/sandbox-svg.test.ts`): 文字の grant の応答ヘッダが、同じ中身の `.svg` のファイルの grant の応答ヘッダと全部同じ (`Content-Type: image/svg+xml`、CSP を含む。`?dl=1` も)。違う token・違う名前・期限切れ・取り消しの後の答え。発行のたびに別の gid。512 KiB (UTF-8 のバイト数) を超える中身を断る。実 listener で、user role だけが呼べること、未設定の時の `sandbox_not_configured`、文字の grant の Host 宛ての要求が `/ws`・`/attachment`・`/fs-serve`・webui の配信に届かないこと
- dom (`packages/webui/test/svg-run.dom.test.ts`): 区画の有無 (`sandbox_available`、app の外、数式)、押すまで op を呼ばないこと、押した後の選択、`xmlns` を足した文字を渡すこと、押せない時の理由、断られた時の知らせ
- e2e (`packages/webui/e2e/svg-run.e2e.ts`、Chromium と WebKit): 実行を押すと別のタブに sandbox origin の svg の文書が開き、スクリプトが動く (webui の文書では動かない)。応答とユーザの発言の svg のブロック、`xmlns` の無いブロック、`.svg` のファイルで。押すまで op を呼ばず、押した後も選択はそのまま。mermaid と数式には区画が無い。描画できない `.svg` のファイルの実行は押せない。`sandbox_available` が無い時はどこにも区画が無い
- e2e (`packages/webui/e2e/sandbox-open.e2e.ts`、Chromium と WebKit): preview と svg の実行のどちらも、押すと増えるタブが 1 つで `about:blank` が残らず、開いた文書の `window.opener` が null で webui の文書に触れず、`Referer` も `document.referrer` も無い。grant が断られた時は開いたタブが閉じる

## Alternatives Considered

| 案 | 不採用理由 |
|---|---|
| 実行をその場の iframe (`src` に grant の URL) に出す | 図が本文の中で動き切り替えとして働くが、svg のスクリプトが webui のタブの中で動く。WebKit で webui の履歴を戻され、終わらないループの間 webui が応答しなかった (findings)。図の大きさ・止め方・取り消しの決まりも要る |
| `.svg` のファイルだけ先に入れ、コードブロックの口 (`sandbox_grant_svg`) は足さない | daemon も protocol も変えずに済むが、応答に書かせた図を実行できない。応答に図を書かせる使い方が主 |
| 受け皿の html を sandbox の iframe で開き、その中の sandbox の srcdoc に svg を入れる 2 段 (dirview の形) | dirview は別の origin も応答ヘッダも持てないのでこの形になる。ccmsg は両方を持ち、preview が既に同じことをしている |
| 受け皿を webui の側で持つ (`/assets` の html、srcdoc、`data:` の URL) | svg だけの受け皿と約束を持つことになる。`/assets` の html は、webui の origin から配るスクリプトの動く文書でもある |
| svg にだけ、preview より厳しい CSP を付ける | svg だけの守りになる。守りを強めるなら preview の CSP を変える |
| コードブロックの中身を添付の upload で daemon に預ける | 添付は webui の origin から配られていて、sandbox origin に載っていない (DR-0030 の Phase 3) |
| 実行の選択を覚える | 守ること 1 |

## Consequences

- svg のスクリプトにできることは preview の html と同じ。同じディレクトリのファイルを読め、自分を外部の URL へ遷移させられる (findings)
- sandbox origin を設定していない環境では、svg を実行できない
- protocol に op `sandbox_grant_svg` が増える。webui だけが呼ぶ op で hooks の bundle は変わらないので、`PROTOCOL_VERSION` は上げない ([DR-0002](./DR-0002-daemon-supervision.md) §4)。daemon の grant がファイルの他に文字を持つようになり、1 件あたり最大 512 KiB を最長 30 分メモリに持つ。発行のたびに新しい grant なので、押した回数だけ増える (期限で消える)
- コードブロックの svg は 1 つの文書として配るので、相対のパスの資源を読めない
- webui は今 `sandbox_revoke` を呼んでいないので、grant は期限まで残る (preview と同じ)

## 関連

- [issue 2026-11-25](../issue/2026-11-25-lean-highlight-and-svg-script-run.md) — 依頼 (2. svg のスクリプトの実行)
- [DR-0030](./DR-0030-sandbox-origin-serving.md) — sandbox origin の配信 (preview)
- [DR-0010](./DR-0010-timeline-markdown-rendering.md) §12 — svg のコードブロックの描画と「描画 | ソース」の箱
- [findings 2026-11-25](../findings/2026-11-25-svg-script-run-sandbox.md) — sandbox と CSP の下で svg のスクリプトにできることの実測
