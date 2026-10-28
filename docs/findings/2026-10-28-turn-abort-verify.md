# webui の × で走行中の turn を中断する (`turn_abort`、DR-0044) を実機で確かめた

- Date: 2026-10-28
- 対象: Claude Code 2.1.312、ccmsg の作業コピー (v0.202.0 の上の DR-0044 の実装)
- 動機: [DR-0044](../decisions/DR-0044-turn-abort.md) の経路 (webui の × → op `turn_abort` → サイドカーの依頼 `turn.abort` → module の `$.turn.abort`) を本物の claude で通し、turn が止まること、`turn.complete` が `reason: 'aborted'` で来ること、× が消えること、module の無いセッションが `no_module` になることを見る
- 方法:
  - daemon は作業コピーの `packages/daemon/src/index.ts --foreground` を、`CCMSG_STATE_DIR` / `CCMSG_CONFIG_DIR` / `CCMSG_DATA_DIR` / `HOME` を一時ディレクトリに向け、`CCMSG_CLAUDE_CONFIG_DIRS` に試験用の config home だけを名指して起動した (verify skill の手順)。state dir は短いパスの一時ディレクトリにした (サイドカーの socket のパスが sun_path の上限を超えないため)
  - 試験セッションは、一時ディレクトリの config home (`CLAUDE_CONFIG_DIR`) と空の作業ディレクトリで、`--name "🤖ccmsg-verify-abort" --plugin-dir <このリポ> --model sonnet --permission-mode default` を付け、daemon と同じ `CCMSG_*` を渡して専用 socket の tmux の中で起動した。継いだセッションの変数は `env -i` で落とした
  - model の応答は Messages API の代役 (`ANTHROPIC_BASE_URL` を手元の HTTP server に向けた、reference `claude-mods/lab-setup`) が返した。prompt に `COUNT` があれば `1\n` から `500\n` を 200 ms ごとに 1 行ずつ stream し、`SLEEPTOOL` があれば終わらない Bash (`until [ -e <無いファイル> ]; do sleep 1; done`) の tool_use を返す。stream が client に切られたら、どこまで送ったかを記録する
  - 全 event を記録する観測 mod (reference `claude-mods/scripts/observe-mod` に `turn.*` の `turnId` / `reason` / `isAborted` の記録を足したもの) を `--plugin-dir` で並べて載せた
  - webui は daemon の HTTP を `playwright-cli` で開き、試験セッションの Timeline で操作した。op だけを見る場合は daemon の socket に user role で繋ぐ小さな client から送った
  - module の無いセッションは、同じ config home で `--plugin-dir` を付けずに `--name "🤖ccmsg-verify-abort-nomod"` で起動した

## 判明した事実

