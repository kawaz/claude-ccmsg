# TL の live tail の push 1 回に残っていた script の内訳と、その削減

- Date: 2026-11-19
- 対象: ccmsg v0.290.0 の webui、playwright の Chromium (chrome-headless-shell、build 1255) と WebKit (build 2391)、どちらも headless、窓は 1280×900
- 動機: issue `2026-11-05-timeline-push-cost-after-older` の残り。findings `2026-11-15-timeline-base-cost` で CSS の 2 つの原因を直した後も、過去分を読み切った TL では push 1 回に 200〜300ms の script (WebSocket の `onmessage` の中) が残っていた。その内訳を取り、読んだ量に比例して伸びる仕事を特定して削る

## 判明した事実

- push 1 回の script のほとんどは、画面にある既存の吹き出し全部の markdown の parse と描画のやり直しだった。Chromium の profile で push 1 回あたり Preact の描画が約 363ms、そのうち `MarkdownView` (`parseMarkdownDocument` と AST の描画) が約 275ms。描画の部品ごとの時間でも、Chromium で Timeline 333ms のうち `MarkdownView` 273ms (約 830 個)、WebKit で 413ms のうち 337ms だった。issue の問い「push のたびに `MarkdownView` の parse が既存の行でもやり直されているか」の答えは「全部やり直している」
- 全部やり直していた理由は 2 段ある
  - なぜ吹き出しが全部描き直されるか: push で `Timeline` が描き直され、吹き出し (`UserPromptBubble` / `AssistantBubble`) が memo されていないので、行が変わっていない吹き出しも全部描き直される
  - なぜ描き直すと parse までやり直すか: `MarkdownView` は parse と描画を `useMemo` で持っているが、その依存の `filePathLinker` / `pathLinker` を `LinkedMarkdownView` が描画のたびに新しい関数として作っていた (`makeFilePathLinker` / `makeMarkdownPathLinker` をそのまま呼んでいた)。memo が毎回外れ、描き直すたびに parse していた
- push の後にも、同じ「全部の吹き出しの parse のやり直し」を起こす経路が 2 つあった
  - peers の push: セッションの活動 (`transcript_push` も含む) が動くと、daemon は 5 秒の窓の後に peers の一覧を push する (DR-0053 §5)。`Timeline` の `sessionFilePathCtx` が peer の行の identity で memo されていたので、同じ値でも新しい ctx になり、全部の linker が変わって全部 parse し直した。push の約 5 秒後に、Chromium で約 250ms、WebKit で約 340ms の長いフレームが毎回出ていた
  - パスの存在の確認の答え: 新しい吹き出しにパスらしい inline code があると `fs_stat_batch` で確かめる。答えが届くと cache が全部の購読者に通知し、全部の吹き出しの linker が変わって全部 parse し直した。パスを含む push の settle が Chromium で 407 → 619ms、WebKit で 537 → 804ms に伸びていた
- 直した後、push 1 回の script は Chromium で約 25ms、WebKit で Preact の commit までが約 32ms になった。push の約 5 秒後の長いフレームは出なくなり、パスを含む push も含まない push と同じ値になった (下の「前後の比較」)
- 直した後に残る、読んだ量に比例する仕事
  - 画面内検索の飾り付けの effect (`useInViewSearch.ts` の `highlightRenderedText` を検索の単位の全部に): 1 回約 19ms (両エンジン)。検索語の既定値 (`DEFAULT_TIMELINE_SEARCH`、`👺` の正規表現) で検索が常に生きているので、push のたびに全部の単位で DOM の文字を集め直す。描画の後の別の task
  - `useTranscriptModel` の窓全体の pass (`crossLineIncrementally`、`resolveToolResults` 等): Chromium で 1 回約 8ms。incremental-cross-line.ts が「窓全体で計算し、identity を引き継ぐ」と決めているもの
  - WebKit では commit から次の task までに約 65〜70ms (sync 約 100ms のうち)。script ではなく、2 ノードの追加の後の layout / 描画と見る (WebKit に LoAF が無く、分けて測っていない)

## 直したこと

- `LinkedMarkdownView` / `LinkedPlainText`: linker を `useMemo` で持ち、ctx を object でなく値 (sid、cwd、repoRoot 等) で memo した。呼ぶ側が同じ値の ctx を作り直して渡しても (ccmsg の吹き出しの `filePathCtxForSender` は描画のたびに作る) parse し直さない
- パスの存在の cache (`filepath-existence-cache.ts`): 通知に「どの sid のどのパスに答えたか」(cache を消した時は「その sid の全部」) を載せた。吹き出しは自分の本文が名指すパスの答えの時だけ描き直す (`useFilePathProbe`)。tool のカードの 1 パスの確認も同じ形にした (`useFilePathStatus`)
- `Timeline` の `sessionFilePathCtx` を peer の行でなく値 (cwd、repo_root、repo) で memo した。peers の push で context の値が変わらず、吹き出しが描き直されない
- `UserPromptBubble` / `AssistantBubble` を `memo` した (`MemoUserPromptBubble` / `MemoAssistantBubble`)。行が変わっていない吹き出しは、incremental-cross-line.ts が同じ `line` を返し、他の props も `Timeline` が memo しているので、push で描き直されない (fold の `MemoFoldGroup` と同じ前提)
- テスト (`timeline-push-reuse.dom.test.ts`、`filepath-linker.dom.test.ts`、`filepath-existence-cache.test.ts`) で、push で描くのは新しい吹き出しだけであること、同じ値の peers の push と別の本文のパスの答えでは吹き出しを作り直さないこと、通知が答えたパスを名指すことを固定した。どれも直す前のコードでは落ちる

