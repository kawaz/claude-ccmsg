# bun UDS / compile 実機検証

DR-0001 §10 が要求する MVP 実装前の bun 実機検証項目 (UDS 周りの bun 固有挙動 / `bun build --compile` での配布可否 / 単一インスタンス保証の手段) を検証した結果。

## 判明した事実

1. **bun バージョン**: 1.3.13 がインストール済み (`which bun && bun --version` で確認)。

2. **UDS server/client**: `Bun.listen({unix: <path>})` / `Bun.connect({unix: <path>})` で line-delimited JSON の双方向通信が正常動作する。複数リクエストの連続送受信、マルチバイト文字 (日本語) を含むペイロードも問題なく往復した。

3. **socket file の権限**: `Bun.listen({unix: ...})` に mode を指定する API は無く、生成される socket file のパーミッションは **プロセスの umask 依存**になる (検証環境は umask 077 のため 0700 で作成された)。`fs.chmodSync(path, 0o600)` を bind 直後に呼べば明示的に 0600 へ変更できる。umask に依存させたくない場合は明示 chmod が必須。

4. **`bun build --compile`**: 単一バイナリの生成に成功した (Mach-O 64-bit arm64 executable、サイズ約 63MB — bun ランタイムを丸ごと同梱するため大きい)。生成したバイナリは **PATH から bun を除去した環境でも単独起動し、UDS 通信も正常動作**した。ランタイム非依存の配布物として機能する。

5. **flock 相当の排他制御**: macOS には `flock(1)` コマンドが存在しない (Linux util-linux 由来のツール)。`Bun.file` / Node 互換 `fs` モジュールにも `flock(2)` 相当の高レベル API は無い (`Object.getOwnPropertyNames` で `Bun.file()` の prototype を確認、`fs` のメソッド一覧にも lock 系は無し)。**`bun:ffi` の `dlopen` で `libSystem.B.dylib` の `flock(2)` を直接呼び出す方式**が実機で機能することを確認した。ロック保持中の別プロセスからの `flock(fd, LOCK_EX|LOCK_NB)` は `rc=-1` で失敗し、保持プロセスが `LOCK_UN` で解放した後は再取得 (`rc=0`) できた。

   検証中の一時的な誤検出について: 初回の検証コードは `process.on('SIGTERM', ...)` のみでプロセスを待機させようとしたが、他に pending なイベントループハンドルが無いため登録直後にプロセスが自然終了してしまい、「2 プロセス目もロック取得に成功する」という偽陽性が出た。`setInterval` で明示的に keep-alive したところ正しい排他動作が確認できた。daemon 実装では UDS の `listen` 自体がハンドルを保持するため通常は問題にならないが、シグナル待ち単体に頼るコードを書く際は要注意。

6. **O_APPEND 追記**: `fs.appendFileSync(path, ...)` と `fs.createWriteStream(path, {flags: 'a'})` はどちらも複数回の呼び出しにわたって正しく追記される。一方で **`Bun.file(path).writer()` はデフォルトで truncate (上書き) 動作**であり、`writer({append: true})` のようにオプションを渡しても truncate されてしまうことを確認した (1.3.13 時点、期待する追記動作にならない)。

7. **途中で切れた行の破損検出**: プロセスが書き込み途中で kill されたケースを模して、改行なしで JSON の途中まで書かれた断片をファイル末尾に追記したところ、行分割 + `JSON.parse` で該当行のみ `Unterminated string` 例外として検出できた。前後の正常な行のパースには影響しない。

8. **UDS パス長 (MVP 実装時の追試)**: macOS の伝統的な socket パス上限は 104 bytes とされるが、Bun 1.3.13 は約 180 文字の socket path でも bind に成功した。実装・テストは短い state dir パス前提のため実運用影響はないが、104 制約は Bun 経由では文書より緩い可能性がある。

## 実用的な示唆

- **JSONL への追記実装は `fs.appendFileSync` か `fs.createWriteStream(path, {flags: 'a'})` を使う。`Bun.file().writer()` は追記用途では使わない** (truncate されるため room イベントログ等の追記ストレージに使うと事故る)。
- UDS socket file は bind 直後に `fs.chmodSync(path, 0o600)` を明示的に呼び、umask に依存しない権限保証をする。
- 単一インスタンス保証 (DR-0002 の要求項目) は `bun:ffi` 経由の `flock(2)` FFI 呼び出しで実現できる。ロックファイルパス + `LOCK_EX|LOCK_NB` で「既に daemon が起動していれば起動失敗」を作れる。ただし `dlopen('libSystem.B.dylib', ...)` は macOS 前提の実装であり、Linux 対応時は `libc.so.6` 等のライブラリ名切替と再検証が必要 (今回は macOS のみ検証)。
- `bun build --compile` は配布用単一バイナリとして実用に足る (ランタイム非依存で起動できる)。サイズは約 63MB あるため、配布サイズを気にする場面では考慮が必要。
- テスト用の bun プロセスをバックグラウンドで待機させる場合、`process.on('SIGTERM')` の登録だけではイベントループが維持されず即終了することがある。keep-alive 目的の待機ロジックには `setInterval` 等の pending ハンドルが必要 (daemon 本体は listen ソケットがハンドルになるため該当しないが、テストコードや補助スクリプトを書く際に踏みやすい落とし穴)。

## 検証の詳細

検証コードは scratchpad 配下 (`bun-verify/`) に置き、リポジトリには含めていない。

