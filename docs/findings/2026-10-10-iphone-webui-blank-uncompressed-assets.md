# iPhone で webui が真っ黒になる件の調査 (資産が無圧縮で、遅い経路では JS の転送が完走しない)

- Date: 2026-10-10

## 判明した事実

- 現象: ccmsg v0.158.0 の webui を iPhone の Safari で tailnet 経由 (caddy の `ccmsg.kawaz-mbp16-20211217.kawaz.jp` → `127.0.0.1:8642`) で開くと、真っ黒のまま止まる。iPad は同じ経路で正常に表示される
- caddy の access log で、iPhone (`100.104.30.107`) からの `/assets/app.d6e1b6c37a5997ac.js` (`Content-Length: 1473461`) の取得は 2026-10-10 に 9 回あり、すべて途中で切れている (受け取った byte は 2,392〜511,138)。完走は 0 回
- `/app.css` (`Content-Length: 297480`) は 8 回のうち 1 回だけ完走した (15:34:36、caddy の duration 28.7 秒、約 10 KB/s)
- iPhone からの `/ws` (101) は 0 件。JS が最後まで届かず、実行に至っていない
- 応答に `Content-Encoding` は無い。daemon は `Accept-Encoding` に関わらず無圧縮で返す (curl で `gzip` / `br` / 無しのどれでも 1,473,461 byte)。同じ JS を `gzip -9` にすると 313,045 byte。caddy の設定 (autosave.json) に `encode` handler は無く、proxy も圧縮しない
- iPad (`100.84.237.16`) は同じ caddy 経路で 07:59 に `/app.css` 297,480 byte を 0.1 秒で受け取り、08:10 と 20:54 に `/ws` 101 を張っている。JS の取得は当日の log に無い (immutable でキャッシュ済みと見られる。未検証)
- Mac (`100.76.5.89`、caddy が動いているマシン自身) は 13:27 から `/ws` 101 を約 12.7 時間保っている
- iPhone の iOS は 26.7.1 (link preview 取得の UA `NetworkingExtension/... iOS/26.7.1`)。Safari の UA は `iPhone OS 18_7 ... Version/26.6.2 Mobile/15E148 Safari/604.1`
- 経路が遅い理由 (tailnet の relay 経由か、回線か) と、転送が切れた理由 (Safari 側の打ち切りか経路の切断か) は log から判別できず、未確定

## 当初の仮説 (Navigation API 欠如) について

ローカル WebKit で `window.navigation` の欠如を模擬すれば同じ見た目 (ダーク背景のみ、`#app-root` が空) になる。しかし実機は iOS 26.7.1 で Navigation API に対応済み (iOS Safari 26.2 以降) なので、無関係だった。

## 実用的な示唆 / ベストプラクティス

- 遅い経路では「JS が届かない」と「JS が途中で落ちた」が同じ真っ黒に見える。切り分けは caddy の access log で `size` と `Content-Length` を比べ、`/ws` の 101 の有無を見るのが早い
- daemon が webui の資産 (JS / CSS / HTML) を br / gzip で返すようにした (`packages/webui/src/encoded-asset.ts`)。資産を読み込む時に一度だけ圧縮し、リクエストは `Accept-Encoding` で出来上がった本文を選ぶだけ。JS は 1,483,352 → br 251,007 byte (約 1/6)
- ただし観測した iPhone の速度 (1〜10 KB/s) では br でも 251 KB に数十秒かかる。圧縮後に iPhone で完走するかは未確認。足りなければ次はバンドル自体を削る (下記の内訳で約半分が shiki の言語文法)

## 検証の詳細

### access log (iPhone、`/assets/*` と `/app.css`)

取り出し方 (`~/Library/Logs/canddy/`):

```sh
gzcat access-2026-10-10T*.gz | jq -r 'select(.request.host=="ccmsg.kawaz-mbp16-20211217.kawaz.jp" and .request.remote_ip=="100.104.30.107" and (.request.uri|test("^/assets/|^/app.css"))) | (.resp_headers.Date[0] | strptime("%a, %d %b %Y %H:%M:%S GMT") | mktime) as $d | [(.ts|strflocaltime("%H:%M:%S")), .request.remote_ip, .request.proto, .request.uri, .status, .size, .resp_headers["Content-Length"][0], (.ts - $d | floor), .duration] | @tsv'
```

経過秒は応答の `Date` (応答開始、1 秒単位) から log の時刻までの差。途中で切れた HTTP/3 の転送は caddy の `duration` が 0 になるので、その代わりに使う。

