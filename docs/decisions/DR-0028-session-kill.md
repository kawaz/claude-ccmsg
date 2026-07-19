# DR-0028: session_kill (完了セッションのプロセス停止)

- Status: Proposed
- Date: 2026-07-18

## Context

webui からセッションを起動できる (DR-0018) 一方、完了したセッションのプロセスを
止める手段が UI に無い。用済みの interactive/background claude プロセスが溜まる。
kawaz 要望 (2026-07-18):

- Status タブ内 (普段触らない場所) に危険色の終了ボタンを置く
- 確認ダイアログを必ず表示
- claude プロセスは終了確認プロンプトのガードがあり、**シグナル 1 発では止まらない
  ことがある → 2 連続送信が必要**
- sessionId → pid は `claude agents` 系で解決できる

観測済み事実: daemon は既に `claude agents --json` を全 `~/.claude*` config dir に
対して定期 poll しており (agents.ts / DR-0009 addendum)、`AgentInfo { pid, sessionId,
cwd, kind, ... }` を webui に配信している。

## Decision

### daemon: 新 op `session_kill` (user role 限定・即時 reply)

- `IDENTITY_OPS` に追加。`conn.identity?.role !== "user"` なら `bad_request` で拒否
  (session_launch と同一パターン)。session role のエージェントが互いを殺せてはいけない。
- pid 解決は **リクエスト時に `claude agents --json --all` を fresh 実行**して
  sessionId → pid を引く (`--all` で completed background も含む)。poller cache
  (最大 5 秒古い) を使わない: kill は stale pid が即誤殺につながる操作なので、
  多少の latency (数百 ms〜) を払って fresh に解決する。全 config dir を走査し、
  最初にマッチした行を採用。見つからなければ `not_found`。
- **pid 実在検証 (pid 再利用ガード)**: 解決した pid に対し
  `ps -p <pid> -o command=` を実行し、コマンドラインに `claude` が含まれることを
  確認してから kill。`claude agents` の応答と kill 実行の間 (および CLI 側 registry
  の stale entry) で pid が別プロセスに再利用されるのを防ぐ。検証不一致は
  `not_found` (「もう居ない」と同じ扱いで十分)。
  - 実装追記 (2026-07-18): 判定は substring でなく **argv[0] の basename が
    `claude` と完全一致**。substring だと kawaz 環境では ccmsg daemon 自身
    (`bun .../.claude-personal/plugins/cache/ccmsg/...`) や Claude Code 起動の
    zsh (`source .../.claude-personal/shell-snapshots/...`) まで通過し、pid
    再利用時に daemon 自殺の経路になる (実測で確認)。
  - 実装追記 (2026-07-18): registry 行の pid は **整数かつ > 1 のみ採用**。
    `kill(0)` は自プロセスグループ全体、負数はグループ送信、1 は init であり、
    腐った registry 行がこれらに到達してはならない。
  - 実装追記 (2026-07-18): シグナル送信・生存確認の errno は **ESRCH のみ
    「消滅」扱い**。EPERM (実在するが権限なし) を消滅扱いすると生存プロセスに
    「終了を確認」と虚偽報告するため、internal エラーとして表面化させる。
- **kill 手順: SIGTERM → 1s 待機 → 生存していれば SIGTERM 再送 → 最大 3s
  消滅確認 → 結果返却**。
  - 2 発目が必要な理由: claude TUI は 1 発目の SIGTERM で「本当に終了するか」の
    確認プロンプト状態に入るガードがあり、2 発目で確定する (kawaz 観測)。
  - 1 発目後の待機は 1s 固定: 短すぎると 1 発目のプロンプト遷移前に 2 発目が
    届いて 1 発扱いになるリスク、長すぎると UI 応答が鈍い。ガード遷移は
    プロセス内イベントで観測不能なため polling (200ms 間隔の `kill(pid, 0)`
    生存確認) が正当な例外 (sloppy-ai-patterns の「polling しか無い外部対象」)。
  - 1 発目の待機中に消滅したら 2 発目は送らない (ガード無し状態、例えば
    background プロセスは 1 発で死ぬ)。
  - 応答は `{ ok: true, terminated: boolean }` — 3s 以内に消滅を観測できたら
    `terminated: true`、2 発送ったが猶予内に消滅を観測できなければ
    `terminated: false` (シグナル送達は成功)。SIGKILL へのエスカレーションは
    しない: transcript flush 等の graceful shutdown を破壊しうる不可逆操作を
    daemon が自動判断しない。必要なら人間が手で殺す。
- 2-phase (acceptTwoPhase) ではなく**通常の即時 reply**: 最悪 ~4s (agents 実行
  + 待機) は translate/launch と同程度だが、kill は結果 (terminated か否か) を
  ボタン押下の直接応答として返すのが UI 上素直で、途中切断時に浮く状態も無い。
  → 実装時に ws の既存 timeout と干渉するなら 2-phase へ変更可 (実装 worker 判断)。
  - 実装追記 (2026-07-18): **2-phase を採用**。通常 reply は「同期 dispatch +
    到着順ペアリング」契約で、非同期 op (fresh agents 実行 + 最大 3s 猶予) の
    deferred reply は同一接続の後続 reply を全て desync させるため、即時 reply は
    構造的に不可能 (translate/session_launch が 2-phase 化されたのと同じ理由)。

