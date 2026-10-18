# sun_path を超える長さの UNIX socket の path を Bun はそのまま bind / connect できる

- Date: 2026-10-18
- 対象: Bun 1.4.2、Node v26.11.1、Python 3 (比較用)。macOS (Darwin 25.5.0 arm64)
- 目的: サイドカーの socket (`<state dir>/sidecars/<sid>.<run id>.sock`) の path が `sun_path` (macOS 104 バイト) を超える時に、置き場を `/tmp` の下へ逃がす必要があるかを確かめる (DR-0035 §3)
- 方法: 一時ディレクトリの下に 60 文字と 40 文字のディレクトリを重ね、232 バイトの絶対 path の socket を、各 runtime の API で listen し、同じ絶対 path に connect して 1 行を書き、受け取れるかを見た。cwd は変えていない

## 結論

- Bun と Node は、`sun_path` を超える絶対 path の socket を listen / connect できる。listen の前後で process の cwd は変わらない。Bun の listen した socket は、stop で消える
- OS の bind そのもの (Python の `socket.bind`) は `AF_UNIX path too long` で失敗する。長い path を通しているのは runtime の側
- ccmsg の daemon とサイドカーはどちらも Bun で動くので、サイドカーの socket を state dir の下の 1 か所に置いたまま、長さで置き場を変えずに済む。daemon の connect (`writeSocket`、`Bun.connect`) も同じ path のまま届く
- Bun の binary は `__pthread_fchdir` を import している (`nm -u`)。長い path は、そのディレクトリを thread の cwd にして相対の名前で bind / connect していると推定する (未検証: 実行中の syscall は見ていない)

## マトリクス

| runtime / API | listen (232 バイト) | connect (232 バイト) | 1 行の受け渡し |
|---|---|---|---|
| Bun 1.4.2 `Bun.listen` / `Bun.connect` | 通る | 通る | 届く |
| Bun 1.4.2 `node:net` (`createServer().listen` / `createConnection`) | 通る | 通る | 届く |
| Node v26.11.1 `node:net` | 通る | 通る | 届く |
| Python 3 `socket.bind` | `AF_UNIX path too long` | — | — |

## 確かめていないこと

- Linux (`sun_path` 108 バイト) での振る舞い。`packages/cli/test/sidecar.test.ts` の「a socket path longer than sun_path is bound, written to and removed」が CI の ubuntu で同じことを確かめる
