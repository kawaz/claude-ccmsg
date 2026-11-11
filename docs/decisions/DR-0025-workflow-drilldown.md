# DR-0025: workflow / subagent / teammate の掘り下げ (Timeline の agent tree から各 agent の TL を読む)

- Status: Accepted (2026-11-11、kawaz 裁定) — ✅ 実装済み (daemon: session_status の `workflows[]` の `run_id` / `phases` / `agents` と `agent_tree`、transcript_read の `agent_id` / `run_id` / `teammate`。webui: Timeline の agent tree、agent の TL とその URL、Timeline の 🤖 カードの名前から agent の TL へのリンク)
- Date: 2026-07-17

## Context

セッションが起こした workflow / subagent / teammate は、セッション自身の transcript には tool call (Workflow / Agent) として 1 行ずつしか現れない。進み具合と会話は Claude Code がセッションの transcript の隣に別のファイルとして書く。

```
<projDir>/<sid>.jsonl                                         # セッション自身
<projDir>/<sid>/subagents/agent-<agentId>.jsonl               # subagent / teammate の会話
<projDir>/<sid>/subagents/agent-<agentId>.meta.json           # その起動の記録 (agentType / name / taskKind / toolUseId / spawnDepth / model …)
<projDir>/<sid>/subagents/workflows/<runId>/agent-<agentId>.jsonl
<projDir>/<sid>/subagents/workflows/<runId>/agent-<agentId>.meta.json
<projDir>/<sid>/subagents/workflows/<runId>/journal.jsonl     # run の間に書かれる (agent の開始と戻り)
<projDir>/<sid>/workflows/<runId>.json                        # run が終わった時に書かれる state (宣言した phase と各 agent の進捗)
```

TUI はこれを元に workflow の phase の進み (`Implement 1/1 → Verify 0/1`)、phase ごとの agent の一覧 (完了 / 作業中、model・token 数) を出している (kawaz、TUI のスクショ付きの要望)。webui でも同じものを見られ、さらに各 agent の会話を TL として読めるようにする。

増やしたくないもの:

- **クライアントが渡すパス**。agent の transcript を読む口にパスを渡させると traversal の面が生まれる。DR-0009 の transcript_read と同じく、daemon が自分で解決したファイルしか読まない
- **掘り下げ専用の購読・push の経路**。掘り下げの情報はセッションの status (DR-0020) の snapshot に載せ、その push に相乗りする

## Decision

### 1. workflow の phases / agents (session_status の `workflows[]`)

- fold は Workflow tool の結果の `runId` を `RUN_ID_RE` (`^wf_[0-9a-f]{8}-[0-9a-f]{3}$`) で確かめ、合う時だけ workflow の項目の `run_id` に入れる。transcript の行はエージェントが書ける入力で、`run_id` は後でファイルのパスに入るため。合わなければ `run_id` は無く、その workflow の掘り下げも無い
- snapshot を作るたびに、`run_id` のある各 workflow について次の順で読む (`readWorkflowDrilldown`)
  1. `<sid>/workflows/<runId>.json` (run の state) があれば、それだけから畳む
     - `phases`: 宣言された `phases` の title を 1 始まりの順で並べ、`workflowProgress` の `workflow_phase` で宣言に無い index を補う。title が空の phase は出さない
     - `agents`: `workflowProgress` の `workflow_agent` のうち `agentId` のあるもの (始まらなかった agent は id を持たないので出さない)
     - 各 phase の `done` / `total` は、その phase の index を `phase_index` に持つ agent の数 (`done` は state が `done` のもの)。`phase_index` の無い agent はどの phase にも数えない
  2. state が無ければ (run の途中) `<sid>/subagents/workflows/<runId>/journal.jsonl` を畳む
     - agent ごとに、`result` の行があれば `done` (複数あれば後の `result` が勝つ)、`started` の行だけなら `running`。`result` が文字列ならその先頭 200 文字を `result_preview` にする
     - `agent_type` は同じディレクトリの `agent-<agentId>.meta.json` の `agentType`
     - journal は phase を書かないので `phases` は出さない
