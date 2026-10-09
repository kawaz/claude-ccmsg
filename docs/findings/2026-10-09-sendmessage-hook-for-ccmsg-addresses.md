# SendMessage を `session.send` hook で横取りして `ccmsg:` 宛に届ける実機検証

- 日付: 2026-10-09
- 対象: Claude Code 2.1.295 (隔離 config home 2 つ、モデル haiku、hyoui 0.14 内の対話セッション、実験用 plugin を `--plugin-dir` で読み込み)。時刻は UTC
- 目的: DR-0037 の前提 (hooks module の `session.send` で `ccmsg:` 宛の SendMessage を横取りし、daemon 経由で別セッションに届ける) が成立するかを実機で確かめる。結論は DR-0037 §4 に反映済みで、本書はその根拠の記録
- 方法: config home X と Y を別にした隔離セッションを起動し、実験用 plugin の hook ログ・双方の transcript・debug ログを突き合わせた。注入は実験用スクリプトが相手の peer socket に直接書いた (daemon の `peer_message_status` 待ちの判定は再現していない)。cwd の確認用にセッション Z と W を追加した

## 判明した事実

1. model に見える送信結果の文面は harness が決める。hook の戻り値は定型文に包まれる (表 1)
2. hook が throw すると harness は本来の宛先解決に戻り、`ccmsg:...` を名前として探して `No agent named ... is reachable` を返す
3. hook 内の await は 3 秒・10 秒で成功し、その間 turn の進行表示 (`Puttering… (13s …)`) が続く。`$.process.run` の既定の期限は 30 秒で、超えると throw になる。`timeoutMs: 45000` を明示すれば 30 秒を超えて待てる。`session.send` hook 自体の時間予算は未検証
4. 本来の SendMessage は、受け手の `session.receive` hook が握りつぶしても送り手に成功を返す。拒否は送り手に伝わらない
5. config home をまたぐ往復が閉じる。X の hook が横取りして Y の socket に `from="ccmsg:<X の sid>"` で注入すると、Y には peer として届く
6. 複数宛の一部失敗を `isDelivered: false` で返すと、届いた分があっても model には `Not sent` と見える。`isDelivered: true` は成功の定型文になる
7. 起動の cwd に symlink や末尾 `/` があっても、state file と `claude agents --json` の cwd は realpath に揃う
8. 隔離したセッションの messaging socket は、`XDG_RUNTIME_DIR` / `CLAUDE_CODE_TMPDIR` / `TMPDIR` を作業ディレクトリ内に向けると、その中の `cc-socks/<pid>.sock` に作られる

### 表 1: 送信結果の文面 (X の transcript の model-visible tool_result)

| 時刻 | 送信 | model が読んだ結果 |
|---|---|---|
| 00:54:03.620 | native・存在しない名前 | `{"success":false,"message":"No agent named 'nonexistent-exp37' is reachable.\nUse ListAgents to see everyone you can message."}` |
| 00:54:32.595 | hook が `{isDelivered:true}` | `{"success":true,"message":"Delivered by a plugin hook; nothing else was sent."}` |
| 00:54:34.132 | hook が `{isDelivered:false, reason:"Experimental recipient not found"}` | `{"success":false,"message":"Not sent: a plugin hook refused it (Experimental recipient not found)."}` |
| 00:56:39.251 | native・同一 config home の live セッション名 | `{"success":true,"message":"“...” → ws-real-bd (another Claude session on this machine; in that session's inbox, not yet read by its Claude — a [Cross-session delivery notice] follows if that session holds it (usually a different permission mode) or refuses it)","msg_id":"3af3a1bb-..."}` |

- 同一 config home でも、生の session ID を `to` にした送信 (00:56:06.335) は `No agent named ... is reachable` で、ListAgents に出る名前で送ると成功した
- 受信側の拒否: `session.receive` hook が 00:59:02.239 に `{consumed:"recipient declined experiment message"}` を返し、受信側 debug は `consumed by a hook ... not queued`。送信側の native の tool_result (00:59:02.296) は success:true と inbox 入りの文面だった。後続の配信拒否通知は観測できなかった。harness の許可設定による拒否 (別の permission mode) の文面は未採取

### 往復 (config home をまたぐ)

- Y の受信 (00:54:53.819) は `origin: {"kind":"peer"}`。本文は `<cross-session-message from="ccmsg:<X の sid>" from-name="ccmsg:<X の sid>" from-mode="prompting">` の封筒
- transcript では `origin.kind:"peer"`、`promptSource:"system"`、model 向け本文に `Another Claude session sent a message:` と peer の権限境界の説明が付く。画面は `Message from @ccmsg-<sid の先頭>…`
- Y の送信 hook が 00:54:57.770 に `to:"ccmsg:<X の sid>"` の送信を記録し、X の受信 hook が 00:54:57.852 に同じ本文を記録した

### cwd と隔離

- 一時ディレクトリの symlink 経由のパスと、作業ディレクトリへの symlink (`ws-link → ws-real`) を確認したうえで、X・Z は symlink を含むパス、Y は実パス、W は末尾 `/` のある実パスから起動した。両 config home の `claude agents --json` と 4 件の `<config>/sessions/<pid>.json` の cwd は全て `<lab>/ws-real` の realpath (末尾 `/` なし)。サブディレクトリの一致は未検証
- `XDG_RUNTIME_DIR` / `CLAUDE_CODE_TMPDIR` / `TMPDIR` を作業ディレクトリの `run/` に向けると、各 pid の `messagingSocketPath` は `run/cc-socks/<pid>.sock`。終了後に各 socket は消えた。hyoui は `HYOUI_STATE_DIR=run/`。3 つの変数のどれが効いているかは切り分けていない
- 初回起動の画面で `Down` と `Enter` を同時に送ると、確認画面で No が選ばれて終了した

