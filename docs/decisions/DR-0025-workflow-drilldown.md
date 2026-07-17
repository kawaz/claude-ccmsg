# DR-0025: workflow / teammate の掘り下げ UI (Status からエージェント TL まで潜る)

Status: Proposed
Date: 2026-07-17
Sponsor: kawaz r26 mid=109 (TUI スクショ 4 枚付き)

## 1. 背景

Status タブの workflow 表示は現状トップ (名前と走行/完了) だけ。TUI は:

- **フェーズ設計の一覧** (Phases: Implement 1/1 → Verify 0/1 の進捗)
- **フェーズ内エージェント一覧** (完了 ✓ / 作業中 / pending、モデル・トークン数付き、5/8 型の集計)
- **エージェント選択で概要表示** (label / model / state / tokens / 最終ツール等)

を提供している。エージェント実体はローカルの jsonl
(`~/.claude-personal/projects/<proj>/<sid>/subagents/workflows/<run>/agent-*.jsonl` +
`agent-*.meta.json`、journal.jsonl) にあるので、daemon がこれを読めば webui でも同等 +
**エージェントの TL 閲覧まで**掘れる (kawaz)。teammate も同様に選択で当人の TL を見たい
(TUI の「TL 切替 + 指示」のうち、指示送信は Monitor が立っていない subagent には届かない
ため今回スコープ外 — kawaz 明示)。

## 2. スコープ

### 2.1 やること

- **daemon**: session_status の workflow エントリを拡張 — 各 workflow の phases
  (title / 完了数 / 総数) と agents (label / model / state / tokens / phase) を
  transcript + workflow ディレクトリ (journal.jsonl / agent-*.meta.json) から fold
- **daemon**: エージェント / teammate の transcript 読み出し — 仮想 session の既存機構
  (DR-0021 SS-Q1=a) を agent jsonl のパス解決に拡張 (uuid でなく agentId 形式のため
  別 resolver。containment は projects/ 配下限定を踏襲)
- **webui Status タブ**: workflow を展開すると Phases + エージェント一覧 (✓/走行/pending、
  n/m 集計)。エージェント選択で概要 + 「TL を見る」→ Timeline ビュー (仮想 session と
  同じ transcript 表示経路)
- **webui teammate**: Teams セクションの teammate 選択で当人 TL 閲覧 (同経路)

### 2.2 やらないこと

- subagent / teammate への指示送信 (Monitor なしには届かない — kawaz 明示で今回対象外)
- TUI 同等の完全なリアルタイム進捗 (fold の逐次 push 粒度で十分)

## 3. Phase 分割

| Phase | スコープ |
|---|---|
| Phase 1 | daemon: workflow ディレクトリ fold (phases/agents) + agent transcript resolver |
| Phase 2 | webui: Status の掘り下げ UI + エージェント/teammate TL 閲覧 |

## 4. 関連

- kawaz r26 mid=109 (要件 + TUI スクショ)
- DR-0020 (session_status fold) / DR-0021 (仮想 session 読み出し) — 拡張元