- 読めないファイル、スキーマに合わないファイルは無いものとして扱う (journal は行ごと)。その workflow の `phases` / `agents` が欠けるだけで、workflow の項目は残る
- 読んだ結果はパスごとに memo し、そのパスの mtime・size・ino の 3 つが変わらない間は読み直さない。終わった run の state は二度と変わらず、journal は agent が始まる・戻る時にしか伸びない
- live でないセッションも、session_status の 1 回の走査 (DR-0020 §3.1) で同じものを載せる
- push の契機は増やさない。workflow や agent のファイルが変わっただけでは push せず、セッションの status の push (DR-0020 §3.1) のたびに読み直す

### 2. agent tree (session_status の `agent_tree`)

- `<sid>/subagents/agent-*.meta.json` と `<sid>/subagents/workflows/<runId>/agent-*.meta.json` (`<runId>` が `RUN_ID_RE` に合うディレクトリだけ) の 1 件が 1 ノード。`agent_id` はファイル名の `agent-` と `.meta.json` の間
- ノードを 3 つの群に分ける
  - `teammates`: meta.json の `taskKind` が `in_process_teammate` のもの。`teammate_name` に meta.json の `name` を持つ
  - `agents`: `subagents/` 直下のそれ以外。meta.json の `toolUseId` を、セッション自身と `subagents/` 直下の全ノード (teammate を含む) の transcript の `Agent` の tool_use の id と突き合わせて親を決め、子は親の `children` に入れる。workflow の member の transcript は親の探し先にしない。親の transcript が見つからないノードは最上段に置く (消さずに辿れるようにする)。深さは最上段を 0 として 5 まで、それより深い子は落とす。各段は `last_activity_ms` の新しい順
  - `workflows`: run ごとの群。`workflow_id`、run 全体の `done` / `total`、`phases` (`index` / `title` / `done` / `total` / `members`)、`unassigned`、`last_activity_ms` を持つ
    - phase の `index` は §1 で phase を並べる時の元の index (宣言の順、または `workflow_phase` の index) で、並び順で振り直さない。title と `done` / `total` も §1 のもの
    - member は自分の `phase_index` と同じ index の phase に入る。`phase_index` が無いか、同じ index の phase が無ければ `unassigned` に入る
    - run の `done` / `total` は、`phases` がある時は各 phase の `done` / `total` の合計。どの phase にも数えられない agent (`phase_index` が無い、title のある phase に当たらない) は入らないので、run の agent の数と合わないことがある
    - `phases` が無い run (state がまだ無い) は全 member が `unassigned` で、`total` は member の数、`done` は state が `done` の member の数
- ノードの `state` (推定、open set)
  - 最上段の teammate (meta.json に `name` のあるもの) は fold の teammates のその名前の state で、fold に無ければ `unknown`。`name` の無い teammate は次の subagent の規則で決まる
  - 最上段の subagent は fold の background (Agent) の state (`running` は `active`)。fold に無い最上段の subagent は、transcript の mtime が 2 分以内なら `active`、それより古ければ `unknown`
  - 深い段は transcript の mtime が 2 分以内なら `active`、それより古ければ `stopped`
  - workflow の member は §1 の掘り下げの state、無ければ深い段と同じ mtime の推定
- `last_activity_ms` は `agent-<agentId>.jsonl` の mtime (無ければ meta.json の mtime)。ノードの `name` / `running_model` / `effort` は DR-0020 Addendum 2026-11-06
- `subagents/` が無いか、3 つの群がどれも空なら `agent_tree` を載せない

### 3. wire の形

