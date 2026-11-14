# TL の基礎コスト (検索と関係しない 1 操作ごとの重さ)

issue `2026-11-05-timeline-push-cost-after-older` と findings `2026-11-12-in-view-search-range-cost` の「TL の基準の重さ」の続き。TL の行が増えた時に、push・TL の外の DOM 変更・TL の中の 1 か所の変更がそれぞれどれだけかかるかを 3 つの状態で測り、原因を CSS の注入で切り分ける。

## 判明した事実

- 普通に開いた直後 (状態 A、要素約 3,300) はどの操作も 1〜3 フレームで終わる。重いのは過去分を読み切った状態 (B) と本文が全部 mount された状態 (C)
- 普段の形のセッションを読み切った状態 B (要素約 4.7 万、吹き出し 1,035、fold 741) は C (要素約 3 万) より重い。Chromium で push 1 回 3.7〜5.6 秒、TL の中の文字 1 か所の変更 + 強制 layout が約 3.5 秒、TL の外の DOM 変更で約 330ms。WebKit で push 約 1.2 秒、TL の中の 1 か所の変更が約 1 秒、TL の外の変更は 16ms (2 フレーム未満)
- Chromium では、どの状態でも push の時間のほとんどが描画の段 (LoAF の renderStart 以降) で、script は 150〜210ms

## 実用的な示唆 / ベストプラクティス

(区切りごとに書き足す)

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
