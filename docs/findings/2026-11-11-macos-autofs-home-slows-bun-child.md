# macOS の autofs 配下を HOME にした bun の子プロセスが遅い

## 判明した事実

- GitHub Actions の `ci (macos-latest)` で、`packages/cli/test/agents.test.ts` の describe「ccmsg agents (daemon の偽応答に対する出力)」の 3〜4 件が「this test timed out after 5000ms」(子の終了コード 143) で落ち続けた。このテストが入った commit 302a796e (2026-10-28) 以降、macOS で全部通った run は ci.yml の 100 本中 6 本。ubuntu では 70 run の最大が 172ms
- 原因: このテストは子の CLI に `HOME=/home/someone` を渡していた。macOS の `/home` は autofs (`/etc/auto_master` の `/home auto_home`)。bun は `XDG_CACHE_HOME` が無い時、runtime transpiler cache を `$HOME/Library/Caches/bun/@t@/` に置こうとし、読み込む module (98 個) ごとに autofs の下への書き込みを試みて待たされる。CLI の起動 1 回が 1.5〜2.7 秒になり、CLI を 2 回起こすテストが 5 秒を越える
- 同じ run の `cli.test.ts` は同じ `runCli` (packages/cli/test/run-cli.ts) で同じ CLI を起こすが HOME を変えないので 40ms で終わる
- 期限 5000ms は落ちる線を決めているだけで遅さの原因ではない
- 直し方: 子に渡す HOME を、OS が特別扱いしない実在する一時 dir (`perTestTmpDir()`) にした。daemon の偽応答の行 (cwd / config_dir) は同じ HOME から組み、テストの保証は変えていない
- 直した版 (v0.246.0、run 43023307090) の `ci (macos-latest)` は通り、同じ 4 件は 90 / 164 / 190 / 139ms だった (直す前の通った run は 1710〜3657ms)。GitHub の macOS runner でも偽 HOME が遅さの元だった
- 未確認: GitHub の macOS runner に `XDG_CACHE_HOME` が無いこと・`/home` が autofs であることは runner 上では直接見ていない (HOME を替えたら速くなったことから、そう推せるだけ)

## 実用的な示唆 / ベストプラクティス

- テストで子プロセスに偽の HOME を渡す時は、OS が特別扱いしない実在する一時 dir を使う。`/home/...` や存在しない `/Users/<名前>` のような値は、macOS で autofs などの特別な扱いを受けうる
- `XDG_CACHE_HOME` や `BUN_RUNTIME_TRANSPILER_CACHE_PATH` を子に渡して遅さだけを消す形にはしない。偽 HOME が autofs の下に残る
- 子に渡さず文字列として使うだけ (`agentsTable(rows, HOME)` のような関数の引数、期待値の組み立て) の HOME は実在しなくてよい
- 手元の `just test` が通るのは `XDG_CACHE_HOME` が設定されているため。再現するには `env -u XDG_CACHE_HOME` で走らせる

## 検証の詳細

### `bun packages/cli/src/index.ts --help` の所要 (macOS、bun 1.4.2)

| `XDG_CACHE_HOME` | `HOME` | 他 | 所要 |
|---|---|---|---|
| 無し | `/home/someone` | | 1933ms (調査では 1490〜2678ms) |
| 無し | 実在する一時 dir | | 78ms (調査では 55〜62ms) |
| 無し | `/nonexistent-zz` (autofs でない、存在しない) | | 59〜68ms |
| 無し | `/home/someone` | `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0` | 53〜61ms |
| あり | `/home/someone` | | 67ms |

### `agents.test.ts` の各テストの所要 (`env -u XDG_CACHE_HOME ... bun test`、秒)

| テスト | 直す前 | 直した後 |
|---|---|---|
| 既定は daemon の応答をそのまま 1 行の JSON で出す | 1.58 | 0.063 |
| `--format text` は表を出す | 3.22 | 0.106 |
| daemon が断ったら stderr に出して exit 1 | 3.15 | 0.105 |
| `--format` の誤りや余計な引数は usage を出して exit 1 | 3.10 | 0.099 |
| 単体テスト 3 件 (`agentsTable`) | 0.001 未満 | 0.001 未満 |

ファイル全体は 10.8〜11.1 秒から 0.41 秒になった。

### ほかのテストの偽 HOME

- `packages/daemon/test/session-launch.test.ts` の `HOME: "/home"` は `buildLaunchEnv` に渡す env の文字列で、子プロセスの env ではない
- `packages/cli/test/cli.test.ts`、`path-launcher.test.ts`、`packages/daemon/test/agents.test.ts`、`virtual-sessions.test.ts` は HOME に実在する一時 dir を渡している
- そのほかの `/home/...` は文字列として使うだけ
