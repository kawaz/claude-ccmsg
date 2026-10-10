# iPhone Safari で webui が真っ黒になる件の調査 (Navigation API 欠如)

- Date: 2026-10-10

## 判明した事実

- 現象: ccmsg v0.158.0 の webui を iPhone の Safari で開くと、読み込み中のような真っ黒のまま止まる。iPad では正常に表示される
- `window.navigation` を undefined にした WebKit 模擬で、実機と同じ「ダーク背景のみ」の状態を再現できた。`TypeError: undefined is not an object (evaluating 'window.navigation.addEventListener')` が出て、`#app-root` の子は 0
- `packages/webui/src/client/navigation.ts:277` が `window.navigation.addEventListener("navigate", …)` を無条件に呼ぶ。`main.tsx:23` でのこの呼び出しは、WS 接続 (24 行) と初回 render (76 行) より前に実行される。Navigation API が無い Safari では描画前に停止する
- caniuse (https://caniuse.com/mdn-api_navigation) によると iOS Safari は 26.1 以下が非対応、26.2 以降が対応
- 同じ無条件依存は v0.157.0 にもある (7/28 の URL 実パス化で導入)。v0.157 から v0.158 の webui 差分 23 ファイルのうち `main.tsx` / `navigation.ts` / `app.css` は同一。v0.158 固有の退行ではない
- 有力候補は iPhone と iPad の iOS 版の差 (iPhone が 26.2 未満)。実機の版は未確認で、確定していない
- CSS 相対色 (iOS 18 から) は表示に影響しうるが、起動前停止の原因ではない。WS だけの失敗なら初回描画後のヘッダは残る
- tailnet proxy 経路は URL が不明で未検証

## 実用的な示唆 / ベストプラクティス

直し方の候補は 2 つ。

- (a) Navigation API 非対応を対象外とし、対応要件 (iOS Safari 26.2+) を DESIGN に明記する。bundle 起動前の固定 HTML で、非対応時に見える案内を出す
- (b) 旧 Safari を対象にするなら、History API へのフォールバックを含めて navigation 層 (navigate / back / forward) を丸ごと代替設計する。`addEventListener` だけ guard しても他の `window.navigation` 参照が残るので無意味

残る切り分け (実機で行う):

- iPhone / iPad の iOS・Safari 版と URL
- iPhone の Safari リモートインスペクタで最初の console エラー
- JS / CSS の取得 status
- `#app-root` の子数

空で上記 TypeError なら Navigation API 欠如と確定する。

## 検証の詳細

### 端末・エンジン別の表示確認

ローカル daemon v0.158.0 に直結し、playwright で確認した。

| 条件 | 表示・DOM | console / 通信 |
|---|---|---|
| WebKit 26.6・iPhone 15 記述 (393×659、DPR 3) | 描画され connected | エラー・失敗リクエスト無し。HTML/CSS/JS 200、WS hello 送信 |
| WebKit 26.6・iPad Pro 11 記述 (834×1194、DPR 2)、393px に縮めても | 同上 | 同上、hello 成功応答 |
| デスクトップ Chromium 1280×720 | 同上 | 同上 |
| WebKit iPhone 15 で `window.navigation` を undefined にした模擬 | `#app-root` の子 0、本文空、ダーク背景 rgb(22,24,29) のみ | `TypeError: undefined is not an object (evaluating 'window.navigation.addEventListener')`、資産は 200、WS 接続無し |

考察: デバイス記述の UA の iOS 版は実エンジン版ではない (WebKit 26.6 共通)。古い実機 Safari の再現ではなく、`window.navigation` 欠如という条件だけを模擬した結果である。資産取得が 200 で WS 接続が無いことは、実行順 (navigation 初期化が WS 接続より前) と整合する。
