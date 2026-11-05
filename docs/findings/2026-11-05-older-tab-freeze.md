# Timeline の older を先頭まで読んだ時のタブの重さの計測

- Date: 2026-11-05
- 対象: ccmsg v0.212.0 の webui、playwright の Chromium (headless) と WebKit (headless)
- 動機: kawaz 2026-11-05 の報告。older を何度か押す (先頭まで読む等) とほぼ毎回タブが固まって死ぬ。kawaz の再現手順: older で全部読み切る → その時点ではスクロールは普通に動く → Terminal や画面内の別タブ (Files / Status 等) をクリックした瞬間に全部固まる
- 方法:
  - 隔離 daemon (verify skill の手順) に、Messages API の代役で動く試験セッションを置き、個人面の大きい transcript の写しを resume した (58 MB の 1 本と、49 MB の 1 本を `--fork-session` した 17 MB の 1 本)
  - playwright で TL を開き、older を先頭まで押した。押すごとに DOM ノード数、`performance.memory.usedJSHeapSize`、long task (PerformanceObserver) を記録し、CDP の Profiler で CPU の内訳を取った。内訳を読むために、計測の間だけ webui の bundle を minify せずに出した (確認の後に戻した)
  - 先頭まで読んだ状態で、そのセッションに短い turn (Bash を 1 回使う) を 3 回続けて流し、その間の long task を合計した。比べるために、初回の読み込みだけの状態でも同じ 3 turn を流した

## 判明した事実

### 1. older を先頭まで読むまで

17 MB (Chromium):

| older の回数 | DOM ノード | JS heap | 押してから描かれ始めるまで | その回までの最長の long task |
|---|---|---|---|---|
| 1 | 6,073 | 34 MB | 411 ms | 183 ms |
| 2 | 8,035 | 57 MB | 411 ms | 183 ms |
| 3 | 23,879 | 94 MB | 597 ms | 1,411 ms |
| 4 (先頭) | 24,533 | 125 MB | 1,496 ms | 1,411 ms |

58 MB (Chromium): 12 回で先頭。DOM ノード 14,860、JS heap は 150〜430 MB の間を上下した (GC の時機による)。押してから落ち着くまで 0.2〜1.8 秒。WebKit (17 MB) も 4 回で先頭、DOM ノード 23,959、1 回の描画の最長の間隔 1.4 秒。

- どちらのエンジンでも、先頭まで読むこと自体ではタブは固まらなかった
- 58 MB で 1 度、先頭まで読んだ直後の計測が 77〜79 秒止まったが、Profiler では計測側の関数 (button を全部 `innerText` で探す処理) の中だった。`innerText` は layout を強いるので、2 万ノードの TL ではこれだけで固まる。`textContent` に変えた計測では再現しなかった。webui 自身のコードの long task ではない

### 2. 先頭まで読んだ状態で turn が流れた時

17 MB、3 turn (約 13 秒):

| 状態 | DOM ノード | long task の数 | 最長 | 合計 |
|---|---|---|---|---|
| 初回の読み込みだけ (head) | 402 | 0 | 0 ms | 0 ms |
| older で先頭まで | 24,533 | 34 | 1,314 ms | 17,685 ms |

- 先頭まで読んだ TL では、live tail の push 1 回ごとに 150 ms〜1.3 秒の long task が出て、3 turn の間に main thread が合計 17.7 秒ふさがった。turn が続く限りこの状態が続くので、忙しいセッションを見ているとタブはほぼ応答しなくなる
- 同じ状態で `.tl-lines > .tl-line` に `content-visibility: auto` を当てても (playwright で style を足しただけ) 減らなかった (23 件、最長 2,730 ms、合計 19,717 ms)

CPU の内訳 (先頭まで読んだ状態で 3 turn を流した 14 秒、自己時間):

| 箇所 | 時間 |
|---|---|
| `(program)` (layout・style 等の native) | 8,288 ms |
| `useStickToBottom` の `measure` (`scrollHeight` の読み = 強制 layout) | 2,728 ms |
| `MarkdownView` の `parseMarkdownDocument` 以下 (合計時間) | 1,426 ms |
| `ScrollHold.toBottom` (合計時間) | 715 ms |

### 3. 読み切った後の画面内の移動で固まる (kawaz の手順)

17 MB を older で先頭まで読み (DOM ノード 46,640)、Files タブのリンクをクリックした。playwright-core を直接使い、クリックの後にページへ式を評価させて応答までの時間を見た。固まっている間の JS の位置は、クリックの前に Debugger を有効にしておき、`Debugger.pause` で取った。

| | クリックからページが応答するまで | 固まっている間の stack |
|---|---|---|
| 直す前 | 60 秒を超えて応答なし (Profiler の停止も 30 秒で返らない) | `capture` (SessionView) ← navigation.ts の `BEFORE_NAVIGATION_EVENT` の dispatch (3 回取って 3 回とも同じ) |
| 直した後 | 335 ms (`/files` へ移っていた) | — |

- 原因: SessionView は、隠れた後に表示へ戻った時のスクロール位置を戻すために、画面内の移動 (タブの切り替え、別のセッションへの移動) のたびに `BEFORE_NAVIGATION_EVENT` で view の中の要素を全部 (`querySelectorAll("*")`) 走査し、各要素の `scrollTop` / `scrollLeft` を読んでいた
- `scrollTop` の読みは layout を強いる。読み切った TL では 1 要素あたり約 26〜33 ms かかり (先頭の 100 要素で 2.6 秒、1,000 要素で 32.7 秒、3,000 要素で 53.9 秒)、view の中の約 2.5 万要素を読み終えるまで main thread が返らない
- 直し方: 位置は要素のスクロールのイベント (view の root で capture phase で聞く) から取って持ち、移動の時には要素を読まない。表示に戻った時に、持っている要素のうち DOM に残っているものだけ位置を戻す

## 判断に効く含み

- 重さは「読んだ量に比例する DOM を全部実体化して持つ」ことから来ている。push のたびの layout (scroll の位置の計測と末尾への寄せ) と、markdown の parse のやり直しが、読んだ量に比例して重くなる
- kawaz の言う「固まって死ぬ」は §3 (読み切った後の画面内の移動) で、移動のたびの全要素の `scrollTop` の読みが原因。直した後は 335 ms で移る
- §2 の push ごとの重さは別に残る (読んだ量に比例する DOM を全部持つことによる)

## 未検証

- 実ブラウザ (headed、拡張機能あり) と iPad Safari での同じ計測
- LRU が複数の大きい TL を隠れたまま持っている時のメモリ
- push のたびに `MarkdownView` の parse が既存の行でもやり直されているのか (新しい行の分だけなのか)。`useMemo` の deps に毎回変わる値があるかは読んでいない
