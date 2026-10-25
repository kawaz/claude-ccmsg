# CronCreate / ScheduleWakeup の予定は、プロセスを止めて resume した後に残るか

- Date: 2026-10-25
- 対象: Claude Code 2.1.309
- 動機: [DR-0028](../decisions/DR-0028-session-kill.md) の restart (止めて同じ id で resume する) の前後で、セッションの予定がどうなるかを知っておく。restart は予定の有無を調べない (固定文の prompt) と決まったので、観測した分だけを残す

実 config dir の試験用セッションで model に CronCreate / CronDelete / ScheduleWakeup を呼ばせ、Stop の hook の入力の `session_crons` (harness が今持っている予定) を SIGTERM で止める前後と resume の後に読んだ。CronCreate の予定はディスクに書かれず (cwd の `.claude/scheduled_tasks.lock` に `{sessionId, pid, procStart, acquiredAt}` があるだけで、プロセスの終了で消える。`durable: true` も効かない)、それでも resume すると同じ id・schedule・prompt で戻った (transcript から組み立て直していると読める。CronDelete したものと発火済みの one-shot は戻らない)。ScheduleWakeup の予定と、wakeup の発火の後に harness が tool の呼び出し無しで入れた次の wakeup は戻らなかった。harness の予定の一覧は Stop / SubagentStop の hook の入力の `session_crons` にだけ出て、要素は CronCreate 由来か ScheduleWakeup 由来かを持たない。
