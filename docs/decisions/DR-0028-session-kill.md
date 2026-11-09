# DR-0028: session_kill (完了セッションのプロセス停止)

- Status: Proposed
- Date: 2026-07-18

## Context

webui からセッションを起動できる (DR-0018) 一方、完了したセッションのプロセスを止める手段が UI に無い。用済みの interactive/background claude プロセスが溜まる。
kawaz 要望 (2026-07-18):

- Status タブ内 (普段触らない場所) に危険色の終了ボタンを置く
- 確認ダイアログを必ず表示
- claude プロセスは終了確認プロンプトのガードがあり、**シグナル 1 発では止まらないことがある → 2 連続送信が必要**
- sessionId → pid は `claude agents` 系で解決できる

観測済み事実: daemon は既に `claude agents --json` を全 `~/.claude*` config dir に対して定期 poll しており (agents.ts / DR-0009 addendum)、`AgentInfo { pid, sessionId, cwd, kind, ... }` を webui に配信している。

## Decision

### daemon: 新 op `session_kill` (user role 限定・即時 reply)

- `IDENTITY_OPS` に追加。`conn.identity?.role !== "user"` なら `bad_request` で拒否。session role のエージェントが互いを殺せてはいけない。
- pid 解決は **リクエスト時に `claude agents --json --all` を fresh 実行**してsessionId → pid を引く (`--all` で completed background も含む)。poller cache (最大 5 秒古い) を使わない: kill は stale pid が即誤殺につながる操作なので、多少の latency (数百 ms〜) を払って fresh に解決する。全 config dir を走査し、最初にマッチした行を採用。見つからなければ `not_found`。
- **pid 実在検証 (pid 再利用ガード)**: 解決した pid に対し`ps -p <pid> -o command=` を実行し、コマンドラインに `claude` が含まれることを確認してから kill。`claude agents` の応答と kill 実行の間 (および CLI 側 registryの stale entry) で pid が別プロセスに再利用されるのを防ぐ。検証不一致は`not_found` (「もう居ない」と同じ扱いで十分)。
  - 実装追記 (2026-07-18): 判定は substring でなく **argv[0] の basename が`claude` と完全一致**。substring だと kawaz 環境では ccmsg daemon 自身(`bun .../.claude-personal/plugins/cache/ccmsg/...`) や Claude Code 起動のzsh (`source .../.claude-personal/shell-snapshots/...`) まで通過し、pid再利用時に daemon 自殺の経路になる (実測で確認)。
  - 実装追記 (2026-07-18): registry 行の pid は **整数かつ > 1 のみ採用**。
    `kill(0)` は自プロセスグループ全体、負数はグループ送信、1 は init であり、腐った registry 行がこれらに到達してはならない。
  - 実装追記 (2026-07-18): シグナル送信・生存確認の errno は **ESRCH のみ「消滅」扱い**。EPERM (実在するが権限なし) を消滅扱いすると生存プロセスに「終了を確認」と虚偽報告するため、internal エラーとして表面化させる。
- **kill 手順: SIGTERM → 1s 待機 → 生存していれば SIGTERM 再送 → 最大 3s消滅確認 → 結果返却**。
  - 2 発目が必要な理由: claude TUI は 1 発目の SIGTERM で「本当に終了するか」の確認プロンプト状態に入るガードがあり、2 発目で確定する (kawaz 観測)。
  - 1 発目後の待機は 1s 固定: 短すぎると 1 発目のプロンプト遷移前に 2 発目が届いて 1 発扱いになるリスク、長すぎると UI 応答が鈍い。ガード遷移はプロセス内イベントで観測不能なため polling (200ms 間隔の `kill(pid, 0)`
    生存確認) が正当な例外 (sloppy-ai-patterns の「polling しか無い外部対象」)。
  - 1 発目の待機中に消滅したら 2 発目は送らない (ガード無し状態、例えばbackground プロセスは 1 発で死ぬ)。
  - 応答は `{ ok: true, terminated: boolean }` — 3s 以内に消滅を観測できたら`terminated: true`、2 発送ったが猶予内に消滅を観測できなければ`terminated: false` (シグナル送達は成功)。SIGKILL へのエスカレーションはしない: transcript flush 等の graceful shutdown を破壊しうる不可逆操作をdaemon が自動判断しない。必要なら人間が手で殺す。
