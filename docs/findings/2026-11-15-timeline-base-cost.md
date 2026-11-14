# TL の基礎コスト (検索と関係しない 1 操作ごとの重さ)

issue `2026-11-05-timeline-push-cost-after-older` と findings `2026-11-12-in-view-search-range-cost` の「TL の基準の重さ」の続き。TL の行が増えた時に、push・TL の外の DOM 変更・TL の中の 1 か所の変更がそれぞれどれだけかかるかを 3 つの状態で測り、原因を CSS の注入で切り分ける。

## 判明した事実

- 普通に開いた直後 (状態 A、要素約 3,300) はどの操作も 1〜3 フレームで終わる。重いのは過去分を読み切った状態 (B) と本文が全部 mount された状態 (C)
- 普段の形のセッションを読み切った状態 B (要素約 4.7 万、吹き出し 1,035、fold 741) は C (要素約 3 万) より重い。Chromium で push 1 回 3.7〜5.6 秒、TL の中の文字 1 か所の変更 + 強制 layout が約 3.5 秒、TL の外の DOM 変更で約 330ms。WebKit で push 約 1.2 秒、TL の中の 1 か所の変更が約 1 秒、TL の外の変更は 16ms (2 フレーム未満)
- Chromium では、どの状態でも push の時間のほとんどが描画の段 (LoAF の renderStart 以降) で、script は 150〜210ms
- Chromium の重さの原因は、assistant の吹き出しごとの ☰ (`.tl-msg-menu-toggle`) が全部同じ `anchor-name: --tl-msg-menu` を持つこと。同じ名前の anchor の数に対して layout の時間が超線形 (合成ページで anchor 125 → 1,000 個で 37ms → 1,613ms、行と anchor を一緒に倍にすると 1 段ごとに 7〜15 倍) に伸びる。名前を anchor ごとに変える、または `anchor-scope` で名前の届く範囲を ☰ の包みに閉じると、anchor 1,000 個でも 5〜7ms に戻る。flex の列は関係しない (全部 block でも同じ重さ)
- 同じ原因で、☰ のメニューは押した ☰ ではなく文書の最後の ☰ の下に開いている (Chromium・WebKit とも)。状態 B で 401 番目の ☰ を押すと、☰ は画面の y=493 にあるのにメニューは y=88,294 (最後の ☰ の下、画面の外) に出た
- `.tl-msg-menu-anchor { anchor-scope: --tl-msg-menu; }` の 1 行を注入すると、Chromium の状態 B で push 5,577 → 234ms、TL の中の 1 か所 3,533 → 33ms、TL の外 348 → 33ms、fold の開閉 5,398 → 52ms。状態 C で push 3,259 → 182ms。メニューは押した ☰ の真下に、右端を揃えて開き、画面の下端では上に折り返す (両エンジンで位置を確かめた)
- その後の Chromium の push に残るのは、WebSocket の `onmessage` の中の script (状態 B で約 185ms、C で約 145ms)。layout は 15〜30ms

## 実用的な示唆 / ベストプラクティス

- 同じ `anchor-name` を多数の要素に付けない。繰り返し出る部品の anchor は、部品の包みに `anchor-scope` を付けて名前を閉じる。名前が衝突すると、重さ (Chromium) とは別に、どの anchor に付くかも「文書で最後のもの」になって位置が狂う
- Chromium の trace の `Layout` の `totalObjects` は「やり直した数」ではなく文書の layout object の総数で、anchor を直した後も同じ値 (約 8 万) が出る。全体のやり直しかどうかは時間で見る

## 方法

- 隔離 daemon (作業コピーの `packages/daemon/src/index.ts --foreground`、`HOME` / `TMPDIR` / `CCMSG_STATE_DIR` / `CCMSG_CONFIG_DIR` / `CCMSG_DATA_DIR` を一時ディレクトリ、`CCMSG_CLAUDE_CONFIG_DIRS` に試験用の config home だけ)。試験用の config home に `sleep` の pid の `sessions/<pid>.json` と自作の transcript を置いた。push は、試験用の sid として hello して run を名乗る小さなスクリプトが transcript に 2 行足して `transcript_push` を送る (前の findings と同じ方式)
- ブラウザは headless の playwright-cli。Chromium は Chrome 157 (headless)、WebKit は playwright の WebKit (UA は Version/27.2)。窓は 1280×900
- 状態
  - A: 状態 B と同じ transcript を普通に開いた直後 (過去分は読まない)
  - B: 普段の形のセッションの transcript を自作したもの (250 turn、tool の呼び出し 3,232 回、本文の吹き出し約 1,035、fold 約 1,000、15.8MB) を開き、「過去分」を先頭まで読み切った状態 (読み込み 3 回)
  - C: user と assistant の本文を交互に 1,700 行 (約 970KB)。最初の読み込みで全部描かれ、本文がどれも吹き出しなので fold に入らない