| 場面 | 操作 | 結果 |
|---|---|---|
| 応答の stream 中 (`COUNT`、50 行目まで届いた所) | webui の × | daemon.log `turn_abort: … result=aborted tries=[… aborted]`。観測 mod に `turn.abort` (`by: ccmsg-v1`) が出て、19 ms 後に同じ turnId の `turn.complete` が `reason: "aborted"`、`isAborted: true` で来た。代役の stream は `turn.abort` の 1 ms 後に client に切られた (`n: 50`)。TUI は 50 行目で止まり、中断の表示は出なかった |
| 同上の transcript | — | `1`〜`50` の文の assistant 行が `stop_reason: null` で残った。`[Request interrupted by user]` の user 行は無い (DR-0044 §3 のとおり中断マーカー無し) |
| 応答の stream 中 (2 回目、5 行目) | webui の × | 押した直後 (click から約 0.3 秒後) の Timeline: 「応答中」の行と × は消え、「中断しました」が出ていた (`.tl-turn-abort-result` が 1 つ、`.tl-turn-responding` は 0)。Sessions の行は idle |
| idle (turn が無い) | op を直接 | `no_turn` (`session … is running no turn (it had ended)`)。module は答え、所要 103 ms |
| 知らない sid | op を直接 | `session_not_found`、`tries=[]` |
| session role の接続から | op を直接 | `bad_request` (`op 'turn_abort' requires user role`)。サイドカーに何も書かない |
| module の無いセッションが `COUNT` で応答中 | op を直接 | `no_module` (`… has no hooks module to stop its turn; stop it from its terminal (Esc)`)、`tries=[]`。webui のその Timeline には「応答中」の行も × も出ない (`.tl-turn-responding` 0、`.tl-turn-abort` 0。module の facts が無いので応答中が分からない) |
| tool (Bash) の実行中 | webui の × | `aborted`。`turn.complete` は `reason: "aborted"`、`isAborted: true`。**走っていた Bash のプロセスは止まらず、background の shell に移った**: tool_result は `Command running in background with ID: …`、TUI に `1 shell still running` |
| 比較: tool (Bash) の実行中に TUI で Esc | tmux の `Escape` | Bash のプロセスは kill された。tool_result は `The user doesn't want to proceed with this tool use. …`、その後に `[Request interrupted by user for tool use]` の user 行が足された。`turn.complete` は `reason: "aborted"` |
| 比較: 応答の stream 中に TUI で Esc | tmux の `Escape` | `[Request interrupted by user]` の user 行が足された。`turn.complete` は `reason: "aborted"` |
| 2 つのタブで同じ Timeline を開き、片方で × | webui | 押したタブには「中断しました」、もう片方には何も出ない (どちらも応答中の行は消えた) |

`turn_abort` の daemon.log (sid と request id は一部を伏せた):

```text
turn_abort: session_id=<sid> result=aborted tries=[85469bca… <sid>.<run>.sock aborted]
turn_abort: session_id=<sid> result=aborted tries=[a6ee7b0a… <sid>.<run>.sock aborted]
turn_abort: session_id=<sid> result=no_turn tries=[d1b8ff75… <sid>.<run>.sock no_turn]
turn_abort: session_id=00000000-0000-4000-8000-00000000abcd result=session_not_found tries=[]
turn_abort: session_id=<sid> result=aborted tries=[d7342fec… <sid>.<run>.sock aborted]
turn_abort: session_id=<no module の sid> result=no_module tries=[]
turn_abort: session_id=<sid> result=aborted tries=[a3657687… <sid>.<run>.sock aborted]
```

## Esc との違い

`$.turn.abort` は TUI の Esc と同じく turn を `aborted` で終わらせるが、次の 2 点が違う。

- 中断マーカーを残さない。Esc は `[Request interrupted by user]` (tool の実行中なら `… for tool use]`) の user 行を足し、model は次の request でそれを読む。× では model は中断を知らない
- 走っていた Bash を kill せず、background の shell に移す。型定義の `$.turn.abort` の説明 (`its running tools stopped`) と食い違う。× で止めた後も、その処理は走り続ける

## 試験の環境に由来すること

- model は代役で、本物の API の応答の stream を切った時の挙動は見ていない。`$.turn.abort` は engine の中の turn を止める操作で、代役が見たのは client が stream を切ったことだけ
- 試験セッションは `--allowedTools Bash` で Bash を確認なしに通した (代役が返すコマンドは上の終わらない loop だけ)。permission のダイアログが出ている間の × は見ていない

## 未検証

- 押してから返事までの間に × が disabled になる表示は、返事が速く (0.3 秒以内) 実ブラウザでは捉えていない。DOM のテスト (`packages/webui/test/turn-abort.dom.test.ts`) で固定した
- 前景の Agent (subagent) が走っている間の ×、background の subagent・teammate への影響
- permission のダイアログで止まっている turn への ×
- 同じ sid の 2 つの run の両方が turn を走らせている時 (daemon の unit test でだけ確認)
- この DR より前の plugin で起動したセッションが `abort_failed` (答えが無い) になること (unit test でだけ確認)