- 2-phase (acceptTwoPhase) ではなく**通常の即時 reply**: 最悪 ~4s (agents 実行
  + 待機) は translate/launch と同程度だが、kill は結果 (terminated か否か) をボタン押下の直接応答として返すのが UI 上素直で、途中切断時に浮く状態も無い。
  → 実装時に ws の既存 timeout と干渉するなら 2-phase へ変更可 (実装 worker 判断)。
  - 実装追記 (2026-07-18): **2-phase を採用**。通常 reply は「同期 dispatch +
    到着順ペアリング」契約で、非同期 op (fresh agents 実行 + 最大 3s 猶予) の
    deferred reply は同一接続の後続 reply を全て desync させるため、即時 reply は
    構造的に不可能 (translate/session_launch が 2-phase 化されたのと同じ理由)。

### webui: Status タブ最下部に危険ゾーン

- `StatusPanel` 最下部に危険ゾーン。セッション操作 (下の restart の webui) と同じ 1 行 1 操作の一覧の形で、名前「セッションを終了」、何をするかの 1 行、右端の「終了…」ボタン。枠・名前・ボタンは `--danger` 色 (app.css 既存変数)。
- 確認は既存パターンに合わせ `window.confirm()` (MemberChip.tsx の kick と同型)。
  カスタムダイアログを新設しない: 誤爆防止が目的で、体験の質は kick と同水準で足りる。
- 実行中は disabled + 結果を近傍に表示 (terminated / not_found / エラー)。

## Alternatives Considered

- **poller cache から pid を引く**: 実行コストゼロだが最大 5s stale。kill は誤対象が致命的なので不採用 (fresh 実行 + ps 検証の二重ガードを採る)。
- **SIGKILL エスカレーション付き 3 段 kill**: 確実に死ぬが、claude の graceful shutdown (transcript/state flush) を破壊するリスク。daemon が自動で不可逆側に倒すべきでない。不採用、`terminated: false` を返して人間に委ねる。
- **cache の AgentInfo を webui から pid ごと送らせる (`pid` をリクエストに含める)**:
  クライアント申告の pid を殺すのは権限モデル上危険 (user role 限定とはいえ、daemon 側解決に比べ検証根拠が弱い)。リクエストは `session_id` のみ受ける。
- **kick 同様に Sidebar/SessionList へボタン設置**: 目立つ場所は誤爆リスク。
  kawaz 指定の「普段触らない Status タブ内」を採用。
- **確認ダイアログをカスタム UI で新設**: リッチだが新規パターン導入のコストに見合わない。既存 `window.confirm` 慣習 (MemberChip) に合わせる。

## Consequences

- daemon に「他プロセスへシグナルを送る」能力が初めて入る。誤殺ガードは(1) user role 限定 (2) daemon 側での fresh pid 解決 (3) ps コマンドライン検証の 3 層。それでも理論上の TOCTOU 窓 (ps 検証〜kill の間) は残る — pid 再利用がその数 ms で起きる確率は実用上無視できると判断。
- `terminated: false` 応答があり得る (ガードが 2 発で突破できない将来の CLI 変更等)。UI はこれを失敗でなく「シグナル送信済み・未確認」として表示する。
- テストで実プロセスを殺す必要がある。検証コマンド (`claude agents` 実行と`ps` 検証) を injectable にして、sleep 子プロセスで kill 経路を実テストする(設計は実装指示書側)。

## 関連

- [DR-0018](./DR-0018-session-launcher.md) — セッションの起動 (停止と対になる操作)
- [DR-0009](./DR-0009-session-transcript-access.md) — agents poll の出自

## Addendum: opt-in SIGKILL エスカレーション (kawaz)

現行の SIGTERM 2 連発では TUI が確認 guard から動かないケースが実運用で発生する ("セッション終了が効かないことが結構ある" — kawaz)。当初却下した`SIGKILL` 経路を、**daemon が自動で選ばず、ユーザーが opt-in する形**で解禁する。

### 追加分の契約

- `SessionKillRequest.force?: boolean` を追加。true の時のみ SIGKILL 経路。
  fresh sid→pid 解決と ps コマンドライン検証 (pid-reuse guard) は force でもそのまま通す — 検証を短絡すると誤殺リスクが上がるだけで得るものが無い
- 経路: `killSessionForce(pid, deps)` — SIGKILL を 1 発、以降は通常経路と同じ liveness poll。落ちたら `terminated: true`、SIGKILL 後も観測される(uninterruptible sleep 等の zombie) 場合は `terminated: false` を正直に返す
- webui: 「セッションを終了」で `terminated: false` を観測したら、行の名前が「強制終了 (-KILL)」、ボタンが「強制終了…」に変化 (ボタンは背景色 danger 反転 + 太字)。再度押すと SIGKILL、confirm 文言に「不可逆 / transcript flush が途中で切れる可能性」を明記してもう 1 段のガードを掛ける