## 実用的な示唆 / ベストプラクティス

- `useMemo` の依存に関数や object を渡すなら、渡す側で値によって memo する。呼ぶ側が毎回作る object (ctx 等) を受ける部品は、使う fields に分けて memo する。依存が描画のたびに変わる memo は何も memo していない
- 全体に配る通知 (tick) を多数の部品が memo の key に使うと、通知 1 回で全部が作り直される。通知に何が変わったかを載せ、部品は自分に関係する時だけ描き直す
- peers のように活動のたびに push され直す一覧から派生する値は、使う fields で memo する
- push の重さは、push を受けた task だけでなく、数秒後に来る二次の push (peers) と、push が引き起こす問い合わせの答え (`fs_stat_batch`) の後も見る。今回の 3 経路のうち 2 つは push の task の外で出ていた
- 「memo は計測で効く所だけ」の判断材料: 吹き出しの memo は、linker を直した後の Chromium の push の描画 56ms のうち約 35ms を占めていた吹き出しの描き直しを消した

## 方法

- 隔離 daemon (作業コピーの `packages/daemon/src/index.ts --foreground`、`HOME` / `TMPDIR` / `CCMSG_STATE_DIR` / `CCMSG_CONFIG_DIR` / `CCMSG_DATA_DIR` を一時ディレクトリ、`CCMSG_CLAUDE_CONFIG_DIRS` に試験用の config home だけ)。試験用の config home に `sleep` の pid の `sessions/<pid>.json` と自作の transcript を置いた
- transcript は findings `2026-11-15-timeline-base-cost` の状態 B と同じ形を目標に生成した (その時の生成器は残っていないので作り直した): 250 turn、tool の呼び出し 2,961 回 (結果の本文は 2〜4.4KB)、ユーザ発話と assistant の本文の吹き出し 940 個 (本文の半分に箇条書き、3 割にコードブロック、inline code のパス)、15.2MB。過去分を先頭まで読み切ると (読み込み 3 回) 要素 48,969 個 (Chromium) / 48,029 個 (WebKit)、fold 690 個で、状態 B の 47,514 個に近い
- push の送り手は、試験用の sid として hello し、run を名乗る小さなスクリプト。叩くと transcript に 2 行足して `transcript_push` を送る。`pair` はユーザ発話と assistant の本文 (吹き出し 2 つ)、`pairpath` は assistant の本文に存在しないパスの inline code (`packages/webui/src/p<n>.ts`) を含めたもの
- 計測は playwright-core で TL を開き、過去分を先頭まで読み、⤓ で末尾に寄せてから push を 5 回 (push の間は 7 秒空ける)。条件ごとに transcript を生成時に戻し、daemon と送り手を起こし直した
  - t0: ページが WebSocket の `ev:"transcript"` を読んだ時刻 (アプリより先に付けた message の listener)
  - sync: t0 から、t0 で投げた MessageChannel のメッセージが届くまで (onmessage の task とその microtask。Preact の描画はここに入る)
  - settle: t0 から、フレームの間隔が 25ms 未満で 6 回続いた最初のフレームまで。何もしなくても約 100ms かかる
  - maxGap: push の間の最大のフレーム間隔。「5 秒後の長いフレーム」は push の後の 7 秒の間の 50ms を超えるフレーム間隔
  - Chromium は LoAF で `onmessage` の script の時間も取った
- 内訳: Chromium は CDP の Profiler (サンプリング 100µs、push 10 回) で関数ごとの自己時間と合計時間を集計した。部品ごとの時間は、Preact の `options` の diff の始まりと `diffed` の間を部品の名前ごとに足した (両エンジン)。markdown の parse の回数は `MarkdownView` の parse の呼び出しに時刻を記録した。どちらも計測の間だけ webui のコードに足し、bundle を minify せずに出した。前後の比較の表は、これらを外し minify した普段の bundle で測った
- 前は main (v0.290.0)、後は直した commit で、同じ fixture と手順で続けて測った。計測の前に `just` と `bun test` の process が無いことを確かめた

## 検証の詳細

### 前後の比較 (状態 B 相当、push 5 回の中央値 (最小-最大)、ms)

