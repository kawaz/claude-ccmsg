---
title: "plugin の更新の直後、依存の入れ込みの途中で呼ばれた CLI が Cannot find package で落ちる"
status: resolved
category: bug
created: 2026-11-25
origin: "他プロジェクトからの共有 (定期実行で ccmsg を呼ぶ利用側)"
close_reason: implemented
---

# plugin の更新の直後、依存の入れ込みの途中で呼ばれた CLI が Cannot find package で落ちる

## 観測 (利用側からの共有、2026-11-25)

- 15:15 ごろ、launchd の定期実行 (15 分おき) が呼んだ `ccmsg agents` が 1 回失敗した
- その回の stderr の末尾: `error: Cannot find package 'hono' from '<config dir>/plugins/cache/ccmsg-v1/ccmsg-v1/0.414.0/packages/webui/src/index.ts'` (Bun v1.4.4、macOS arm64)
- 15:16 に手で `ccmsg agents` を実行すると成功した。同じ分に終わった次の定期実行も成功した
- plugin の cache の `0.414.0` のディレクトリの更新時刻は 15:15:51 (このリポの側で確認)。v0.414.0 の push の後処理 (plugin の更新と、新しい版の CLI で daemon に 1 回触る `_local-daemon-upgrade`) が走った時刻と重なる

## 原因の見立て (コードの読み。同時実行での再現は未了)

`bin/ccmsg` の `__ccmsg_ensure_deps` は、`node_modules` のディレクトリが在れば入れ込み済みと見なしてすぐ戻る。別のプロセスが `bun install` を実行している途中 (`node_modules` は作られたが、中身がまだ揃っていない間) に呼ばれた CLI は、入れ込みを待たずにそのまま走り、まだ無いパッケージの解決で落ちる。

`claude plugin update` は cache に版のディレクトリを作るだけで依存を入れないので、新しい版を最初に呼んだプロセスが `bun install` を始める。push の後処理・セッションの hooks・定期実行のどれが最初になるかは決まっておらず、その入れ込みの間に呼ばれた 2 番目以降が当たる。

## 特定に要る観測

- 依存の無い版のディレクトリの写しに対して、`bin/ccmsg` を 2 つ続けて起動した時に、2 つ目が同じ形で落ちるか (入れ込みにかかる時間と、落ちる窓の長さ)
- `bun install` を同じディレクトリで 2 つ同時に走らせた時の振る舞い (2 つ目が待つか、壊すか)

## 利用側の対処

していない (1 回で戻ったため)。

## 再現 (2026-11-25、macOS arm64、Bun 1.4.4)

リポの外の一時ディレクトリに、版のディレクトリと同じ中身 (依存なし) の写しを作り、1 回ごとに作り直して測った。CLI は隔離の環境変数 (`CCMSG_STATE_DIR` / `CCMSG_CONFIG_DIR` / `CCMSG_DATA_DIR` / `CCMSG_CLAUDE_CONFIG_DIRS` / `CLAUDE_CONFIG_DIR` を一時ディレクトリに、`CCMSG_HTTP_BIND=off`) を付けて起動した。bun の global cache は温まった状態。

### 入れ込みにかかる時間

- 写しで最初の `bin/ccmsg --version` (入れ込みを含む): 0.62〜0.70 秒 (3 回)。依存が入った後は約 0.1 秒
- 写しでの `bun install --frozen-lockfile` 単体: 0.38 秒

### 2 つ目以降の launcher が落ちるか

1 つ目の launcher を起動し、決めた時間の後に残りを起動した。`--version` も `--help` も、CLI の入口が `@ccmsg/daemon/run` → `@ccmsg/webui` → `hono` を静的に import するので、daemon に触らずに同じ解決を通る。

| 起動 | 2 つ目以降を起動するまで | 落ちた数 / 起動の数 |
|---|---|---|
| `--version` を 2 つ | 0 / 20 / 50 / 100 / 200 / 300 / 400 / 600 / 900 ms | 4/10、5/10、5/10、4/10、5/10、5/10、1/10、0/10、0/10 |
| `--version` を 5 つ | 0 / 50 / 150 / 300 / 450 ms | 11/20、7/20、8/20、16/20、4/20 |
| `--help` を 3 つ | 0 / 100 / 250 ms | 7/12、6/12、8/12 |

- stderr は issue と同じ形: `Cannot find package 'hono' from '<root>/packages/webui/src/index.ts'`、`Cannot find package 'valibot' from '<root>/packages/daemon/src/session-dump.ts'`、`Cannot find module '@ccmsg/daemon/test-lifeline'`
- 落ちる窓は入れ込みの時間とほぼ同じ (400 ms まで落ち、600 ms 以降は落ちない)
- 50 ms 以内に重なると、1 つ目の launcher も落ちることがあった (2 つ目が `node_modules` の出来る前に来て、2 つの `bun install` が重なる)

### `bun install` を同じディレクトリで同時に走らせた時