### webui: Status タブ最下部に危険ゾーン

- `StatusPanel` 最下部 (TeamsSection の後) に「セッションを終了」ボタン。
  `--danger` 色 (app.css 既存変数)。
- 確認は既存パターンに合わせ `window.confirm()` (MemberChip.tsx の kick と同型)。
  カスタムダイアログを新設しない: 誤爆防止が目的で、体験の質は kick と同水準で足りる。
- 実行中は disabled + 結果を近傍に表示 (terminated / not_found / エラー)。

## Alternatives Considered

- **poller cache から pid を引く**: 実行コストゼロだが最大 5s stale。kill は
  誤対象が致命的なので不採用 (fresh 実行 + ps 検証の二重ガードを採る)。
- **SIGKILL エスカレーション付き 3 段 kill**: 確実に死ぬが、claude の graceful
  shutdown (transcript/state flush) を破壊するリスク。daemon が自動で不可逆側に
  倒すべきでない。不採用、`terminated: false` を返して人間に委ねる。
- **cache の AgentInfo を webui から pid ごと送らせる (`pid` をリクエストに含める)**:
  クライアント申告の pid を殺すのは権限モデル上危険 (user role 限定とはいえ、
  daemon 側解決に比べ検証根拠が弱い)。リクエストは `session_id` のみ受ける。
- **kick 同様に Sidebar/SessionList へボタン設置**: 目立つ場所は誤爆リスク。
  kawaz 指定の「普段触らない Status タブ内」を採用。
- **確認ダイアログをカスタム UI で新設**: リッチだが新規パターン導入のコストに
  見合わない。既存 `window.confirm` 慣習 (MemberChip) に合わせる。

## Consequences

- daemon に「他プロセスへシグナルを送る」能力が初めて入る。誤殺ガードは
  (1) user role 限定 (2) daemon 側での fresh pid 解決 (3) ps コマンドライン検証
  の 3 層。それでも理論上の TOCTOU 窓 (ps 検証〜kill の間) は残る — pid 再利用が
  その数 ms で起きる確率は実用上無視できると判断。
- `terminated: false` 応答があり得る (ガードが 2 発で突破できない将来の CLI 変更
  等)。UI はこれを失敗でなく「シグナル送信済み・未確認」として表示する。
- テストで実プロセスを殺す必要がある。検証コマンド (`claude agents` 実行と
  `ps` 検証) を injectable にして、sleep 子プロセスで kill 経路を実テストする
  (設計は実装指示書側)。

## 関連

- [DR-0018](./DR-0018-session-launcher.md) — session_launch (user 限定 op の先行例)
- [DR-0009](./DR-0009-session-transcript-access.md) — agents poll の出自
- [DR-0012](./DR-0012-room-archive-and-kick.md) — kick (確認 confirm の既存 UI 慣習)

## Addendum: opt-in SIGKILL エスカレーション (kawaz r38 mid=6, 2026-07-19)

現行の SIGTERM 2 連発では TUI が確認 guard から動かないケースが実運用で
発生する ("セッション終了が効かないことが結構ある" — kawaz)。当初却下した
`SIGKILL` 経路を、**daemon が自動で選ばず、ユーザーが opt-in する形**で解禁する。

### 追加分の契約

- `SessionKillRequest.force?: boolean` を追加。true の時のみ SIGKILL 経路。
  fresh sid→pid 解決と ps コマンドライン検証 (pid-reuse guard) は force でも
  そのまま通す — 検証を短絡すると誤殺リスクが上がるだけで得るものが無い
- 経路: `killSessionForce(pid, deps)` — SIGKILL を 1 発、以降は通常経路と
  同じ liveness poll。落ちたら `terminated: true`、SIGKILL 後も観測される
  (uninterruptible sleep 等の zombie) 場合は `terminated: false` を正直に返す
- webui: 「セッションを終了」で `terminated: false` を観測したら、ボタンが
  「強制終了 (-KILL)」に変化 (背景色 danger 反転 + 太字)。再度押すと SIGKILL、
  confirm 文言に「不可逆 / transcript flush が途中で切れる可能性」を明記して
  もう 1 段のガードを掛ける

### 却下した代替案 (再検討)

- **原案通り SIGKILL を認めない**: 実運用で 2 発 SIGTERM に耐える TUI 挙動が
  観測されており、UI が「シグナル送信済み・未確認」を表示するだけでユーザー
  は次の手を打てない (daemon 側に手段が無いため kill -9 を shell で打つ必要
  がある)。opt-in 明示 + 2 段確認 (通常押下 → force ボタン化 → confirm) で、
  「daemon が自動で不可逆側に倒す」原則は保ちつつ、ユーザーの明示的意思で
  最終手段が届く形に緩和する
- **daemon 側で自動エスカレーション** (SIGTERM 失敗後に SIGKILL): 原案の
  却下理由がそのまま生きる (transcript/state flush を破壊するのは自動化して
  よい判断ではない)。継続不採用
