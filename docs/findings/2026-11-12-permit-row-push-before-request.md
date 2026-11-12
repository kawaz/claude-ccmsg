# `permit` の呼び出しの行の push は、op `permit_request` より先に daemon に届く

- Date: 2026-11-12
- 対象: Claude Code 2.1.322、ccmsg v0.258.0 の作業コピー
- 動機: 許可依頼の読み上げの起点を、op `permit_request` を受けた時から、module が push する `permit` の呼び出し (tool_use) の行に移す (DR-0040 §6)。発声コマンドに依頼のバブルを開く URL (行の uuid の位置) を渡すため。行の push が tool の実行 (handler が起こす `ccmsg sidecar permit` → op `permit_request`) より後にしか届かないなら、読み上げが遅れる。どちらが先に、どれだけの差で届くかを見る
- 方法:
  - 隔離 daemon (作業コピーの `packages/daemon/src/index.ts --foreground`、`CCMSG_STATE_DIR` / `CCMSG_CONFIG_DIR` / `CCMSG_DATA_DIR` / `HOME` / `TMPDIR` を一時ディレクトリに、`CCMSG_CLAUDE_CONFIG_DIRS` に試験用の config home だけ)。config の `say_command` は stdin の JSON を時刻 (ms) 付きでファイルに足すだけのスクリプト (音は出さない)
  - daemon の `transcript_push` に、受けた行ごとの uuid と tool_use の名前・id を daemon.log に書く一時の行を足した (観測の後に消した)。daemon.log の各行の時刻は書いた時点
  - 試験用セッション `🤖ccmsg-verify-permit-push-order`: 一時の config home (`.claude.json` に onboarding 済み・ダミー鍵の承認・作業ディレクトリの trust)、`env -i`、専用 socket の tmux の中の対話のセッション、`--plugin-dir <作業コピー> --permission-mode default --model haiku --debug-file <一時ファイル>`。ccmsg の tool は対話のセッションでだけ登録される (`-p` では `No such tool available` になった)
  - model は Messages API の代役 (`ANTHROPIC_BASE_URL`)。prompt に `PERMITPROBE` があり結果がまだ無い request には、text の block (`asking`) と `mcp__ccmsg-v1__permit` の tool_use (`{ blocked, voice, intents }`) を返し、他は `done` で end_turn
  - 1 回ごとに `/clear` で新しいセッションにして、4 回走らせた

## 結果

時刻は daemon.log と Claude Code の debug log (同じ機械の時計)。差は push を基準にした ms。

| 回 | push (permit の行) | `$.process.run` (`ccmsg sidecar permit`) の起動 | `permit_request` | 発声コマンドの起動 (op の後、旧の起点) |
|---|---|---|---|---|
| 1 | 0 | +25 | +93 | +474 |
| 2 | 0 | −2 | +69 | +83 |
| 3 | 0 | −2 | +66 | +79 |
| 4 | 0 | −2 | +69 | +83 |

- 4 回とも、permit の呼び出しの行の push が op `permit_request` より 66〜93 ms 先に daemon に届いた。push は handler が `ccmsg sidecar permit` を起こすのとほぼ同時 (±25 ms) で、op はその後の CLI の起動と接続の分だけ遅れる
- push の行は `fresh` (relay がまだファイルから読んでいない行) だった (4/4)。読み上げの対象になる
- push の行の uuid は、transcript の jsonl のその行の uuid と同じ (2 回で照合)。webui は依頼のバブルをこの uuid の位置で選ぶ (`toolUseRowUuid`)
- assistant の text と tool_use は別の行 (別の uuid) で push される。tool_use の行は text の行の後
- 1 回目の発声コマンドの起動が遅いのは、そのセッションの最初の発声で辞書のファイルの読みや bun の起動が重なったためと考えている (未検証)

## 確かめていないこと

- subagent / teammate の permit の呼び出しの行 (module が断る) の push の順。読み上げはしないので、順は効かない
- push が前の push の返事を待って溜まっている時 (同じ turn に行が多い時) の差。module は push を直列にし、待つ間の行を次の 1 回にまとめる (DR-0045 §2)
- 実の model (stream の速さが代役と違う) での差