- 条件ごとに transcript を生成時の行に戻し、daemon と送り手を起こし直して TL を開き直した
- 操作と測るもの
  - push: 送り手を叩いて 2 行を足す。`pair` は user と assistant の本文 (吹き出し 2 つ)、`tool` は tool の呼び出しと結果 (末尾の fold に入る)。t0 はページが WebSocket の `ev:"transcript"` を読んだ時刻
  - TL の外の DOM 変更: body に fixed の div を置き、子を 1 つ足して文字を書き換え、`offsetHeight` で layout を強いる (アプリのコードは走らない)
  - TL の中の 1 か所の変更: 真ん中の吹き出しの本文の文字ノードを 1 つ書き換え、その親の `offsetHeight` で layout を強いる (アプリのコードは走らない)
  - settle: t0 から、フレームの間隔が 25ms 未満で 6 回続いた最初のフレームまで (rAF の時刻)。同期 layout は変更から `offsetHeight` が返るまで。Chromium だけ Long Animation Frame (LoAF) でフレームの描画 (renderStart 以降) と script を分けた
- 各操作 5 回。値は中央値 (最小-最大)、単位は ms。各状態の計測の前後に `just` と `bun test` の process が無いことを確かめた (どの行も 0 個)

## 検証の詳細

### 基準の表 (今の main、v0.265.0)

要素の数は `document.querySelectorAll("*")`。

| 状態 | ブラウザ | 要素 | 吹き出し / fold | push (pair) | push (tool) | TL の外の変更 settle (同期 layout) | TL の中の 1 か所 settle (同期 layout) |
|---|---|---|---|---|---|---|---|
| A | Chromium | 3,364 | 68 / 50 | 35 (28-41) | 31 (29-44) | 34 (1) | 32 (7) |
| A | WebKit | 3,296 | 68 / 50 | 50 (49-54) | 41 (37-67) | 16 (2) | 17 (10) |
| B | Chromium | 47,514 | 1,035 / 741 | 5,577 (3,759-5,809) | 5,601 (3,678-9,252) | 348 (330) | 3,533 (3,488) |
| B | WebKit | 46,479 | 1,035 / 741 | 1,234 (1,225-1,253) | 1,183 (1,180-2,206) | 16 (2) | 981 (950) |
| C | Chromium | 29,911 | 1,700 / 0 | 3,259 (3,236-4,983) | 3,280 (3,221-4,866) | 301 (294) | 3,122 (3,066) |
| C | WebKit | 28,211 | 1,700 / 0 | 1,264 (1,252-1,969) | 1,238 (1,224-2,021) | 18 (2) | 1,061 (0) |

- Chromium の push は 3.5 秒前後と 5.5 秒前後の 2 つの値に分かれる (B の pair: 3,759 / 3,771 / 5,577 / 5,733 / 5,809)。LoAF の描画の段が 1 回分か 2 回分かの差に見える (未確認)
- Chromium の LoAF: push の script は B で約 205ms、C で約 160ms。残りは描画の段 (B の pair で 5,352ms)
- B の Chromium で fold 1 つの開閉は 5,398 (3,516-7,281) ms、WebKit で 1,020 (995-2,277) ms。スクロールはどの状態も 2 フレーム前後
- WebKit の C の「TL の中の 1 か所」は、強制した同期 layout が 0ms なのに settle は 1,061ms。B では同期 layout 950ms。C で `offsetHeight` が時間を取らない理由は未確認
- 「過去分」を先頭まで読むのにかかった時間: Chromium 14.3 秒、WebKit 6.9 秒 (3 回の読み込み)

### Chromium: anchor-name の裏付け

#### 実アプリへの CSS の注入 (状態 B、TL の中の 1 か所の変更 + 強制 layout、5 回の中央値)

| 注入した CSS | ms |
|---|---|
| なし | 3,351 |
| `.tl-msg-menu-toggle{anchor-name:none!important}` | 13.8 |
| `.tl-msg-menu-anchor{anchor-scope:--tl-msg-menu}` | 14.2 |
| `.tl-msg-menu-anchor{anchor-scope:all}` | 13.3 |
| `.tl-bubble{anchor-scope:all}` | 17.0 |
| anchor-name を外し、`[aria-expanded=true]` の ☰ にだけ付ける | 10.7 |
| `.tl-msg-toolbar{display:none!important}` | 11.7 |

