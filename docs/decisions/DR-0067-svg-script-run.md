# DR-0067: svg のスクリプトを、preview と同じ sandbox origin で実行する

- Status: Proposed
- Date: 2026-11-25

未実装。Decision は未決の問いの起草時の推しで通して書いてある。裁定の要る点は「未決」の Q1・Q2。

## Context

webui は、markdown の `svg` のコードブロックと `.svg` のファイルを img で図として描く ([DR-0010](./DR-0010-timeline-markdown-rendering.md) §12)。img として読んだ svg はスクリプトが動かないので、動きのある図は止まった絵になる。

kawaz の依頼 (2026-11-25、[issue](../issue/2026-11-25-lean-highlight-and-svg-script-run.md) の 2): svg のブロックとファイルに「描画 | ソース | 実行」を付ける。既定は描画で、実行は覚えない。

ccmsg は、信頼しない html のスクリプトを動かす仕組みを既に持っている。FileViewer の「HTML として開く」(preview、[DR-0030](./DR-0030-sandbox-origin-serving.md)) で、実装 (`packages/daemon/src/sandbox.ts`、`FileViewer.tsx` の `SandboxActions`) は次のとおり。

- webui が op `sandbox_grant { sid, path, kind }` (user role だけ) で URL をもらい、別のタブ (`noopener,noreferrer`) で開く。hello の `sandbox_available` が無い環境では導線を出さない
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

daemon は変えない。webui は、`.svg` のファイルのビューア (`FileViewer` の画像の表示) に「描画 | ソース | 実行」を出し、実行は preview と同じく `sandbox_grant` の URL を開く。ソースは `fs_read` の中身。svg が相対のパスで読む同じディレクトリの画像は、scope の中なので読める。

### 2. `svg` のコードブロック

コードブロックの中身はファイルでないので、`sandbox_grant` には渡せない。op を 1 つ足す。

- `sandbox_grant_svg { content }` (user role だけ)。答えは `sandbox_grant` と同じ `{ gid, token, url, exp }`
- daemon は `content` を grant と一緒にメモリに持ち、sandbox origin の今の配信の中で、`/<token>/figure.svg` に `image/svg+xml` として返す。応答ヘッダは preview と同じ。ファイルは読まない
- gid は発行のたびに新しくする (図ごとに別の origin)。期限と取り消しは今の grant と同じ (30 分、`sandbox_revoke`、daemon の再起動で消える)
- `content` は 512 KiB まで (`FS_READ_MAX_BYTES`。svg のファイルを webui が読める大きさと同じにして、op の 1 行の大きさを抑える)。超える時は断り、webui は実行を押せなくして理由を出す

渡せるのは webui が既に持っている文字だけで、daemon が読める範囲は変わらない (DR-0030 §5)。足すのは「grant が、ファイルの代わりに渡された文字を持てる」ことだけで、道筋・origin・応答ヘッダは今のまま。

### 3. 見せ方

- 今の「描画 | ソース」の部品 (`FenceFigure` の `Tabs`) に「実行」を 1 区画足す。新しい見た目は作らない
- 「実行」を押すと、preview と同じ開き方で別のタブに開く (押した時に空のタブを開き、grant の URL を入れる)。選択は描画のまま動かない。保存せず、URL に書かない
- `sandbox_available` が無い環境では、実行の区画を出さない
- 描画できない svg (img の読み込みが失敗するもの) は、実行を押せない
- 付く所: `svg` のコードブロックが図になる所 (`renderCodeFence` を通る、restricted でない `MarkdownView`。エージェントの応答の吹き出し、Files の markdown のプレビュー、Timeline の中に出すファイルの中身、本文を書く欄の md のプレビュー) と、`.svg` のファイルのビューア。ユーザの発言の吹き出しは restricted で、svg のブロックはコードのまま描かれるので付かない
- mermaid と数式には付けない

### 4. 検証の計画