| ブラウザ | push | sync 前 → 後 | settle 前 → 後 | 最大のフレーム間隔 前 → 後 | 約 5 秒後の長いフレーム 前 → 後 |
|---|---|---|---|---|---|
| Chromium | pair | 284 (277-285) → 25 (20-43) | 407 (399-415) → 174 (160-197) | 267 → 33 | 250 (233-267) → なし |
| Chromium | pairpath | 279 (274-295) → 28 (27-35) | 619 (613-645) → 171 (170-189) | 267 → 33 | 250 (233-267) → なし (5 回中 1 回 50) |
| WebKit | pair | 401 (393-427) → 107 (97-113) | 537 (517-552) → 232 (222-250) | 358 → 87 | 337 (334-360) → なし |
| WebKit | pairpath | 403 (397-418) → 103 (97-112) | 804 (802-848) → 230 (216-247) | 359 → 86 | 334 (323-340) → なし |

- Chromium の LoAF の `onmessage` の script は、前の pair で 266ms、pairpath で 483ms (push の task 約 260ms と、`fs_stat_batch` の答えの task 約 220ms の 2 つ)。後はどちらも 50ms 未満で LoAF に出ない
- push の後はどの条件も末尾に付いたまま (末尾からの距離 0)
- 前の値は findings `2026-11-15-timeline-base-cost` の v0.268.0 の値 (Chromium の push 約 235ms) より大きい。fixture を作り直したことと計測の仕方 (sync / settle の取り方) が違うので、その findings の表とは直接比べない

### 内訳 (直す前、計測用の bundle)

Chromium の profile (push 10 回、1 回あたりに直した値):

| 箇所 | ms |
|---|---|
| Preact の描画 (rerender の queue の処理の合計) | 363 |
| うち `MarkdownView` (parse と AST の描画) | 275 |
| うち `parseMarkdownDocument` | 240 |
| `Timeline` の関数自身 | 14 |
| 画面内検索の飾り付けの effect (`highlightRenderedText`) | 22 |
| `(program)` (native) | 47 |

部品ごとの合計時間 (push 5 回の 1 回あたり、括弧は描画の回数):

| 部品 | Chromium | WebKit |
|---|---|---|
| `Timeline` | 333 | 413 |
| `AssistantBubble` | 302 (832) | 369 (838) |
| `MarkdownView` | 273 (832) | 337 (838) |
| `BubbleFooter` | 18 (1,136) | 21 (1,148) |
| `UserPromptBubble` | 9 (304) | 9 (310) |

markdown の parse の回数 (Chromium、push の間は 7 秒。約 700 は assistant の本文の吹き出しの数で、ユーザ発話の吹き出しは markdown にしない):

| | push の task | 約 5 秒後 (peers の push) | パスの答えの後 |
|---|---|---|---|
| 直す前 | 約 830 (全部、`MarkdownView` の描画の回数) | 全部 (数えていない) | 全部 (数えていない) |
| linker の memo だけ | 1 | 約 700 (全部) | 約 700 (全部) |
| 全部直した後 | 1 | 0 | 1 (その吹き出しだけ) |

直す前は parse の回数ではなく `MarkdownView` の描画の回数を数えた (linker が描画のたびに新しいので、描き直された吹き出しは必ず parse し直す)。「約 5 秒後」と「パスの答えの後」は数えていない。どちらの時も吹き出しは全部描き直され (peers の push は context の値を変え、cache の通知は全部の購読者に届く)、Chromium の約 250ms の長いフレームと、LoAF の答えの task の約 220ms はその量に合う。

### 内訳 (直す途中と後、計測用の bundle)

| 段階 | ブラウザ | sync | `Timeline` の描画 | 主な内訳 |
|---|---|---|---|---|
| linker の memo だけ | Chromium | 約 70 | 56 | 吹き出しの描き直し (`ItemRawToggle` 以下) 35、`MarkdownView` 3 (692 回、memo が効いて parse しない) |
| 吹き出しの memo も | Chromium | 約 20 | 20〜22 | `useTranscriptModel` 8、`ItemRawToggle` 5 (memo の比較だけ) |
| 吹き出しの memo も | WebKit | 約 99 | 28 | commit まで約 32、そこから次の task まで約 67 |

直した後の Chromium の profile (push 10 回の 1 回あたり): `Timeline` の描画 約 13ms (`useTranscriptModel` 7.9: `crossLineIncrementally` 5.1、`resolveToolResults` 2.2、`itemRawSourceOffsets` 1.3、`groupTimelineLines` 1.1)、画面内検索の飾り付けの effect 約 21ms (別の task)。

## 分からなかったこと

- 実 Safari と画面を出した Chrome での値。headless の 2 エンジンだけで測った
- fixture は自作で、実際のセッションの吹き出し・fold・コード・パスの比率と同じかは確かめていない
- session_status の push (TL の下の要約、`AgentTimelineHrefsContext` / `AgentEngineLabelsContext` の値が変わる) の時の描き直しは測っていない。fixture のセッションには hooks module が無く、session_status が来ない
- ccmsg の吹き出し (`CcmsgBubble`) は memo していない。push のたびに描き直されるが、ctx を値で memo したので markdown は parse し直さない。fixture に ccmsg の吹き出しが無く、時間は測っていない
- WebKit の commit から次の task までの約 67ms が layout か描画か