#### trace (devtools.timeline、状態 B、1 回ずつ)

| 操作 | 注入 | 結果 |
|---|---|---|
| TL の中の 1 か所 | なし | Layout 1 回 3,378ms (dirty 19 / total 79,979、partial ではない) |
| TL の外の変更 | なし | Layout 1 回 913ms (dirty 5) |
| push (pair) 1 回 | なし | 9,185ms (trace の負荷込み)。Layout 3 回: 3,401ms (dirty 58)、3,437ms (dirty 29)、1,852ms (dirty 19) |
| TL の中の 1 か所 | anchor-scope | Layout 0.0ms |
| TL の外の変更 | anchor-scope | Layout 1.2ms (dirty 3) |
| push (pair) 1 回 | anchor-scope | 255ms。Layout 1 回 15.6ms (dirty 58 / total 80,073) |

- push の値が 3.5 秒と 5.5 秒の 2 つに分かれるのは、1 回の push で走る全体 layout の回数 (1〜3 回) の差と読める (trace では 3 回)
- `totalObjects` は anchor を直した後も約 8 万で変わらない。前の findings で「文書全体の 39,354 個をやり直していた」と書いたのは、この値を「やり直した数」と読んだもので、その読みは誤り。重さは時間 (3,378ms → 0〜16ms) で見る

#### 合成ページ (anchor の数に対する伸び方)

一時ディレクトリの HTML を localhost で配った。行ごとに 26 語の段落を持つ吹き出しを並べ、何行かおきに ☰ の包み (`position: relative; display: flex`) とボタンを置く。ボタンに付ける anchor-name を切り替える。値は真ん中の行の文字を変えて `offsetHeight` で強制した layout (5 回の中央値、ms)。Chromium のみ。

行と anchor を一緒に増やす (2 行に 1 個、外側は TL と同じ 3 段の column flex):

| 行 | anchor | 要素 | anchor なし | 同じ名前 |
|---|---|---|---|---|
| 250 | 125 | 1,010 | 0.5 | 3.5 |
| 500 | 250 | 2,010 | 1.0 | 23.5 |
| 1,000 | 500 | 4,010 | 1.8 | 179.6 |
| 2,000 | 1,000 | 8,010 | 3.9 | 1,612.9 |
| 4,000 | 2,000 | 16,010 | 8.5 | 24,965.7 |

行を 2,000 に固定して anchor の数だけ変える:

| anchor | 条件 | ms |
|---|---|---|
| 125 | 同じ名前 | 37.0 |
| 250 | 同じ名前 | 107.0 |
| 500 | 同じ名前 | 515.8 |
| 1,000 | 同じ名前 | 1,612.9 |
| 1,000 | 同じ名前、flex なし (全部 block) | 1,831.2 |
| 1,000 | anchor ごとに別の名前 (`--m1`, `--m3`, ...) | 7.0 |
| 1,000 | 同じ名前 + 包みに `anchor-scope: --m` | 5.0 |

- anchor なしは行の数に比例 (線形)。同じ名前の anchor があると、行を固定しても anchor の数に対して 2 倍ごとに 3〜5 倍で伸びる
- 名前が別々なら、同じ数の anchor でも重くならない。重さは「anchor があること」ではなく「同じ名前の anchor が多いこと」で決まる
- TL の外の変更 (fixed の div) も同じ名前の anchor 1,000 個で 402〜457ms、別の名前・anchor-scope で 0.1ms

#### ☰ のメニューの位置 (実アプリ、注入した CSS ごと)

メニューは `position: fixed` + `position-anchor: --tl-msg-menu` + `position-area: bottom span-left`。☰ をクリックして 5 フレーム後の矩形 (viewport の px)。

| ブラウザ / 状態 | 押した ☰ | 注入 | ☰ (top-bottom, right) | メニュー (top-bottom, right) |
|---|---|---|---|---|
| Chromium / B (☰ 788 個) | 401 番目 | なし | 493-513, 812 | 88,294-88,431, 807 (最後の ☰ の下) |
| Chromium / B | 401 番目 | anchor-scope | 493-513, 812 | 518-655, 812 |
| Chromium / B | 401 番目 | 開いた ☰ にだけ anchor-name | 493-513, 812 | 518-655, 812 |
| WebKit / A (☰ 55 個) | 11 番目 | なし | 542-561, 721 | 10,194-10,321, 724 (最後の ☰ の下) |
| WebKit / A | 11 番目 | anchor-scope | 542-561, 721 | 566-693, 721 |
| WebKit / A | 11 番目 | 開いた ☰ にだけ anchor-name | 542-561, 721 | 566-693, 721 |
| Chromium / B、☰ を画面の下端に置く | 31 番目 | anchor-scope / 開いた ☰ だけ | 879-899, 812 | 737-874, 812 (上に折り返し) |
| WebKit / A、☰ を画面の下端に置く | 31 番目 | anchor-scope / 開いた ☰ だけ | 879-898, 721 | 747-874, 721 (上に折り返し) |