## 実用的な示唆

- `reason` は括弧の中に入って `Not sent: a plugin hook refused it (<reason>).` になる。原因と次の行動が分かる 1 文にする
- `session.send` hook は失敗をすべて捕まえて `{ isDelivered: false, reason }` で返す。throw すると宛先が `ccmsg:...` のまま harness の名前解決に流れ、原因が隠れる
- 外部呼び出しには `timeoutMs` を明示し、全体を十数秒に収める。期限超過は「届いたか確かめられなかった」の `reason` で返す
- 受け手の拒否は本来の SendMessage でも送り手に返らない。相手の socket に書けた時点で成功を返してよい
- 複数宛の一部失敗は `isDelivered: true` を返す (推し)。`false` だと届いた相手がいても `Not sent` に見え、送り直して二重に届く。届かなかった内訳を伝える手段は別に要る
- `ccmsg:path:<dir>` は realpath にして完全一致で比べる
- 隔離実験で `ccmsg` の socket を実セッションと分けるには、runtime 系の 3 変数を作業ディレクトリに向ける

## 未確認事項

- `session.send` hook 自体の時間予算 (30 秒の失敗は hook 内の `$.process.run` の期限だった)
- 受け手の許可設定による拒否の文面と、後続の配信拒否通知
- daemon の `peer_message_status` 待ちの判定 (注入は peer socket への直接書き込みで代用)
- 作業ディレクトリのサブディレクトリから起動した場合の cwd
- `XDG_RUNTIME_DIR` / `CLAUDE_CODE_TMPDIR` / `TMPDIR` のどれが socket の位置を決めているか

## 検証の詳細

### 実験用 plugin の `session.send` hook (抜粋)

```ts
on('session.send', async ($, e, next) => {
  if (!e.to.startsWith('ccmsg:')) return next(e)
  let result: { isDelivered: true } | { isDelivered: false; reason: string }
  if (e.to === 'ccmsg:success') result = { isDelivered: true }
  else if (e.to === 'ccmsg:failure') result = { isDelivered: false, reason: 'Experimental recipient not found' }
  else if (e.to.startsWith('ccmsg:sleep:')) {
    const waited = await $.process.run(['sleep', e.to.slice('ccmsg:sleep:'.length)], { timeoutMs: 45000 })
    result = { isDelivered: true }
  } else {
    const delivered = await $.process.run(['python3', '-I', '<lab>/bin/peer.py', '<lab>', await $.session.id(), e.to, e.text], { timeoutMs: 5000 })
    result = delivered.exitCode !== 0
      ? { isDelivered: false, reason: 'Peer injection failed: ' + delivered.stderr }
      : JSON.parse(delivered.stdout)
  }
  return result
})
on('session.receive', async ($, e, next) => {
  if (e.text.includes('native-refusal-37')) return { consumed: 'recipient declined experiment message' }
  return next(e)
})
```

- `hooks.json` は `{"modules":["./register.ts"]}`。ログは `$.process.run` で追記専用スクリプトを呼んで書いた (実験用の記録処理は省略)
- 一部失敗の実験用宛先 `ccmsg:path:partial:true` / `ccmsg:path:partial:false` は、実在する Y の sid と存在しない sid の 2 宛に順に送り、`:true` なら `{isDelivered:true}`、`:false` なら内訳入りの `reason` で `{isDelivered:false}` を返す

### 注入スクリプト (`peer.py`) の要点

宛先 sid を持つ `sessions/<pid>.json` を両 config home から探し、`messagingSocketPath` と `sessions/<pid>.<digest>.key` の `peerToken` で次の 2 フレームを 1 行ずつ書く。socket は何も返さない。

```python
source = 'ccmsg:' + sender_sid
envelope = f'<cross-session-message from="{source}" from-name="{source}" from-mode="prompting">\n{text}\n</cross-session-message>'
frames = [
  {'type': 'auth', 'token': token},
  {'type': 'user', 'session_id': sid, 'msg_id': mid, 'from': source, 'message': {'content': envelope}},
]
# AF_UNIX で state['messagingSocketPath'] に接続し、各 frame を JSON 1 行で sendall
```

実在しない sid は `{"isDelivered": false, "reason": "No live session for <address>"}` を返す。

### await の時間 (X の debug)

```
00:57:04.096Z ... session.send settled in 3165.4ms
00:57:16.127Z ... session.send settled in 10147.0ms
00:57:47.580Z ... session.send hook skipped: threw ccmsg-exp37: $.process.run(sleep) aborted: still running after 30000ms
00:57:47.605Z ... session.send settled in 30086.9ms
01:02:31.240Z ... session.send settled in 30180.4ms   (timeoutMs: 45000 を明示)
```

30 秒の失敗は throw した hook が skip され、model-visible は native の `No agent named 'ccmsg:sleep:30' is reachable...` になった。`timeoutMs: 45000` の再試行は hook の成功の文面を返した。

### 一部失敗 (01:01:59)

2 宛のうち Y へは実際に届き、もう一方 (存在しない sid) は失敗。`isDelivered: false` で内訳を reason に書くと model は次を読んだ (届いた分があっても `Not sent`)。

```
{"success":false,"message":"Not sent: a plugin hook refused it (Delivered to Y (true); failed to deliver to missing recipient (...))."}
```

`isDelivered: true` は成功の定型文。