- `sandbox_grant_svg` の URL の応答が、preview のファイルの応答と同じヘッダで、`Content-Type` が `image/svg+xml`
- 違う token・期限切れ・取り消した後は、ファイルの grant と同じ答えになる (404 / 410)
- `sandbox_grant_svg` は user role だけが呼べ、512 KiB を超える `content` を断る
- sandbox origin 宛ての要求が `/ws` と webui の配信に届かないこと (今の試験) が、足した grant でも成り立つ
- e2e: 実行を押すと別のタブで svg が開き、スクリプトが動く。押すまで `sandbox_grant` / `sandbox_grant_svg` を呼ばない。押した後も選択は描画のまま
- `sandbox_available` が無い時、mermaid と数式、ユーザの発言の吹き出しに、実行の区画が無い
- `.svg` のファイルのビューアに 3 つの区画が出る

## 未決

### Q1. 実行を別のタブで開くか、その場の iframe に出すか

- 原意図: 「描画 | ソース | 実行」の切り替え (依頼)。preview は別のタブで開く (DR-0030 §7.2)
- 選択肢:
  - (a) 別のタブ (§3): preview と同じ開き方で、足す部品が無い。図は本文の中では動かず、「実行」は切り替えでなく開く操作になる。svg のスクリプトが `history.back()` を呼んでも、終わらないループに入っても、webui のタブは動かず固まらなかった (findings)
  - (b) その場の iframe (`src` に grant の URL): 図が本文の中で動き、切り替えとして働く。preview の CSP の `frame-ancestors` は webui の origin を許していて、iframe でもスクリプトは動いた (findings)。図の大きさ、止め方 (iframe を外す)、取り消しを決めることになる。svg のスクリプトが webui のタブの中で動くので、WebKit では webui の履歴を戻され、終わらないループの間 webui が応答しなかった (findings)
- 推し: (a)。preview と同じ形で、svg のスクリプトが webui のタブに作用しない

### Q2. コードブロックの口 (`sandbox_grant_svg`) を今足すか

- 原意図: svg のブロックとファイルの両方に付ける (依頼)
- 選択肢:
  - (a) 足す (§2): エージェントが応答に書いた図をそのまま実行できる。protocol に op が 1 つ増える
  - (b) ファイルだけ先に入れる: daemon も protocol も変えない。応答の中の図は、エージェントがファイルに書いた時だけ実行できる
- 推し: (a)。応答に図を書かせる使い方が主で、ファイルだけでは届かない

## Alternatives Considered

| 案 | 不採用理由 |
|---|---|
| 受け皿の html を sandbox の iframe で開き、その中の sandbox の srcdoc に svg を入れる 2 段 (dirview の形) | dirview は別の origin も応答ヘッダも持てないのでこの形になる。ccmsg は両方を持ち、preview が既に同じことをしている |
| 受け皿を webui の側で持つ (`/assets` の html、srcdoc、`data:` の URL) | svg だけの受け皿と約束を持つことになる。`/assets` の html は、webui の origin から配るスクリプトの動く文書でもある |
| svg にだけ、preview より厳しい CSP を付ける | svg だけの守りになる。守りを強めるなら preview の CSP を変える |
| コードブロックの中身を添付の upload で daemon に預ける | 添付は webui の origin から配られていて、sandbox origin に載っていない (DR-0030 の Phase 3) |
| 実行の選択を覚える | 守ること 1 |

## Consequences

- svg のスクリプトにできることは preview の html と同じ。同じディレクトリのファイルを読め、自分を外部の URL へ遷移させられる (findings)
- sandbox origin を設定していない環境では、svg を実行できない
- protocol に op `sandbox_grant_svg` が増える (Q2)。daemon の grant がファイルの他に文字を持つようになり、1 件あたり最大 512 KiB を最長 30 分メモリに持つ
- コードブロックの svg は 1 つの文書として配るので、相対のパスの資源を読めない
- webui は今 `sandbox_revoke` を呼んでいないので、grant は期限まで残る (preview と同じ)

## 関連

- [issue 2026-11-25](../issue/2026-11-25-lean-highlight-and-svg-script-run.md) — 依頼 (2. svg のスクリプトの実行)
- [DR-0030](./DR-0030-sandbox-origin-serving.md) — sandbox origin の配信 (preview)
- [DR-0010](./DR-0010-timeline-markdown-rendering.md) §12 — svg のコードブロックの描画と「描画 | ソース」の箱
- [findings 2026-11-25](../findings/2026-11-25-svg-script-run-sandbox.md) — sandbox と CSP の下で svg のスクリプトにできることの実測