### 1. bun バージョン確認

```
$ which bun && bun --version
/etc/profiles/per-user/kawaz/bin/bun
1.3.13
```

### 2. UDS echo サーバ / クライアント

`Bun.listen({unix: path, socket: {data, open, close, error}})` でサーバを実装、`Bun.connect({unix: path, socket: {...}})` でクライアントを実装。line-delimited JSON を 3 件送信し、全て echo で返ってくることを確認:

```
[client] connected, sending 3 messages
[client] all responses received:
   {"echo":{"seq":1,"msg":"hello"},"pid":9638}
   {"echo":{"seq":2,"msg":"world"},"pid":9638}
   {"echo":{"seq":3,"msg":"こんにちは"},"pid":9638}
[client] connection closed
CLIENT_DONE:3
```

socket file のパーミッション (umask 077 環境):

```
$ ls -la /tmp/bun-verify-test.sock
srw------- 1 kawaz wheel 0 ... /tmp/bun-verify-test.sock   # chmod 前: 0700 (umask 依存)
# fs.chmodSync(path, 0o600) 後は 0600 に変わることを確認
```

### 3. `bun build --compile`

```
$ bun build --compile ./uds-server.ts --outfile ./uds-server-compiled
   [4ms]  bundle  1 modules
 [111ms] compile  ./uds-server-compiled

$ ls -la ./uds-server-compiled
-rwxr-xr-x 1 kawaz wheel 63060304 ... ./uds-server-compiled

$ file ./uds-server-compiled
./uds-server-compiled: Mach-O 64-bit executable arm64
```

PATH から bun のディレクトリを除去した環境で実行:

```
$ PATH="<bun除去済みPATH>" which bun
bun not found

$ PATH="<bun除去済みPATH>" ./uds-server-compiled /tmp/bun-verify-test2.sock &
[server] socket file mode before chmod: 700
[server] socket file mode after chmod(0o600): 600
[server] listening on unix socket: /tmp/bun-verify-test2.sock
SERVER_READY

$ ps -p <pid> -o pid,ppid,comm
  PID  PPID COMM
<pid>     1 ./uds-server-compiled
```

通常の bun クライアントから疎通確認済み (echo が正しく返る)。

### 4. flock 相当 (bun:ffi 経由の libc flock(2))

`bun:ffi` の `dlopen` で `libSystem.B.dylib` の `flock` シンボルをロードし、`fs.openSync` で得た fd に対して呼び出す:

```ts
import { dlopen, FFIType } from "bun:ffi";
const lib = dlopen("libSystem.B.dylib", {
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
});
const fd = fs.openSync(lockPath, "w+");
const rc = lib.symbols.flock(fd, LOCK_EX | LOCK_NB); // LOCK_EX=2, LOCK_NB=4
```

プロセス 1 がロック保持中 (`setInterval` で keep-alive):

```
[flock-test] opened fd: 4
[flock-test] flock(LOCK_EX|LOCK_NB) rc: 0
[flock-test] LOCK ACQUIRED, holding for signal...
READY_HOLDING
```

プロセス 2 が同じロックを取得しようとして失敗:

```
[flock-test] opened fd: 4
[flock-test] flock(LOCK_EX|LOCK_NB) rc: -1
[flock-test] FAILED TO ACQUIRE LOCK (errno-based rc): -1
```

プロセス 1 に SIGTERM を送って解放後、再取得は成功:

```
[flock-test] unlocked rc: 0
# 別プロセスで再度実行
[flock-test] flock(LOCK_EX|LOCK_NB) rc: 0
[flock-test] LOCK ACQUIRED, holding for signal...
```

(補足: 最初の試行では `process.on('SIGTERM')` のみでプロセスを待機させたところ、イベントループに他の pending ハンドルが無く即座に自然終了し、2 プロセス目も `rc:0` で取得できてしまう偽陽性が出た。`setInterval(() => {}, 1000)` を足して keep-alive したところ、上記の正しい排他動作が再現した。)

### 5. O_APPEND 追記と破損検出

`fs.appendFileSync` を 2 回実行 (各 5 行) すると 10 行すべてが有効な JSON として残る:

```
$ wc -l /tmp/bun-verify-append-test.jsonl
10 /tmp/bun-verify-append-test.jsonl
# 全行 JSON.parse OK
```

`fs.createWriteStream(path, {flags: 'a'})` も同様に複数回呼び出しで追記される (line1, line2 とも残る)。

一方 `Bun.file(path).writer()` はデフォルトで truncate:

```
$ bun -e "const w = Bun.file(path).writer(); w.write('line1\n'); await w.end();"
$ cat path
line1
$ bun -e "const w = Bun.file(path).writer(); w.write('line2\n'); await w.end();"
$ cat path
line2   # line1 が消えている (truncate)
```

`writer({append: true})` を渡しても同様に truncate される (line1 が消えて line2 のみ残った)。

途中で切れた行の破損検出 (kill 相当を模擬):

```
$ cat -A corrupt.jsonl | tail -3
{"seq":1}$
{"seq":2}$
{"seq":999,"bro          # 改行なし、JSON 途中で終端

$ bun -e "... 行ごとに JSON.parse を試す ..."
0 VALID: {"seq":1}
1 VALID: {"seq":2}
2 CORRUPT/PARTIAL LINE DETECTED: "{\"seq\":999,\"bro" - JSON Parse error: Unterminated string
```
