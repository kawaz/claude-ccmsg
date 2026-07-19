# task-notification truncation 実測 (Monitor 経由 subscribe wire の切断閾値)

daemon の subscribe wire が Claude Code の Monitor tool 経由で
`<task-notification>` にラップされて受信 AI に届く際、harness が末尾を
truncate する事象の閾値サンプリング記録。orderedMsgFrame の予測遮断
(`WIRE_MSG_SAFE_BYTES`) の根拠となる。

## 判明した事実

### 実測: `<event>` 本文長の分布

`~/.claude-personal/projects/**/*.jsonl` (11,090 files) を走査し、
`<task-notification>` 内の `<event>...(truncated)</event>` 末尾切断が
起きているケースを 140 件抽出。event 本文 (= `<event>` 直後から
`...(truncated)</event>` 直前までの char 数) の分布:

| percentile | 値 (chars) |
|------------|-----------|
| min        | 0         |
| p10        | 500       |
| p25        | 500       |
| p50        | 1565      |
| p75        | 3019      |
| p90        | 3019      |
| p95        | 3019      |
| p99        | 4111      |
| max        | 5385      |

**最頻値の2クラスタ**:

- **500 chars 系** (43 サンプル): 事実上 500 で打ち切り (500 ちょうどが 43件、
  501/506/512 も少数)。Monitor stdout 行の default 切断と推定
- **3019 chars 系** (50 サンプル): 3019 ちょうどが 50件、3001/3007 が少数。
  別 Monitor mode (task-notification body の総量 cap) と推定

### version 別の傾向

Claude Code 側 (session `version` フィールド) との対応:

| Claude version | n  | min   | p50   | max   |
|----------------|----|-------|-------|-------|
| 2.1.185        | 25 | 3019  | 3019  | 3019  |
| 2.1.205        | 1  | 1508  | 1508  | 1508  |
| 2.1.207        | 18 | 500   | 500   | 3007  |
| 2.1.209        | 16 | 500   | 500   | 3001  |
| 2.1.211        | 8  | 35    | 2024  | 5385  |
| 2.1.212        | 1  | 3001  | 3001  | 3001  |
| 2.1.215        | 1  | 0     | 0     | 0     |

**両クラスタが同一 version 内でも共存**する (2.1.207/209 等)。単純な
version bump による cap 変更ではなく、Monitor の内部 mode 差 (event stream
vs task-completed status 等) と思われる。

### 全文 (`<task-notification>...</task-notification>`) 長

body cap を含めた notification 全体の長さは、500-body cluster で ~779-786
chars、3019-body cluster で ~3326 chars。`<task-notification>` の tag +
`<task-id>` / `<summary>` / `<event>` 前後の wrapper が固定で ~280-307 chars
のオーバーヘッドを占める。

## 実用的な示唆

- **予測遮断の基準を 500-cluster に合わせる**: 両モードが並存する以上、
  安全側 = 小さい cap を基準にすべき。kawaz r34 mid=18 の実観測 (最近の
  Claude Code version) も 500-body 帯で切られている
- **80% を safe budget として `WIRE_MSG_SAFE_BYTES=400` をデフォルトに**:
  serialized JSON frame (`{"type":"msg","mid":N,"from":"aN","ts":"...",
  "r":"rN","seq":M,"reply_via":"Use `ccmsg reply rNmM <msg>`","msg":"..."}`) の長さが 400 byte を
  超えたら msg 本文を preview + `ccmsg read` 案内に差し替える (実装:
  packages/daemon/src/server.ts の `orderedMsgFrame`)
- **env override**: 環境差 (Claude Code version 上げで cap 変動) を
  `CCMSG_WIRE_MSG_SAFE_BYTES` で調整できるようにする。将来 harness cap を
  実測しなおして緩められたらデフォルト自体を上げる
- **preview には room / mid を必ず含める**: 受信 AI が自動で
  `ccmsg read rNmN` を叩ける形式にする。これが本タスクの主目的
  (往復削減)

## 検証の詳細

### 抽出クエリ

```python
import json, re, glob
files = glob.glob("/Users/kawaz/.claude-personal/projects/**/*.jsonl", recursive=True)
ev_lens = []
for p in files:
    for line in open(p):
        if 'truncated)</event>' not in line: continue
        obj = json.loads(line)
        stack=[obj]
        while stack:
            v=stack.pop()
            if isinstance(v,str):
                if '<task-notification>' in v and '...(truncated)</event>' in v:
                    m = re.search(r'<event>(.*?)\.\.\.\(truncated\)</event>', v, re.DOTALL)
                    if m: ev_lens.append(len(m.group(1)))
            elif isinstance(v,list): stack.extend(v)
            elif isinstance(v,dict): stack.extend(v.values())
```

### 最頻値 (event body 長)

| 長さ  | 件数 |
|-------|-----|
| 3019  | 50  |
| 500   | 43  |
| 3001  | 10  |
| 506   | 9   |
| 512   | 5   |
| 1079  | 2   |
| 1082  | 2   |

500/3019 の 2 値がドミナント。中間値は少数で、cap が離散的に決まっていることを示す。

### 対応する summary 内容

- **500-cluster**: 全て ccmsg subscribe stream (`"ccmsg 新着メッセージ監視"`,
  `"ccmsg rooms 新着 stream"` 等) → Monitor stdout line 単位切断
- **3019-cluster**: `coreauthd biometric event stream` が過半 (50/62)、
  ccmsg も少数 → 別 Monitor mode か、subagent output-file の再取り込み系

### 未検証

- 3019-cluster が発火する具体的 trigger (どの Monitor api / どの source
  で cap が 3019 になるのか)
- harness 側の実装で cap がどこで定義されているか (Claude Code 内部)
- **未検証と明記した対極** (empirical-verification rule): 3019 が「Monitor
  以外の subagent completion status」由来なら、subscribe wire 経路は常に
  500-cluster に落ちる可能性がある。それが確認できれば cap を 500 前提で
  さらに詰められる (safe budget を 400 → もう少し大きく)。逆に subscribe
  も 3019-cluster で切られるモードが実在するなら 400 のままが妥当
