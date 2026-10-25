# CronCreate / ScheduleWakeup の予定は、プロセスを止めて resume した後に残るか

- Date: 2026-10-25
- 対象: Claude Code 2.1.309
- 動機: webui の restart (セッションのプロセスを止めて同じ id で resume する、[DR-0028](../decisions/DR-0028-session-kill.md) の restart の節) は、resume したセッションに「cron/schedule は貼り直して」の一文を入れるかを、止める前に予定の有無で決めたい。予定がどこに置かれ、止めて resume した後に何が残るかで、検出の手段と文面が決まる
- 方法: 一時ベースの空ディレクトリを cwd に、実 config dir で試験用セッション (`--name "🤖ccmsg-verify-cron"`、`--model sonnet --effort low`) を端末の proxy の下で起動し、prompt で model に CronCreate / CronDelete / ScheduleWakeup / CronList を呼ばせた。harness が持っている予定は、`--settings` で足した Stop の command hook が受ける入力 (`session_crons`) を一時ベースのファイルに書かせて読んだ。止める操作は session_kill と同じ SIGTERM (1 発で終わった)。resume は `claude --resume <sid>` に CronList を呼ばせる prompt を付けて起動した。ファイルの変化は、CronCreate の直前に置いた marker より新しいファイルを config dir と cwd から探して見た

## 判明した事実

- **CronCreate の予定はディスクに書かれない**。CronCreate の後に増えた・変わったファイルは、transcript、`sessions/<pid>.json`、`.claude.json` / `history.jsonl` / plugin の store と、cwd の `.claude/scheduled_tasks.lock` だけだった。lock の中身は `{ sessionId, pid, procStart, acquiredAt }` で予定は無く、プロセスが SIGTERM で終わると消えた。`durable: true` を付けても同じで、tool の説明も結果の文も「Session-only (not written to disk, dies when Claude exits)」と言う。config dir の JSON に予定の prompt の文字列は無かった
- **それでも、止めて resume すると CronCreate の予定は戻る**。recurring 1 つと one-shot 1 つを作って止め、resume した後の `session_crons` と CronList に、同じ id・同じ schedule・同じ prompt の 2 つがあった。transcript の CronCreate / CronDelete から組み立て直していると読める (戻ったのは transcript にある分だけ)
  - CronDelete で消した予定は戻らない
  - 発火して消えた one-shot は戻らない (発火は transcript に `queue-operation` の enqueue / dequeue と `isMeta` の user 行として残る)
- **ScheduleWakeup の予定は戻らない**。ScheduleWakeup (`delaySeconds` 1800) の予定は CronList と `session_crons` に one-shot として載るが、止めて resume すると消えていた
- **ScheduleWakeup の発火の後に、harness が tool の呼び出し無しで次の wakeup を入れることがある**。60 秒の wakeup が発火して model が ScheduleWakeup を呼ばずに 1 語で答えた後、その turn の終わりの `session_crons` には wakeup は無かったが、次の turn (別の one-shot の発火) の終わりには同じ prompt の wakeup が別の id (約 20 分後) で載っていた。transcript にその ScheduleWakeup の tool_use は無い。これも resume の後には無かった
- **harness が今持っている予定の一覧は、Stop / SubagentStop の hook の入力の `session_crons` (`{ id, schedule, recurring, prompt }`) にだけ出る**。mods の `$` に予定を問い合わせるメソッドは無い (型)。`session_crons` の要素は CronCreate 由来か ScheduleWakeup 由来かを持たない (one-shot の CronCreate と wakeup は同じ形)

## 実用的な示唆

- restart で失われるのは ScheduleWakeup (と、その発火の後に harness が入れた wakeup) の予定で、CronCreate の予定は resume で戻る。「cron/schedule は貼り直して」を CronCreate の予定にも言うと、model が戻った予定を作り直して二重になる。resume の後の文面は、ScheduleWakeup の予定は入れ直し、CronCreate の予定は戻っているので入れ直さない、と分けて言う
- daemon が読める transcript からは、失われる予定の有無を決められない。ScheduleWakeup の tool_result (`Next wakeup scheduled for <時刻> (in <N>s)`) からは呼んだ分の予定は分かるが、harness が tool 無しで入れる wakeup は transcript に出ない
- 予定の一覧が正確に取れるのは Stop の hook の入力の `session_crons` だけで、hooks module がこれを取るには module の中の `classic.Stop` の hook が要る。ccmsg の module は `classic.*` の hook を持たない ([DR-0039](../decisions/DR-0039-all-mods-and-typed-tools.md) §1)

## 検証の詳細

| 段 | 操作 | 直後の `session_crons` |
|---|---|---|
| 1 | CronCreate `17 3 * * *` recurring `durable: true` (`0c4bafe7`)、CronCreate `43 4 1 1 *` one-shot (`dad2183b`) | `0c4bafe7`, `dad2183b` |
| 2 | SIGTERM で止めて resume | `0c4bafe7`, `dad2183b` |
| 3 | CronDelete `0c4bafe7`、ScheduleWakeup 1800 秒 (`3fcc7a8f`) | `dad2183b`, `3fcc7a8f` |
| 4 | SIGTERM で止めて resume | `dad2183b` |
| 5 | ScheduleWakeup 60 秒 (`84627206`)、CronCreate one-shot 3 分後 (`8532f288`) | `dad2183b`, `84627206`, `8532f288` |
| 6 | `84627206` が発火 (model は `WOKE` と答えた) | `dad2183b`, `8532f288` |
| 7 | `8532f288` が発火 (model は `FIRED` と答えた) | `dad2183b`, 新しい wakeup `4f3f1fa3` (tool_use 無し) |
| 8 | SIGTERM で止めて resume | `dad2183b` |

- 各段の resume の後は、prompt で呼ばせた CronList の結果も `session_crons` と同じだった
- 未検証: SIGKILL で止めた時に `.claude/scheduled_tasks.lock` が残るか、recurring の 7 日の期限が resume をまたいで数えられるか、`/loop` で入れた予定
