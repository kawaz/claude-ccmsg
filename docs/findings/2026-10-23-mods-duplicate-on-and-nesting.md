# hooks module で同じ event を複数回 `on()` する: 重複の拒否、matcher 付きの重複、入れ子の順、失敗の伝わり方

- Date: 2026-10-23
- 対象: Claude Code 2.1.308 (型定義 `.claude-plugin/types/claude-code/index.d.ts` の 1 行目が同じ版)
- 動機: hooks module を関心ごとに分け、関心ごとに `on()` を登録しようとした。型定義の `On` は「a plugin's registrations nest in order, first outermost; a repeat throws」と書くだけで、何が repeat かを書いていない
- 方法: 一時ディレクトリに最小の plugin (`hooks/hooks.json` が `register.ts` を名指す) を置き、`claude plugin validate .` と `claude plugin test .` (engine 自身の host に plugin を読ませる) で確かめた。test は `$.session.start(...)` の後に `$.command.run(...)` を呼び、command.run の hook が返す文に session.start の各 hook が記録した順を載せて読んだ。test の側の `on('session.start', ($, e) => ({ cwd: e.cwd }))` が core の代わりに答える (無いと `no implementation for session.start`)。対話セッションでは、ccmsg の module (matcher 付きの同じ event の登録を含む形と、event ごと 1 本の形) を `--plugin-dir` で読ませ、debug log の `hooks module ... loaded` を見た

## 結論

- **matcher なしで同じ event を 2 回 `on()` すると、module ごと読み込まれない**。validate はエラー、load は `hooks module did not load: ... on("session.start") is registered twice without a matcher; the first is at <file>:<line>`。module の他の hook も 1 つも走らない
- **matcher 付きなら同じ event を何度登録してもよい**。matcher なし 1 本 + matcher 付き、`{}` を 2 本、同じ matcher (`{ command: ['clear', 'resume'] }`) を 2 本、`session.start` と `session.*` の組、いずれも validate も load も通った。built-in の `diff` も `command.run` を `{ command: 'diff' }` と `{ command: ['clear', 'resume'] }` に分けて登録している
- **登録は書いた順に入れ子になる** (先に登録したものが外側)。A, B の順に登録すると `A before → B before → B after → A after`。event の後に走る部分 (`await next(e)` の後) は内側、つまり後に登録したものから走る
- **ある hook の失敗は、同じ plugin の外側の hook の「後」を走らせない**。下の「失敗の伝わり方」の表。`.catch` は登録ごとに 1 つだが、失敗した hook の外側の hook の `await next(e)` の後の部分は走らなかった
- **`$` は top-level に宣言した関数にしか渡せない**。登録を 1 本にまとめ、関心ごとの処理を配列に入れて `p.after($)` のように `$` を引数で渡すと、`$ itself is passed as an argument (bound, passed, spread, returned or read)` で module が読み込まれない。hook の関数リテラルの中の closure が `$` を閉じて使うのは通る。top-level の関数を経由した `on()` の呼び出し (`register` から `registerA(on)` を呼ぶ形) は validate が追える

## 重複登録のマトリクス

| 登録 | validate | load (`claude plugin test`) |
|---|---|---|
| `on('session.start', A); on('session.start', B)` | エラー | 読み込まれない |
| `on('session.start', A); on('session.start', {}, B)` | 通る | 通る、A が外側 |
| `on('session.start', {}, A); on('session.start', {}, B)` | 通る | 通る、A が外側 |
| `on('session.start', A); on('session.*', B)` | 通る | 通る、A が外側 |
| `on('command.run', { command: ['clear', 'resume'] }, A)` を 2 本 | 通る (`command.run{command=clear\|resume}` が 2 行) | 試していない |
| `on('turn.start', { agentId: undefined }, A); on('turn.start', { agentId: /./ }, B)` | 通る (`turn.start{agentId=?}`、`turn.start{agentId=/"."/}`) | 試していない |

対話セッション (2.1.308、`--plugin-dir`) でも、matcher 付きの同じ event を並べた module (`session.start{}` を 5 本、`command.run{command=clear|resume}` を 3 本など) は `loaded` になり、各 hook が走った (1/1)。

## 失敗の伝わり方

`claude plugin test` で、session.start に A, (B), C, D の順に登録し、各 hook が `before` / `after` を記録した。どの hook の `.catch` も `next(e)` を返す。

| 失敗のさせ方 | 記録された順 | engine の表示 |
|---|---|---|
| どれも失敗しない (A, B, D) | A before, B before, D before, D after, A after | なし |
| B が `next` の後に throw | A before, B before, D before, D after, B after | `hook failed closed: ... (session.start; its .catch answered)` |
| C が `next` の前に throw (`.catch` あり) | A before, C before | 同上 |
| C が `next` の前に throw (`.catch` なし) | A before, C before | 同上 |

- B が `next` の後に throw した時、内側の D は走り終えているが、外側の A の after は記録されなかった
- C が `next` の前に throw した時、内側の D も外側の A の after も記録されなかった。`.catch` の有無で違わなかった。`.catch` の handler の中で記録した行 (`C catch`) も残らなかった (handler が module の同じ変数を見ているかは確かめていない)
- いずれも session.start の結果は core の答え (`{ cwd }`) になった
- 各 1 回ずつで、対話セッションで同じになるかは見ていない

## ccmsg の module への適用

ccmsg の hooks module は、engine への登録を観測する event ごとに matcher なしの 1 本にまとめ、その event を見る関心 (session-lifecycle / sidecar / session-facts / subagents / prompt-send / guidance / tools) の処理を module の中で書いた順に呼ぶ (`hooks/bus.ts`)。engine の matcher を使うのは、同じ event に 1 本しか無い tool.call (tool ごと) だけ。

- `{}` の matcher で関心ごとに登録する形は、重複検査を matcher で通しているだけで、engine が `{}` を matcher なしと同じに扱った時点で module ごと読み込まれなくなるので使わない
- 関心ごとに engine へ登録しても、上の「失敗の伝わり方」のとおり、内側の関心の失敗で外側の関心の後の部分が走らない。bus では関心ごとの読み込みと処理をそれぞれ捕まえて log し、他の関心の処理を止めない
- 関心は `$` を引数で受け取れないので、各関心は自分の処理を名前付きの top-level 関数で export し、bus の hook の closure がそれを呼ぶ。どの入力が関心に関わるか (`/clear` と `/resume`、subagent の turn、composer からの prompt) は、各関心の入力を読んだ後の判定 (`when`) で書く

## リファレンスへの反映候補

rules リポの reference `claude-mods/overview` の「`on(pattern, matcher?, hook)`」の項に足す候補:

- 「a repeat throws」の repeat は、matcher なしで同じ pattern を 2 回登録すること。matcher 付きは同じ matcher でも重複してよい。拒否は module の読み込み自体の失敗になる (2.1.308)
- 同じ plugin の中で失敗した hook は、外側の hook の `next` の後の部分を走らせない。`.catch` は登録ごとの答えを決めるが、同じ plugin の他の登録の続きは守らない (`claude plugin test`、2.1.308、各 1 回)
- `$` を渡せるのは top-level に宣言した関数だけで、配列や object に入れた関数に引数で渡すと module が読み込まれない。closure が閉じて使うのは通る

reference `claude-mods/develop` の「test」の項に足す候補:

- `$.session.start(...)` を呼ぶ test は、test の側で `on('session.start', ($, e) => ({ cwd: e.cwd }))` を登録して core の代わりに答えさせる (無いと `no implementation for session.start`)