| 時刻 (JST) | remote_ip | proto | uri | status | 受け取った byte | Content-Length | 経過秒 |
|---|---|---|---|---|---|---|---|
| 09:13:58 | 100.104.30.107 | HTTP/3.0 | `/assets/app.d6e1b6c37a5997ac.js` | 200 | 22,602 | 1,473,461 | 10 |
| 09:13:58 | 100.104.30.107 | HTTP/3.0 | `/app.css` | 200 | 23,965 | 297,480 | 10 |
| 11:32:35 | 100.104.30.107 | HTTP/3.0 | `/assets/app.d6e1b6c37a5997ac.js` | 200 | 53,593 | 1,473,461 | 42 |
| 11:32:35 | 100.104.30.107 | HTTP/3.0 | `/app.css` | 200 | 63,127 | 297,480 | 42 |
| 11:32:37 | 100.104.30.107 | HTTP/3.0 | `/assets/app.d6e1b6c37a5997ac.js` | 200 | 28,603 | 1,473,461 | 36 |
| 11:33:33 | 100.104.30.107 | HTTP/3.0 | `/assets/app.d6e1b6c37a5997ac.js` | 200 | 6,348 | 1,473,461 | 25 |
| 11:34:19 | 100.104.30.107 | HTTP/3.0 | `/app.css` | 200 | 26,229 | 297,480 | 138 |
| 11:45:48 | 100.104.30.107 | HTTP/3.0 | `/app.css` | 200 | 39,324 | 297,480 | 5 |
| 11:45:48 | 100.104.30.107 | HTTP/3.0 | `/assets/app.d6e1b6c37a5997ac.js` | 200 | 43,582 | 1,473,461 | 5 |
| 14:36:51 | 100.104.30.107 | HTTP/3.0 | `/assets/app.d6e1b6c37a5997ac.js` | 200 | 3,917 | 1,473,461 | 10 |
| 14:36:51 | 100.104.30.107 | HTTP/3.0 | `/app.css` | 200 | 13,694 | 297,480 | 10 |
| 14:37:09 | 100.104.30.107 | HTTP/3.0 | `/assets/app.d6e1b6c37a5997ac.js` | 200 | 2,392 | 1,473,461 | 10 |
| 14:44:16 | 100.104.30.107 | HTTP/3.0 | `/app.css` | 200 | 19,965 | 297,480 | 423 |
| 14:44:16 | 100.104.30.107 | HTTP/3.0 | `/app.css` | 200 | 14,016 | 297,480 | 437 |
| 14:44:16 | 100.104.30.107 | HTTP/3.0 | `/assets/app.d6e1b6c37a5997ac.js` | 200 | 16,073 | 1,473,461 | 423 |
| 15:34:36 | 100.104.30.107 | HTTP/3.0 | `/app.css` | 200 | **297,480 (完走)** | 297,480 | 29 (duration 28.7) |
| 15:35:33 | 100.104.30.107 | HTTP/3.0 | `/assets/app.d6e1b6c37a5997ac.js` | 200 | 511,138 | 1,473,461 | 86 |

これらの行の `Accept-Encoding` はすべて `gzip, deflate, br, zstd`、応答に `Content-Encoding` は無い。

### 端末ごとの比較 (同じ caddy 経路、2026-10-10)

端末と IP の対応は `tailscale status` で確認した。

| 端末 | remote_ip | UA | 資産 | `/ws` 101 |
|---|---|---|---|---|
| iPhone | 100.104.30.107 | `iPhone OS 18_7 ... Version/26.6.2 Mobile/15E148 Safari/604.1` | JS 0/9 完走、CSS 1/8 完走 | 0 件 |
| iPad | 100.84.237.16 | `Macintosh; Intel Mac OS X 10_15_7 ... Version/26.6.2 Safari/605.1.15` (iPadOS のデスクトップ UA) | CSS 297,480 byte を 0.1 秒、JS はリクエスト無し | 08:10 (692.9 秒)、20:54 (322.8 秒) |
| Mac | 100.76.5.89 | `Macintosh; ... Chrome/156.0.0.0` | リクエスト無し | 13:27 (45,616 秒) |

### 圧縮配信後の応答 (隔離 daemon、curl)

| path | Accept-Encoding | Content-Encoding | Content-Length |
|---|---|---|---|
| `/assets/app.<hash>.js` | 無し | 無し | 1,483,352 |
| `/assets/app.<hash>.js` | `gzip` | gzip | 316,202 |
| `/assets/app.<hash>.js` | `br` / `gzip, deflate, br, zstd` | br | 251,007 |
| `/app.css` | 無し | 無し | 297,480 |
| `/app.css` | `gzip` | gzip | 84,374 |
| `/app.css` | `br` | br | 67,145 |
| `/` (shell) | 無し / `gzip` / `br` | 無し / gzip / br | 873 / 618 / 458 |

どの応答にも `Vary: accept-encoding` が付き、`/assets/*` の `Cache-Control: public, max-age=31536000, immutable` は coding によらず変わらない。shell の ETag は coding ごとに別の値 (`"<sha256>"` / `"<sha256>-gzip"` / `"<sha256>-br"`) で、同じ coding の ETag だけが 304 になる。ブラウザでは、Chromium (headless、http://127.0.0.1) で JS が br (encoded 251,007 / decoded 1,483,352) で届いて描画され `connected` になる。Playwright の WebKit (iPhone 15 記述) は http で br を求めず gzip (316,202) で届き、同じく描画される。

### バンドルの内訳 (Bun.build の metafile、minify 後の bytesInOutput)

| package | byte | 割合 |
|---|---|---|
| `@shikijs/langs` (15 言語) | 714,861 | 48.2% |
| webui の `src/client` (125 ファイル) | 414,535 | 27.9% |
| `@shikijs/vscode-textmate` | 43,445 | 2.9% |
| `micromark-core-commonmark` | 33,998 | 2.3% |
| `@ccmsg/protocol` | 28,020 | 1.9% |

ファイル単位では shiki の `tsx.mjs` 175,520 と `javascript.mjs` 174,811 が最大で、次が `python.mjs` 70,085、`Timeline.tsx` 62,722、`markdown.mjs` 59,314。