- スクリーンショットでも、anchor-scope を入れるとメニューが押した ☰ の真下に出ること、入れないと画面内にメニューが無いことを確かめた
- 両エンジンとも `CSS.supports("anchor-scope: all")` は true (Chrome 157 headless、playwright の WebKit Version/27.2)

#### 実アプリで anchor-scope を入れた時の基準の表 (Chromium、5 回の中央値)

| 状態 | push (pair) | push (tool) | TL の外 settle (同期 layout) | TL の中の 1 か所 settle (同期 layout) | fold の開閉 |
|---|---|---|---|---|---|
| B | 234 (225-249) | 239 (217-409) | 33 (0.4) | 33 (21) | 52 (41-325) |
| C | 182 (171-184) | 178 (167-251) | 33 (0.7) | 38 (28) | (fold なし) |

- push に残る時間の内訳 (LoAF): script が B で 186ms、C で 144ms、描画の段が 20〜30ms。script は LoAF の invoker が `DOMWebSocket.onmessage` の 1 つだけで、強制 layout は 0ms

### WebKit: 入れ子の column flex と、行ごとの絶対配置の子

#### 実アプリへの CSS の注入 (状態 B、強制 layout、5 回の中央値、ms)

変更は 3 種類: footer (真ん中の吹き出しの時刻の文字を書き換える)、append (真ん中の行の複製を `.tl-lines` の末尾に足す / 外す)、text (真ん中の吹き出しの本文の文字を書き換える)。最初の表は text だけで測った。

| 注入した CSS | text | 全体の高さ |
|---|---|---|
| なし | 928 | 177,899 |
| `.tl-msg-menu-anchor{anchor-scope:--tl-msg-menu}` | 927 | 同じ |
| `.timeline-view{display:block}` | 157 | 同じ |
| `.timeline-view{display:grid}` | 313 | 同じ |
| `.timeline-view{contain:layout}` | 930 | 同じ |
| `.tl-lines{display:block}` | 2 | 168,171 (gap が消える) |
| `.tl-lines{display:grid}` | 5 | 同じ |
| `.tl-lines{flex:none}` | 929 | 同じ |
| `.tl-lines{min-height:0}` | 928 | 177,703 |
| `.tl-lines{contain:layout}` | 951 | 同じ |
| `.tl-lines > *{flex-shrink:0}` | 977 | 同じ |
| `.tl-item{display:block}` | 192 | 同じ (左右寄せが崩れる、下の見た目の比較) |
| `.tl-item{display:grid}` | 935 | 同じ |
| `.tl-item{contain:layout}` | 963 | 同じ |
| `.tl-item{min-height:0}` / `.tl-item > *{flex-shrink:0}` | 966 / 954 | 同じ |
| `.tl-bubble{display:block}` / `.tl-bubble{contain:layout}` | 956 / 952 | 同じ |

| 注入した CSS | footer | append | text |
|---|---|---|---|
| なし | 933〜985 | 972〜981 | 957〜971 |
| `.tl-lines{display:grid}` | 6 | 20 | 5 |
| `.timeline-view{contain:strict}` | 0 | 336 | 0 |
| `.timeline-view{contain:size layout}` | 0 | 328 | 0 |
| `.timeline-view{contain:size}` | 947 | 962 | 937 |
| `.timeline-view{flex:1 1 0}` | 489 | 492 | 483 |
| `.session-pane{display:block}` | 327 | 342 | 325 |
| `.session-panes{display:block}` | 493 | 496 | 481 |
| `.session-tab-panel{display:block}` | 654 | 667 | 654 |
| `.session-view{display:block}` | 645 | 662 | 648 |
| `.session-panes{align-items:flex-start}` | 651 | 648 | 633 |
| `.tl-item{position:static}` | 187 | 194 | 197 |
| `.tl-item-raw-toggle{display:none}` | 919 | 912 | 936 |
| `.tl-item-raw-toggle{position:static}` | 903 | 954 | 933 |
| 本文の中身を隠す (`pre` / `ul` / 表 / コピー用ボタン) | 939〜978 | 949〜974 | 941〜968 |

