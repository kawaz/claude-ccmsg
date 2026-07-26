# macOS の Gatekeeper 評価は inode 単位で、高負荷時に初回 exec を数分ブロックする

## 判明した事実

- macOS は **新規に作られた inode の初回 exec** を、syspolicyd / XProtect の評価が
  終わるまで同期的にブロックする。高負荷時にこの評価が **100 秒〜173 秒** かかる
  ことを実測した (load average 46-74、`syspolicyd` は CPU 33-48% で常時稼働)。
- 評価結果のキャッシュ単位は **inode**。パスでも内容でもない。裏付け:
  - 同一 inode の内容を in-place で 8 回書き換えても、全て 15-18ms (再評価なし)
  - 同じパスで unlink → 再作成 (= 新 inode) すると 405-726ms に戻る
  - 既評価 inode への hardlink 経由の exec は 12-23ms
- **インタープリタにデータファイルとして渡す経路は評価対象外**。新規作成した
  スクリプトでも `/bin/sh <file>` なら 16-17ms で、exec される inode は
  `/bin/sh` 自身 (既に warm) だから。
- `$0` は「インタープリタに渡したファイルのパス」から決まる。`exec -a` で
  argv[0] を変えても `sh file` の `$0` は変わらない (実測)。

### 実測値 (load average 46-74)

| ケース | 所要 |
|---|---|
| 新規 inode の初回 exec (最悪) | 173,270 ms |
| 新規 inode の初回 exec | 102,889 ms / 140,981 ms |
| 新規 inode (評価器 warm 後) | 409 - 1,036 ms |
| テスト毎に新規スクリプト作成 (旧方式) | 574 - 726 ms |
| **既評価 inode への hardlink** | **12 - 23 ms** |
| **warm inode の in-place 書き換え** | **15 - 18 ms** |
| **`/bin/sh <新規データファイル>`** | **16 - 17 ms** |

## 実用的な示唆

- **テストが mock 実行ファイルを都度生成する構成は macOS で構造的に脆い**。
  ケース毎に評価コストを払い、高負荷時はテストの timeout を超える。
  timeout を伸ばしても解決しない (評価は数分に達しうる)。
- 対策は **リポにコミットした 1 個の実行ファイルへ hardlink** し、挙動の差分は
  exec されない sidecar ファイルへ逃がすこと。実装は
  `packages/testkit/src/mock-bin.ts` の `writeMockBin`。
- 初回の 1 回だけは評価が走る。これが最初のテストの timeout に当たらないよう、
  `just test` は `packages/testkit/src/warm.ts` で **テストの外に追い出している**。
- Linux には Gatekeeper が無いので、この機構は単に無害な間接参照として動く。

## 検証の詳細

### 対策前後 (同一マシン・同一テスト)

`bin/ccmsg.test.ts` + `packages/testkit/` (mock を exec するテスト群):

| | 所要 | 結果 |
|---|---|---|
| 対策前 (load ~35) | 82.12 s | **1 fail** (`timed out after 30000ms`) |
| 対策後 (load ~35) | 1.09 s | 21 pass / 0 fail |

初回 warm-up のコスト分離 (shim の inode をわざと作り直して cold 状態を再現):

```
warmed test executables in 34.6s (shim 34488ms, launcher 103ms)
→ 直後のテスト: 21 pass / 0 fail [914ms]
```

### フルスイート (`just test`、外部 CPU 負荷を追加して実施)

| run | 開始時 load | 結果 | 所要 |
|---|---|---|---|
| 1 | 72 | 1862 pass / 0 fail | 89.33 s |
| 2 | 144 | 1862 pass / 0 fail | 91.36 s |
| 3 | 175 | 1862 pass / 0 fail | 95.05 s |
| 最終 (負荷停止後) | 88 | 1862 pass / 0 fail | 62.34 s |

load が 72 → 175 と 2.4 倍になっても所要が 89s → 95s しか伸びない点が重要で、
**負荷感受性そのものが消えている**ことを示す (対策前は同じ負荷帯で timeout していた)。

### CI (Linux) について

Gatekeeper が無いので shim は単なる間接参照として動く。Linux 実機での確認はして
いない (ローカルに Linux 環境が無いため) が、CI の ubuntu-latest ジョブが
`just test` を回すので push 時に検証される。CI で効く変更点は 2 つ:

- `packages/testkit/src/exec-shim` は **mode 100755 で記録済み** (`jj diff --git` で確認)。
  hardlink はこの mode を継承するので chmod は不要
- workspace package を追加したため `bun.lock` の更新が必要だった。未更新のままだと
  CI の `bun install --frozen-lockfile` が落ちる (実際に落ちるのを確認してから更新した)

### mock の等価性

`writeMockBin` 経由の mock が直接書いた実行ファイルと区別できないことを、
チャネル毎に確認した (`packages/testkit/test/mock-bin.test.ts` に恒久化):

引数の完全一致 (空白・引用符・glob・空文字列)、exit code、stdout/stderr の分離、
環境変数、stdin (JSONL)、TypeScript ソース、シグナル到達 (exec なので中間プロセス
は残らない)、hardlink であること。

**既知の差異は 1 点のみ**: mock 内の `$0` は sidecar のパスになる。
インタープリタは渡されたファイルから `$0` を決めるため回避不能で、`exec -a` でも
変わらない。現存の mock はいずれも `$0` を読まない。exec-shim にコメントで明記し、
テストでも当該挙動を pin してある。

### 縮退経路

hardlink が張れない場合はコピーにフォールバックする (速度を失うだけで正しさは保つ)。
実測で確認済み:

- shim から実行ビットが失われた checkout → コピー + chmod で復旧、
  コミット済み shim 自体は書き換えない (hardlink 経由の chmod 事故を回避)
- ファイルシステムを跨ぐ配置 (RAM disk で検証) → コピーで動作