| どこ | field / 引数 | 中身 |
|---|---|---|
| session_status `workflows[]` | `run_id` | §1 で確かめた `wf_XXXXXXXX-XXX` |
| 同 | `phases[]` | `{ title, done, total }`。run の state がある時だけ |
| 同 | `agents[]` | `{ agent_id, state, label?, model?, agent_type?, tokens?, tool_calls?, phase_index?, phase_title?, last_tool?, result_preview?, error?, started_at?, duration_ms? }`。`state` は state 由来の `done` / `error` / `progress` と journal 由来の `running` (open set)。`last_tool` は `<lastToolName>: <lastToolSummary>` (片方だけならそれ) |
| session_status | `agent_tree` | `{ teammates[], agents[], workflows[] }` (§2)。ノードは `AgentTreeNode` (`agent_id` / `kind` (`teammate` / `subagent` / `workflow_member`) / `state` / `spawn_depth` / `children` / `teammate_name?` / `workflow_id?` / `last_activity_ms?`、meta.json 由来の `name?` / `agent_type?` / `description?` / `color?` / `model?` / `team_name?`、agent の transcript の末尾から読む `running_model?` / `effort?` (DR-0020 Addendum 2026-11-06)) |
| transcript_read | `agent_id` / `run_id` / `teammate` | §4。`before` / `after` / `max_bytes` と併せて使う |

### 4. agent の transcript を読む (transcript_read)

- transcript_read (DR-0009 §3) に `agent_id` / `run_id` / `teammate` を渡すと、`sid` のセッション自身の transcript の代わりに、その隣の agent の transcript を同じ byte offset の paging で読む
  - `agent_id` だけ: `<sid>/subagents/agent-<agent_id>.jsonl` (subagent、teammate)
  - `agent_id` と `run_id`: `<sid>/subagents/workflows/<run_id>/agent-<agent_id>.jsonl` (workflow の agent)
  - `teammate`: `<sid>/subagents/agent-*.meta.json` のうち `taskKind` が `in_process_teammate` で `name` が一致するものの隣の `.jsonl`。複数あれば mtime の新しいもの。transcript 側の teammate の id は `name@team` でファイル名にならないので、名前で meta.json を引く
- user role だけ。他の role がこの 3 つのどれかを付けると `bad_request`。セッション (AI) が自分の agent の transcript を読む用途は無く、webui の閲覧の機能であるため (`agents` / `transcript_subscribe` の role の制限と同じ)
- `sid` はまずセッションの transcript として解決する。user role なので過去のセッション (DR-0021 §3 の仮想 session) の agent も読める
- error
  - `invalid_args`: `agent_id` と `teammate` の両方、どちらも無い、`agent_id` の無い `run_id`、§5 の形に合わない値
  - `not_found`: `<sid>` のディレクトリが無い、ファイルが無い・通常のファイルでない、名前の合う teammate が無い
  - `path_forbidden`: §5 の範囲の検査に外れた
- agent の transcript の購読は無い。`transcript_subscribe` はセッション自身の transcript だけを追う

### 5. 読んでよい範囲 (traversal を防ぐ検査)