### 却下した代替案 (再検討)

- **原案通り SIGKILL を認めない**: 実運用で 2 発 SIGTERM に耐える TUI 挙動が観測されており、UI が「シグナル送信済み・未確認」を表示するだけでユーザー
  は次の手を打てない (daemon 側に手段が無いため kill -9 を shell で打つ必要がある)。opt-in 明示 + 2 段確認 (通常押下 → force ボタン化 → confirm) で、「daemon が自動で不可逆側に倒す」原則は保ちつつ、ユーザーの明示的意思で最終手段が届く形に緩和する
- **daemon 側で自動エスカレーション** (SIGTERM 失敗後に SIGKILL): 原案の却下理由がそのまま生きる (transcript/state flush を破壊するのは自動化してよい判断ではない)。継続不採用

## Addendum: restart (止めて同じ id で resume する)

kawaz 裁定 (2026-10-25): webui の Status タブにセッションの restart ボタンを置き、そのセッションを停止 (本 DR の `session_kill` と同じ手順) してから同じ sid で resume (DR-0018 の `session_launch`、`resume: <sid>`) する。用途は plugin の更新と claude 本体の更新をワンタッチで反映すること。background のプロセスとチームメートが死ぬことはユーザが理解して押すので、daemon も webui もケアしない。

### op `session_restart` (user role)

- request: `{ op: "session_restart", session_id, prompt? }`。`prompt` は resume したセッションの最初の prompt (空にはできない、`session_launch` の `prompt` と同じ読み方)。無ければ下の既定文
- response: `{ ok: true, restarted: true, session_id, exit_code, stdout, stderr }`。`session_id` は resume したセッションの id (request と同じ)、`exit_code` / `stdout` / `stderr` は `session_launch` と同じ (起動コマンドの終了コードと出力、DR-0018 §3.4)。`exit_code` が 0 でなければ、セッションは止まったが起動コマンドは resume を起こしていない
- error (どれも、断った時はプロセスを止めていない。`internal` だけは止めた後かもしれない):
  - `bad_request`: user role でない
  - `launcher_not_configured` / `launch_busy`: `session_launch` と同じ (DR-0018 §3.4)。restart は走っている間ずっと起動の 1 つに数え、daemon の終わり方の待ち (DR-0018 §3.5) にも入る
  - `not_found`: その sid のプロセスが居ない (本 DR の pid の解決と ps の検証に通らない)
  - `restart_unavailable`: そのセッションのプロセスの record に `cwd` が無く、resume する場所が分からない
  - `restart_timeout`: 停止の手順の猶予の中でプロセスの終わりを観測できなかった。起動コマンドは走らせていない (シグナルは届いているので、後でプロセスが終わることはある)
  - `invalid_args` / `launch_command_unavailable`: `session_launch` と同じ。前者は起動の入力がスキーマに合わない時で、止める前に読むので止めていない。後者は止めた後に起動コマンドを起こせなかった時
- 返事は停止の猶予 (最長 3 秒) と起動コマンドの待ち (`launch_timeout_seconds` + 猶予) の和まで遅れる。同じ接続の他の依頼は待たせない (2-phase)

### daemon の手順

止めた後に、止める前から分かっていた理由で起動を断ることが無いよう、断る理由は全部止める前に確かめる。

1. user role でなければ `bad_request`。launcher が無ければ `launcher_not_configured`、daemon が終わりかけているか起動が `launch_max_concurrency` 個走っていれば `launch_busy`
2. 本 DR の `session_kill` と同じく、`sessions/<pid>.json` を読み直して sid から pid を引き、ps で claude のプロセスであることを確かめる。通らなければ `not_found`
3. 起動の入力を組み立てて `LaunchInputSchema` で読む。`cwd` は 2 で読んだ record の `cwd` (claude が記録したプロセスの cwd、realpath)。record に `cwd` が無ければ `restart_unavailable` (未検証: EnterWorktree で cwd が変わったセッションで、record の cwd から resume が transcript を見つけられるか)
   - `resume`: その sid
   - `model` / `effort`: Status タブの CONTEXT と同じ値 (hooks module の facts の model / effort を、transcript の末尾の main context の assistant 行の model / effort に重ねたもの) を、起動の入力の選択肢に写す (`claude-fable-5[1m]` → `fable`、Session Search の resume の prefill と同じ写し方)。写せないものと値の無いものは入れない (起動コマンドが決める)
   - `name`: 2 で読んだ record の `name`。無ければ入れない
   - `prompt`: request の `prompt`、無ければ下の既定文
