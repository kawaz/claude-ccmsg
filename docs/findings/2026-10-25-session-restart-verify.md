# webui の再起動ボタン (`session_restart`) の実機確認

- Date: 2026-10-25
- 対象: Claude Code 2.1.309、ccmsg の作業コピー (v0.194.0 の上の未 push の変更)
- 動機: [DR-0028](../decisions/DR-0028-session-kill.md) の「restart」(止めて同じ id で resume する) を、本物の claude と組み込みの起動コマンド・本物の hyoui で 1 回通し、旧プロセスが終わること、同じ sid で resume されること、resume の prompt が入ることを見る
- 方法:
  - daemon は作業コピーの `packages/daemon/src/index.ts --foreground` を、`CCMSG_STATE_DIR` / `CCMSG_CONFIG_DIR` / `CCMSG_DATA_DIR` / `HOME` を一時ベースに向けて起動した (verify skill の手順)。`CLAUDE_CONFIG_DIR` は試験セッションと同じ実 config dir のまま (restart は daemon の起動コマンドが claude を起こす config dir と同じセッションにだけ出るため)。config は `session_launcher` に `root_dirs` だけを書き、`launch_command` は省いた (組み込みの起動コマンド → `hyoui run --detached -- claude …`)
  - 試験セッションは一時ベースの空ディレクトリで、`--name "🤖ccmsg-verify-restart" --model sonnet --effort low` と daemon と同じ `CCMSG_*` を付けて hyoui の下で起動した (継いだセッションの変数は落とした)
  - webui は daemon の HTTP を `playwright-cli` で開き、そのセッションの Status タブで操作した

## 判明した事実

| 確かめたこと | 結果 |
|---|---|
| ボタンの表示 | この時点では Status タブの LIVE の行 (`idle`) の横に「再起動」が出た (後で危険ゾーンの「セッションを終了」の隣に移した。下の「置き場を移した後」) |
| 押した後の daemon.log | `session_launch: by=user cwd="<ws の realpath>" resume=<sid> prompt_bytes=425 exit_code=0 …` と `session_restart: session_id=<sid> pid=<旧 pid> terminated=true exit_code=0` |
| 旧プロセス | 旧 pid は居なくなった (`kill -0` が `no such process`) |
| resume | 同じ sid の `sessions/<pid>.json` が新しい pid で現れ、新しい hyoui の端末の argv は `claude --resume <sid> --model sonnet --effort low --name 🤖ccmsg-verify-restart -- "プロセス再起動 (resume) しました。…"` |
| prompt | transcript の末尾に resume の prompt の本文そのままの user 行が足された |
| resume したセッションの到達 | 新しいプロセスのサイドカーが daemon に名乗った (`sidecar <sid>.<run> is pid=<新 pid>`) |
| 結果の表示 | 1 回目は結果の文が出なかった: restart の間にセッションの登録が外れて Status のパネルが一度消え、パネルの中に持っていた結果が消えた。結果をセッションの view に持たせる形に直し、daemon を立て直して 2 回目を押すと、resume したセッションが戻った後のパネルに「再起動しました」が出た |

## 置き場を移した後

「再起動」を危険ゾーンの「セッションを終了」の隣に移した後、同じ手順 (別の試験セッション `🤖ccmsg-verify-restart-place`、`--model haiku`) でもう 1 度押した。危険ゾーンに「セッションを終了」「再起動」が同じ見た目で並び、daemon.log は `session_restart: session_id=<sid> pid=<旧 pid> terminated=true exit_code=0`、resume したセッションが戻った後にボタンの下に「再起動しました」が出た。

## 試験の環境に由来すること

- daemon の `HOME` を一時ベースに向けたので、組み込みの起動コマンドが起こした claude も同じ `HOME` を継ぎ、resume した turn は `Your apiKeyHelper script is failing` の synthetic な assistant 行で終わった (実 config dir の apiKeyHelper が `HOME` を前提にしている)。resume と prompt が入ることの確認には影響しない。本番の daemon は実の `HOME` で動く
- 同じく claude がその `HOME` に `.local/bin/claude` や `Applications/` を作った (一時ベースの中で、後始末はベースごと)

## 未検証

- 押している間の「再起動中…」(disabled) の表示は、restart の間に Status のパネル自体が一度消えるので実ブラウザでは見えなかった。表示の振る舞いは DOM のテスト (`packages/webui/test/status-restart.dom.test.ts`) で固定した
- `restart_timeout` (2 連の SIGTERM の後も終わらないプロセス) は本物の claude では起こしていない (テストで固定)