- 吹き出しの本文の `p` や `.md` を隠すと text は 0ms になるが、書き換える文字ノードが表示から外れるため。footer と append は 939〜951ms のままで、本文の中身は関係しない
- TL の上の祖先 (`.session-*`、`#app`、`#layout`) も column / row の flex で、どの段を block にしても 1.4〜3 倍下がる。段ごとに掛け算で効いている
- app.css の規則を CSSOM で消して測る二分探索 (footer の変更、3 回の中央値) で、消すだけで大きく下がる規則は `.tl-lines` (2ms)、`.tl-item` と `.tl-item-raw-toggle` (500ms 未満)、`#app` と `#layout` (750ms 未満) だった
- TL の行の中の positioned な要素 (状態 B): `.tl-item` (relative) 1,288、`.tl-item-raw-toggle` (absolute) 1,288、`.code-copy-btn` (absolute) 1,146、`.tl-msg-menu-anchor` (relative) 785、`.code-copy-frame` (relative) 1,146、`.tl-fold-guide` (relative) 744

#### 合成ページ (WebKit)

Chromium と同じ合成ページに、行 (`.item`、`position: relative`) ごとの絶対配置のボタン (`position: absolute; top: 0; right: 0`、行ごとの jsonl ボタンの代わり) と、スクロールの箱の外側を包む flex の段 (column / row を交互、`flex: 1 1 0; min-height: 0`) を足した。値は真ん中の行の文字の変更 + 強制 layout (5 回の中央値、ms)。

| 行 | 外側の flex の段 | 箱 / 行の並び / 行 | 絶対配置のボタン | ms |
|---|---|---|---|---|
| 2,000 | 0〜6 | flex / flex / flex | なし | 1〜2 |
| 2,000 | 0 | block / block / block | あり | 1 |
| 2,000 | 0 | block / flex / block | あり | 2 |
| 2,000 | 0 | flex / block / flex | あり | 1 |
| 2,000 | 0 | flex / flex / block | あり | 2 |
| 2,000 | 0 | block / flex / flex | あり | 142 |
| 500 | 0 | flex / flex / flex | あり | 19 |
| 1,000 | 0 | flex / flex / flex | あり | 67 |
| 2,000 | 0 | flex / flex / flex | あり | 262 |
| 4,000 | 0 | flex / flex / flex | あり | 1,077 |
| 2,000 | 1 / 2 / 3 / 4 / 6 | flex / flex / flex | あり | 295 / 472 / 509 / 549 / 628 |
| 2,000 | 0 / 6 | flex / **grid** / flex | あり | 3 / 3 |

- 重くなる条件は「column flex の並び (`.tl-lines`) の子 (行) がそれ自体 flex の箱で、その中に絶対配置の子孫がある」こと。どれか 1 つが欠けると 1〜2ms。重さは行の数の 2 乗で伸び (500 → 4,000 行で 19 → 1,077ms、2 倍ごとに約 4 倍)、外側の flex の段が増えるほど掛け算で増える
- 並びを grid にすると、行と外側の段の数に関係なく 3ms
- 同じ名前の anchor-name は WebKit の重さに効かない (実アプリでも anchor-scope で 927ms のまま、合成ページでも 2ms)
- WebKit の中で何が 2 乗になっているか (絶対配置の箱の layout を行ごとにやり直しているのか等) はエンジンの中を見ていないので未特定

#### 見た目の比較 (WebKit、状態 B)

注入の前後で、TL の行・吹き出し・本文・足元・summary・`pre`・表の矩形 (TL の箱の中の座標、6,559 個) と、TL の箱の先頭・真ん中・末尾のスクリーンショット (1280×900) の画素を比べた。何も注入しない 2 回 (対照) でも、相対時刻の表示 (「13d10h」等) が変わった足元の幅と、サイドバーの経過時間の画素が違うことがある。

| 注入した CSS | 矩形の差 | 画素の差 (先頭 / 真ん中 / 末尾) |
|---|---|---|
| なし (対照) | 10 (足元の幅が 7px、相対時刻の文字) | 0 / 0 / 0 |
| `.tl-lines{display:grid}` | 0 | 0 / 0 / 0 |
| `.tl-msg-menu-anchor{anchor-scope:--tl-msg-menu}` | 0 | 0 / 0 / 225 (サイドバーの経過時間の位置) |
| `.timeline-view{contain:strict}` | 0 | 1,790 / 1,429 / 1,429 (右端のパネルの取っ手と、TL の上部が変わる) |
| `.tl-item{display:block}` | 1,369 (吹き出しの左右寄せが崩れる) | 46,860 / 27,001 / 212 |
