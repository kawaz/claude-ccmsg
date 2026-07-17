# transcript 上の agent-teams / context usage の実形観測

Status タブ拡張 (teams セクション + context 使用率、issue
`2026-07-17-status-teams-section` / `2026-07-17-status-context-usage`) の
実装前提として、`~/.claude-personal/projects/` 配下の実 transcript jsonl で
各イベントの実形を観測した記録。

## 判明した事実

### context usage (assistant 行)

- 各 `type:"assistant"` 行の `message.usage` に `input_tokens` /
  `cache_read_input_tokens` / `cache_creation_input_tokens` があり、3 値の
  合算が現在のメインコンテキストサイズに一致する (出力 token は含めない)
- `message.model` は生のモデル ID (例 `claude-fable-5`)。**起動時の `[1m]`
  サフィックスは transcript に載らない** (fable 5 `[1m]` 起動セッションでも
  `claude-fable-5` のみ)。分母 200k/1M は model 名から直接判別不能 →
  観測値 > 200k を 1M の証拠とする推定に切替
- `model:"<synthetic>"` の assistant 行が存在し usage は全ゼロ (harness 行)。
  context として採用しない
- メイン transcript の assistant 行は全て `isSidechain:false` を持つ
  (591/591、cache-warden teams セッション)。`isSidechain:true` ガードは
  防御的に維持
- **compaction 跨ぎ**: 同一 jsonl 内で合算値が 905,628 → 42,974 に減少する
  実例を確認 (authsock-warden 6b987ebe、isCompactSummary 行の直後)。直近値
  上書きで自然追従する
- **/clear 跨ぎ**: `<command-name>/clear</command-name>` を含む user 行の後、
  同一 jsonl で最初の assistant usage が小さい値 (71,911) に戻る実例を確認
  (cache-warden 31a761ca)

### Agent teams (spawn / SendMessage / relay / stop)

- **spawn**: `Agent` tool_use の input に `name` (teammate 名) +
  `subagent_type`。result (`toolUseResult`) は
  `{status:"teammate_spawned", teammate_id:"<name>@session-<sid8>",
  agent_id, agent_type, model, name, color, team_name, ...}`。
  `run_in_background` は無くても teams spawn になる (foreground 型)
- **SendMessage**: input `{to:"<name>", summary, message}`。旧 API 形
  (`{recipient, type:"message"}`) が 2026-02 期の transcript に存在するが
  現行形は `to`。result は `{success:true, message, msg_id,
  routing:{sender, target:"@<name>", targetColor, ...}}`
- **relay 受信**: `type:"user"` 行の `message.content` (**string**、1241 件
  全て string で array 形は 0) が
  `Another Claude session sent a message:\n<teammate-message
  teammate_id="<name>" color="..." summary="...">本文</teammate-message>...`
  の形。**1 行に複数 `<teammate-message>` が連結される**実例あり。
  idle 通知は本文が `{"type":"idle_notification",...}` の JSON
- `teammate_id="system"` はライフサイクル通知
  (`{"type":"teammate_terminated","message":"X has shut down."}`) の
  送り主ラベルで teammate 名ではない (2026-02〜03 期に観測、現行形式でも
  除外ガードが必要)
- prefix 無しで `<teammate-message` から直接始まる旧形式 relay は
  2026-02〜03 期のみ。現行 (2026-07) は全件 prefix 付き
- **teammate の停止**: `TaskStop` input `{task_id:"<teammate名>"}`、result
  `{task_type:"in_process_teammate", task_id:"<内部id>", message, command}`
  (kuu 03bdcffd、2026-07-17)。teammate 名は input 側にしか無い

## 実用的な示唆

- teams の生死は TUI 内部状態で transcript から直接観測できない。
  spawn / send / receive / stop の「最後に観測した活動」ベースの推定に
  とどめ、UI にその旨を明示する (issue の制約通り)
- 1M 上限の判別は「観測値が 200k を超えた」ことの証拠ベース推定のみ可能。
  200k 以下で走る 1M セッションは 200k と表示される (推定明示で許容)

## 検証の詳細

観測に使った代表 transcript:

| 対象 | ファイル |
|---|---|
| teams (opus47 主導、12 teammates) | `projects/...cache-warden-main/45630971-*.jsonl` |
| teams (fable 主導、27 teammates + TaskStop) | `projects/...kuu-main/03bdcffd-*.jsonl` |
| compaction 減少 | `projects/...authsock-warden-main/6b987ebe-*.jsonl` |
| /clear 同一 jsonl 継続 | `projects/...cache-warden-main/31a761ca-*.jsonl` |
| 自 SID context (fable[1m]) | `projects/...claude-ccmsg-main/bbc718cd-*.jsonl` |

fold 実装 (`packages/daemon/src/session-status.ts`) を実 daemon 経由で上記
transcript に適用し、jq 手計算 (直近 assistant 行の 3 値合算) と
`session_status` op の返す `context.tokens` の一致、teammate 一覧の抽出を
確認済み。詳細な期待値はテスト
(`packages/daemon/test/session-status.test.ts`) にコメント付きで凍結。