- 2 つを同時 (0 ms) に起動: 8 回中 4 回で片方が `EEXIST: File or folder exists: failed to create './node_modules/.bun' (mkdir)` で exit 1。50 / 150 / 300 ms ずらすと両方 exit 0 (各 8 回)。両方が終わった後の tree は 32 回とも CLI が動いた
- 2 つ目は 1 つ目を待たない: 2 つ目が終わった時に 1 つ目がまだ走っていたのは、ずらし 20 ms で 8/8、50 ms で 8/8、100 ms で 3/8、200 ms で 4/8、300 ms で 2/8。2 つ目が終わった直後の CLI は 20 ms ずらしで 8 回中 1 回 `Cannot find package 'hono'` で落ちた
- bun は同じディレクトリの入れ込みを排他しない。「2 つ目も `bun install` を呼ぶ」だけでは塞がらない

### 入れ込みが途中で殺された後

`bun install` を 30〜420 ms で SIGKILL し、もう一度 `bun install --frozen-lockfile` を流した。

- CLI を確かめた 20 回: 殺した直後は 14 回落ち、流し直した後は 20 回とも動いた
- tree を全部入れたものと比べた 14 回: package の中身 (ファイルとサイズ) は 14 回とも一致し、store の中の入れ子の `.bin` の link が 0〜22 個欠けることがあった (実行時には使わない)

### daemon への波及

1 つ目に `--version`、決めた時間の後に `peers` (隔離の state dir と HTTP の port で、daemon を起こす) を起動した 15 回: `peers` が `Cannot find package` で落ちたのが 9 回、通ったのが 6 回。通った 6 回のうち 1 回は、起きた daemon が webui の build に失敗し (`http: the fallback's prepare failed ...: Could not resolve: "hast-util-to-mdast"`)、入れ込みが済んだ後も `GET /` が 500 を返した。push の後処理の `_local-daemon-upgrade` が新しい版の CLI で daemon を起こす経路も、この窓に当たれば同じになる。

## 原因

1. `bin/ccmsg` の `__ccmsg_ensure_deps` は `node_modules` のディレクトリが在れば入れ込み済みと見なした
2. bun は入れ込みの始めに `node_modules` を作り、中身はその後に揃う。bun は入れ込みが済んだことを示すものを何も残さない
3. bun は `node_modules` が在ると auto-install をしない (依存の無い写しでは `node_modules` が無い間は CLI が auto-install で動き、空の `node_modules` を置くと `Cannot find module` で落ちる)。途中の `node_modules` で走った CLI は、まだ無いパッケージの解決で落ちる
4. `bun install` は同じディレクトリでの同時実行を排他しないので、`node_modules` の出来る前に重なった呼び出しは入れ込みを 2 つ走らせ、片方が `EEXIST` で落ちたり、先に終わった方の直後の tree が欠けたりする

## 直した内容

- 「済んだ」を、入れ込みが成功した時に launcher が置く印 `node_modules/.ccmsg-deps-installed` で判定する。印が在れば 1 回の確認だけで戻る
- 印が無ければ、`bun.lock` を開いた fd に flock(2) の排他を取り (Linux は `flock(1)`、macOS は `lockf(1)`)、印をもう一度見て、無ければ `bun install --frozen-lockfile` を流し、成功したら印を置く。待つ側は排他が空くのを待つので、途中の状態で CLI を走らせない
- 入れ込みが失敗した時や殺された時は印が残らず、次の呼び出しが入れ直す。排他は fd を持つ最後の process が終わると kernel が外す
- 決まりは DR-0032 §2.2-4 に書いた

直した後の同じ測定:

| 起動 | 2 つ目以降を起動するまで | 落ちた数 / 起動の数 |
|---|---|---|
| `--version` を 2 つ | 0 / 20 / 50 / 100 / 200 / 300 / 400 / 600 / 900 ms | 全部 0/10 |
| `--version` を 5 つ | 0 / 50 / 150 / 300 / 450 ms | 全部 0/20 |
| `--help` を 3 つ | 0 / 100 / 250 ms | 全部 0/12 |

- daemon への波及の測定 15 回: `--version` も `peers` も全部成功し、起きた daemon は全部 `GET /` に 200 を返した
- launcher を入れ込みの途中で殺した後 (launcher と `bun install` を一緒に殺した 4 回、launcher だけを殺した 4 回。うち 3 回は `bun install` が残って走っていた): 次の呼び出しは 8 回とも成功し、印が置かれた (0.30〜0.68 秒)
- 依存が入っている普段の `bin/ccmsg --version` (hyperfine 30 回): 直す前 76.9 ± 8.9 ms、直した後 70.8 ± 2.6 ms。`__ccmsg_ensure_deps` だけを 2000 回呼んだ時間は前後とも 0.05 秒

### 他の経路

- hooks の module (`hooks/register.bundle.js`) は import / require を持たない bundle で、cache の依存に頼らない。hooks が CLI を呼ぶ所 (sidecar の起動、`version`、`permit`) は plugin root の `bin/ccmsg` を通るので、launcher の直しで塞がる
- daemon は CLI が自分の entry (`<bun> <cli の index.ts> daemon run`) で起こすので、launcher を通った後にしか起きない