- クライアントが渡すのは id だけで、パスは渡さない。id は `path.join` に入る前に正規表現で確かめ、合わなければ `invalid_args`。3 つとも `/` `\` `.` NUL 空白を含められないので、組み立てたパスはディレクトリの外に出られない
  - `agent_id`: `AGENT_ID_RE` = `^a[A-Za-z0-9_-]{5,120}$`
  - `run_id`: `RUN_ID_RE` = `^wf_[0-9a-f]{8}-[0-9a-f]{3}$` (大文字の hex は通さない)
  - `teammate`: `TEAMMATE_NAME_RE` = `^[A-Za-z0-9_-]{1,64}$`
- 起点は daemon が解決したセッションの transcript (DR-0009 §2 の hello で確かめたもの、または DR-0021 の仮想 session の resolver が返したもの) から `.jsonl` を除いたディレクトリ。これを realpath し、その 2 つ上のディレクトリの名前が `projects` でなければ `path_forbidden`
- 読むのは `<sid>` のディレクトリ (realpath したもの) の下にあるものだけ
  - 途中のディレクトリ (`subagents/`、`subagents/workflows/`、`subagents/workflows/<runId>/`、`workflows/`) は symlink も解決して、実体が `<sid>` のディレクトリの下にあることを確かめる (ファイルのブラウズと同じ realpath の検査)。`<sid>` の中を指すディレクトリの symlink は辿る
  - 読むファイルは、そのディレクトリの中の symlink でない通常のファイルに限る (`lstat`)。ファイルの symlink は `<sid>` の中を指していても読まない。ファイルは agent の数だけあり、status の push のたびに読むので、ディレクトリの一覧が返す種類だけで判定して realpath を足さない
  - transcript_read は、途中のディレクトリの実体が `<sid>` の外 (解決できない時も) なら `path_forbidden`、ディレクトリやファイルが無い・ファイルが通常のファイルでないなら `not_found`。teammate の解決 (meta.json の走査とその隣の `.jsonl`) も同じ範囲に収める
  - session_status (§1 / §2)、過去のセッションの通知の一覧、dump の agent の一覧は、範囲の外のものを無いものとして扱う
- session_status 側も、`run_id` は §1 の fold で、agent tree が入る run のディレクトリ名は §2 で、同じ `RUN_ID_RE` を通してからパスに使う。journal の行の `agentId` は `AGENT_ID_RE` に合う時だけ meta.json のパスに使う

### 6. webui の入口: Timeline の agent tree

- 入口は Timeline タブの左ペインの agent tree (`AgentTreePanel`) と、Timeline の 🤖 カードの名前。Status タブには掘り下げの入口を置かない (DR-0020 Addendum 2026-11-09)
- agent tree は `agent_tree` にノードが 1 つ以上ある時だけ出る。先頭はセッション自身の TL へ戻る `main` の行で、その下に Teammates / Agents / Workflows の群。Teammates / Agents の行と state ごとの区画は DR-0020 Addendum 2026-11-06
- Workflows
  - run は `total` が 0 か `done < total` なら走行中として並べ、それ以外は「完了 (N)」に畳む (既定で閉)
  - run の行は `workflow_id`、`done/total` (全部終わっていれば頭に ✓)、配下の error の数。開くと phase の行 (`index`、title、`done/total`) が並び、member の無い `total` 0 の phase は淡色で開けない。`unassigned` は「(phase 未確定)」の下に並ぶ。run と phase は既定で閉
  - member の行はノードの見出し (下記)、model (agent tree のノードの model / effort、無ければ §1 の `agents` の `model`)、`tokens` (`12k tok`)、§1 の state
  - pause と resume で同じ run が複数の Workflow の結果を持つ時は、`run_id` ごとに 1 つにまとめて読む
- 各ノードの行に出る見出しは `teammate_name`、無ければ `description`、無ければ `agent_type`、無ければ `agent_id`。見出しはその agent の TL へのリンクで、teammate は名前、workflow の member は `agent_id` と `workflow_id`、それ以外は `agent_id` で指す (§7)。開いている agent の行は強調される
- Timeline の 🤖 カード (開いた時のヘッダ) の名前は、teammate なら名前で、workflow の agent なら §1 の `agents` の `label` で引いて、その TL へのリンクにする。teammate の名前と重なる label、複数の agent に同じ label があるものはリンクにしない。同じ run の重複した項目 (pause と resume) は `run_id` で 1 つにまとめてから数える
- agent の TL はセッションの TL と同じ部品で描き、全ての transcript_read に §4 の引数を付ける
  - 上に「agent: <識別子>」と「親セッションへ戻る」のリンクを出す。識別子は teammate なら `teammate <name>`、workflow の agent なら `<runId>/<agentId>`、それ以外は `<agentId>`
  - live の push が無いので、TL を開いた時、別のセッションの表示からそのセッションへ戻った時、再接続した時に、読み込み済みの末尾から `after` で追いつく。同じセッションの中で別のタブから Timeline タブへ戻っただけでは追いつかない。「更新」は末尾を読み直す
  - 開く agent が変わると、そのセッションの TL の読み込み済みの内容を捨てて読み直す
  - Timeline のツールバーの 🔔 / 🔐 と `filter` は出さない。数えているのは main thread の未読で、agent の TL にはその種類のバブルが無い (DR-0050 §3)
  - TL の位置の選択と、位置を使う吹き出しの dump のメニューは出さない。§7 のとおり agent の TL の URL は位置を持てない

### 7. URL

| path | 画面 |
|---|---|
| `/s/<sid>/timeline/agent/tm/<name>` | teammate の TL |
| `/s/<sid>/timeline/agent/sub/<agentId>` | subagent の TL |
| `/s/<sid>/timeline/agent/wf/<runId>/<agentId>` | workflow の agent の TL |

- 各 segment は URL エンコードする。agent の TL の位置は常に `head` で、URL に位置は載らない。`?filter=` は読まない
- URL の文法の正本は [webui-url-grammar](../design/webui-url-grammar.md)

### 8. 扱わないこと

- **agent への入力**: 走行中の subagent に文脈を足すのは DR-0039 §6 の責務 (セッションの入力欄の宛先の select。`agent_id` で指す TL (subagent / workflow の agent) を開いている間は、その agent を選んだ状態で開く。teammate の TL (`tm/<name>`) は `agent_id` を持たないので、宛先は main のまま)。本 DR の TL は読むだけ
- **agent の transcript の live 追従**: daemon は agent の transcript の購読を持たない (§4)。進み具合はセッションの status の push (§1) の粒度で足り、TL は §6 の追いつきと「更新」で最新にする
- **agent の say と許可依頼の集計**: agent の transcript から say を拾って親のセッションの未読に数える、通知の一覧を作るのは DR-0050 の責務

## Alternatives Considered

- 深い段の agent の生存を、agent の transcript の末尾の完了の行で判定する
  - 不採用理由: subagent は決まった「終わった」の行を書かない (親の Agent の tool_result が畳まれた時に終わる) ので、取りこぼす
- 深い段の agent の生存を、queue-operation の task-notification で判定する
  - 不採用理由: セッション自身の transcript が持つのは直下の子の分だけで、深い段を覆えない。§2 は transcript の mtime で推定する
- 掘り下げを transcript の行ごとに畳む
  - 不採用理由: run の state と journal、meta.json は transcript の行と無関係に書かれるので、行の fold では遅れて現れたファイルを取りこぼす。§1 / §2 は snapshot を作るたびに読む

## Consequences

- 走行中の workflow は phase が分からない (journal が phase を書かない)。agent tree では member が全員「(phase 未確定)」に並び、run が終わって state が書かれると phase ごとに並ぶ
- 深い段の agent の state は推定で、出力の無い長い tool call の間は 2 分で `stopped` に見える
- agent の TL は live に伸びない。§6 の追いつきの契機 (開いた時、別のセッションから戻った時、再接続した時) か「更新」までは、その後の行は出ない
- agent と TL の位置を同時に URL で表せない。agent の TL では位置の選択と、位置を使う吹き出しの dump のメニューを出さない
- `agents[]` は webui が出さない field (`tool_calls` / `last_tool` / `result_preview` / `error` / `started_at` / `duration_ms` / `phase_title`) も運ぶ
- snapshot ごとに次を読む。ファイルごとの memo (mtime・size・ino) で、変わっていない内容は読み直さない
  - `readWorkflowDrilldown` を、`workflows[]` の `run_id` のある項目ごとに 1 回と、agent tree の run の群ごとに 1 回 (両方に現れる run は 2 回以上読まれる)。そのたびに state か journal と meta.json
  - agent の数だけ meta.json と transcript の末尾 (DR-0020 Addendum 2026-11-06)
  - 親を決めるために、セッション自身と `subagents/` 直下の各ノードの transcript の `Agent` の tool_use の id。ファイルごとに読み終えた offset を覚え、前回から伸びた分だけを読む

## 関連

- [DR-0009](./DR-0009-session-transcript-access.md) — transcript_read。本 DR §4 はその読み出しの先を agent の transcript に広げる
- [DR-0020](./DR-0020-session-status-tab.md) — session_status の fold と push (§3.1)、agent tree のノードと行 (Addendum 2026-11-06)、Status タブの中身 (Addendum 2026-11-09)
- [DR-0021](./DR-0021-session-search.md) — 過去のセッションの仮想 session の読み出し (§3)
- [DR-0039](./DR-0039-all-mods-and-typed-tools.md) — 走行中の subagent への直送 (§6)
- [DR-0050](./DR-0050-timeline-notification-badges.md) — agent の say の集計、agent の TL でツールバーの 🔔 / 🔐 を出さないこと
- [webui-url-grammar](../design/webui-url-grammar.md) — agent の TL の URL