4. 本 DR の 2 連の SIGTERM で止め、猶予 (3 秒) の中でプロセスの消滅を観測するまで待つ (未検証: turn の最中など、止まるまでに 3 秒を超える claude で `restart_timeout` になるか)。観測できなければ `restart_timeout` で終わり、起動しない。同じ transcript を旧プロセスと新プロセスが同時に開かないための順序で、DR-0018 §2.3 (起動の後のプロセスを追わない) の線は越えない。SIGKILL へは上げない (本 DR の原則のまま)
5. 消滅を観測したら `session_kill` と同じくその sid の登録を忘れて peers を配る (resume したセッションは hello か agents の poll で戻る)
6. DR-0018 §3.5 の手順 4〜11 で起動する (依頼者は `user`。daemon.log にはその手順の `session_launch: …` の行も残る)
7. daemon.log に 1 行: `session_restart: session_id=<sid> pid=<pid> terminated=<true|false> [exit_code=<N>] [error=<code>]`

### resume する config dir

claude はセッションの transcript をそのセッションが動いていた config dir (`CLAUDE_CONFIG_DIR`) の下にしか持たない。どの config dir (面) で resume するかは起動コマンドの責務で (cwd の `.envrc` 等から決める、[launch-command](../design/launch-command.md))、daemon は関知しない。daemon は面を比べずに起動コマンドに resume を頼み、webui は面を見ずに restart ボタンを出す (kawaz 2026-11-06)。

### resume の prompt

既定文 (protocol の `RESTART_PROMPT`。request に `prompt` が無い時に daemon が使い、webui の再起動のフォームが最初に入れておく文):

```
プロセス再起動 (resume) しました。teammate/subagentはSendMessage(agentId)で再開可能。workflow等もIDで再開可能。backgroundやcron/scheduleがあれば貼り直し。
```

- 止める前にセッションの cron / schedule の有無を調べて出し分けることはしない (kawaz 2026-10-25)。予定の扱いは resume したセッションに任せる。resume の後に何が残るかの観測は [findings 2026-10-25-cron-schedule-persistence](../findings/2026-10-25-cron-schedule-persistence.md)
- 内容 (会話の中身) には触れない。コンテキストは続く

### webui

- 「再起動」は危険ゾーンの外、その上の「セッション操作」に「新セッションを起動」と並べる (kawaz 2026-11-09)。セッション操作は 1 行 1 操作の一覧 (名前、何をするかの 1 行、右端のボタン) で、ボタン (「起動…」「再起動…」) を押すとその操作のフォームを modal dialog (`ModalDialog`、`showModal()`) で開く。dialog は広い幅では画面中央の箱、600px 以下では全画面で、上の × の代わりに「← 戻る」を出す。タブの中の並びは「新セッションを起動」「再起動」、その下に Background / TODO の畳み ([DR-0020](./DR-0020-session-status-tab.md) Addendum 2026-11-09)、最後に危険ゾーン (「セッションを終了」だけ)。止めずに済む操作を誤爆の危険のある終了ボタンから離し、同じ cwd で起動する 2 つの操作をまとめる。「新セッションを起動」はこのセッションの cwd で `session_launch` を呼ぶフォームで、`--model` / `--effort` の select と prompt だけを持ち、select はセッションが今動いている値 (DR-0041 の通しの上書き、無ければセッション自身の値、無ければ transcript) で始まる ([DR-0018](./DR-0018-session-launcher.md) §3.9)。両方とも `launch_available` の時だけ出し、「再起動」はさらにそのセッションの agents の行がある (プロセスが居る) 時に出す。セッションの config dir は問わない (下の「resume する config dir」)
- どれか 1 つが走っている間 (起動・再起動・終了) は、両フォームの送信と「セッションを終了」を disabled にする。送信が走っている間はその dialog を閉じられない (Escape と × / ← 戻る が効かない)
- 確認ダイアログは出さない (ユーザが理解して押す)。再起動の dialog (kawaz 2026-11-02): textarea 1 つと [デフォルトに保存] [再起動]。textarea には既定文が入っていて (全選択はしない、caret は末尾)、そのまま送っても、書き換えて指示を足してもよい。送った内容が request の `prompt` になる。FAB (composer) は使わない
  - [再起動] は内容が空 (空白だけを含む) なら disabled。Escape か × (狭い幅では ← 戻る) で閉じ、次に開くと既定文から始まる
  - textarea の見た目は composer の textarea (`.session-input-textarea`) と同じで、高さは中身に合わせる (最低 3 行)。送信 ([起動] / [再起動]) はプライマリ (`--accent`)、[デフォルトに保存] は文字だけの弱いボタンで、危険ゾーンの赤は使わない。送信ボタンの左に送信キー (`⌘` `Enter`) を出す (textarea は文が入った状態で開くので、placeholder では見えない)
  - textarea では ⌘+Enter (Ctrl+Enter) でも [再起動] と同じ経路で送る (composer と同じ `shouldSendOnKeyDown` の判定: 素の Enter は改行、IME 確定中は送らない、空白だけと restart 中は送らない、kawaz 2026-11-06)
  - restart が走っている間は dialog の中も全部 disabled で、[再起動] の文言が「再起動中…」になる。resume できたら (起動コマンドが 0 で終わったら) dialog を閉じる。それ以外 (起動コマンドが 0 以外、`restart_timeout`、その他の拒否) は dialog を開いたままにして中にも結果を出し、書いた文を残したまま直して送り直せるようにする (kawaz 2026-11-09)。新セッションの起動も同じで、起動コマンドが 0 で終わったら閉じ、それ以外は開いたまま
- 既定文の保存: [デフォルトに保存] はそのフォームの値 (新セッション: model / effort / prompt、再起動: prompt) を webui の localStorage に **cwd をキー**に保存し (`ccmsg.statusForms.<cwd>`、valibot のスキーマで読み、読めない値は丸ごと無視する)、保存があればフォームを開いた時の初期値になる。保存が無ければ再起動は `RESTART_PROMPT`、新セッションは「準備して待て」。キーを sid にしないのはピン留めと同じ理由で、同じ場所の後継セッションは sid が変わる。daemon は既定を持たない (request の `prompt` を省いた時の `RESTART_PROMPT` は daemon 側の既定のまま)。ボタンはフォームの値が保存済みの値と同じ間「保存済み」になって押せず、それが保存できたことのフィードバックになる
- restart の間はセッションの登録が外れて Status のパネルが一度消えるので (dialog も一緒に消える)、押している状態と結果はセッションの view が持ち、resume したセッションが戻った後のパネルに出す ([findings 2026-10-25-session-restart-verify](../findings/2026-10-25-session-restart-verify.md))
- 結果はセッション操作の一覧の下 (dialog の外) に出し、dialog を閉じても残る。枠の左の色が成否を示す (成功は success、失敗は danger)。文は exit 0 は「再起動しました」、0 以外は「停止したが、起動コマンドが <N> で終わった (resume していない)」と `stdout` / `stderr`、error は `restart_timeout` なら「停止を確認できなかったので起動していない」、それ以外は code と msg

### 却下した代替案

- **webui が `session_kill` → 待ち → `session_launch` を 3 往復する**: 止まったことの観測と起動の順序が webui にあり、途中で接続が切れると止めたまま起動しない状態が残る。断る理由を止める前に揃えて確かめることも webui からはできない (record の cwd は daemon が読む)
- **止める前に cron / schedule の有無を調べ、ある時だけ一文を出す**: 調べない (kawaz 2026-10-25)。正確な一覧は Stop の hook の入力の `session_crons` にしか出ず、module で取るには [DR-0039](./DR-0039-all-mods-and-typed-tools.md) §1 が持たないと決めた `classic.*` の hook が要る
- **猶予を過ぎたら SIGKILL に上げて起動する**: 本 DR の原則 (daemon が自動で不可逆側に倒さない) のまま。止まらなければ `restart_timeout` を返し、人が危険ゾーンの強制終了を選ぶ

### Consequences

- 旧プロセスを載せていた端末 (hyoui 等) はプロセスと一緒に終わり、resume したセッションは起動コマンドが起こす新しい端末に載る
- 起動時に付いていた起動の引数のうち、起動の入力に無いもの (`--settings`、`--plugin-dir`、permission mode 等) は起動コマンドの既定になる。model の文脈の接尾辞 (`[1m]` 等) は起動の入力の選択肢に無いので落ちる
- model の接尾辞の付与は起動コマンドの責務 ([launch-command](../design/launch-command.md) の「加工」)。組み込みの起動コマンドは付けない
- `restart_timeout` の後もプロセスはシグナルを受けて終わることがある。終わればそのセッションの agents の行が消えて restart は出なくなるので、resume は Session Search の resume からする
