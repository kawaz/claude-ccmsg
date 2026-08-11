# checkpoint / rewind と ccmsg 受信メッセージ

対象: Claude Code v2.1.224 (実測)。ccmsg 受信メッセージが `/rewind` の選択肢に出ない問題の原因特定と、取りうる対策の比較。

## 判明した事実

### 1. rewind メニューに載る条件は、実装上の述語で確定している

`/rewind` メニューの一覧は、セッションの message 配列を述語 `K6e` で filter した結果そのもの
(バンドル内 `...e.filter(K6e)...` が rewind メニュー component の一覧ソース)。`K6e` の実体:

```js
function K6e(e){
  if(!$je(e)) return false;
  if(e.origin && e.origin.kind !== "human") return false;
  if(e.stackedExpansion) return false;
  return true;
}
function $je(e){
  if(e.type !== "user") return false;
  if(Array.isArray(e.message.content) && e.message.content[0]?.type === "tool_result") return false;
  if(Pye(e)) return false;                 // 定型テキストの除外セット
  if(e.isMeta) return false;
  if(e.isCompactSummary || e.isVisibleInTranscriptOnly) return false;
  // 続いて <command-name> 等の system タグを含むテキストを除外
}
```

つまり rewind の選択肢になるのは **`type:"user"` かつ tool_result でなく `isMeta` でなく、`origin` が無いか `origin.kind === "human"`** のレコードだけ。

重要な非対称: 判定は「`origin` が human であること」ではなく **「`origin` があるなら human でなければ落とす」**。
`origin` が付いていないレコードは通る。

### 2. ccmsg 受信メッセージは `origin.kind: "task-notification"` で届く = 構造的に除外される

実セッション (`fef5e6c9-...jsonl`、3946 行) の `type:"user"` レコードの内訳:

| promptSource | origin.kind | isMeta | 件数 | 正体 |
|---|---|---|---:|---|
| `null` | (無し) | false | 696 | tool_result (別条件で除外) |
| `system` | `task-notification` | false | 288 | **ccmsg 受信 + Monitor/Agent 完了通知** |
| `system` | `peer` | **true** | 11 | teammate の SendMessage |
| `typed` | `human` | false | 3 | kawaz の実タイプ |
| `queued` | `human` | false | 1 | kawaz の queue 投入 |

`task-notification` 288 件の本文はすべて `<event>{"type":"msg",...}` 形式 = ccmsg subscribe ストリームの実配送。
teammate 経路は `origin.kind:"peer"` かつ `isMeta:true` で **二重に**除外される。

**このセッションで rewind 選択肢になるのは 4 件だけ** (3946 行のうち)。kawaz の体感「選択肢が乏しく、下手すると先頭まで戻るしかない」はこの数字そのもの。

### 3. 配送経路の `origin` は Claude Code コアが決めるので、plugin 側から human 化できない

`origin` は配送チャネルごとにコアが分類して付与する (`{kind:"human"}` / `{kind:"peer",...}` / `{kind:"task-notification"}`)。
human に分類される外部経路は `client_platform` の allowlist 判定を通った bridge 経由の inbound (Slack / claude.ai 系) のみで、
allowlist 外は `demoting unwrapped inbound message to peer origin` の warn を出して peer に降格される。
ローカル plugin / Monitor stdout からこの分類を選ぶ手段は無い。

### 4. `-p` / SDK 経由の user turn は `origin` が付かない = rewind 対象になる

隔離セッションの実測: `claude -p` で投入した turn は `promptSource:"sdk"`, **`origin: null`**。
`K6e` の `if(e.origin && ...)` を素通りするので rewind 対象。
つまり除外の原因は「人間が打っていないこと」ではなく **配送経路が `origin` を付けること**。

### 5. jsonl を切り詰めて別 sid にコピーして resume する手術は成立する (実測)

隔離環境 (`CLAUDE_CONFIG_DIR=/tmp/rewind-lab/config`) で ALPHA / BRAVO / CHARLIE の 3 turn セッションを作り、
CHARLIE の user turn 直前 (18 行目) で切り詰めて別 sid のファイル名でコピーし resume した結果:

| 対象 | 「今までの codeword を全部挙げて」への応答 |
|---|---|
| 切り詰めコピー (別 sid) | `ALPHA, BRAVO` |
| 元セッション (対照) | `ALPHA, BRAVO, CHARLIE` |

付随して確定したこと:

- **レコード内の `sessionId` を書き換える必要は無い**。resume は**ファイル名**の sid で解決する。
  書き換えずにコピーしたファイルでも正常に resume でき、以後の追記だけが新 sid を持つ (= 1 ファイル内で新旧 sid が混在するが動作に影響なし)。
- **元セッションのファイルは一切変更されない**。追記は resume 時に指定した sid のファイルにだけ行われる。
- parentUuid チェーンの手当ては不要だった。末尾を落とすだけの切り詰めなら親子関係は自然に保たれる。
- 切り詰め位置は user turn の直前で取る。ただし 1 つの turn は `queue-operation` × 2 → `user` → `attachment` → `assistant` … の並びなので、
  その turn の `queue-operation` も含めて落とす (= 直前の `last-prompt` / `mode` レコードまでを残す) のが安全。

### 6. 会話のみの rewind になる (ファイル状態は戻らない)

切り詰めコピーには `file-history-snapshot` / `file-history-delta` が含まれない (= その時点までのスナップショット参照しか持たない)。
コード復元は成立せず、**「Restore conversation」相当**になる。
なお公式仕様上も、サブエージェント (background) の編集と bash 由来の変更はそもそも checkpoint に追跡されない。
ccmsg の作業実体は大半がサブエージェント編集なので、**コード復元は元々期待できない**。

## 実用的な示唆

### 選択肢の比較

| | A: 受信を checkpoint 経路に乗せる | B: webui に「この msg 時点へ会話 rewind」 | C: 現状維持 + 運用回避 |
|---|---|---|---|
| 実現可能性 | **不可**。`origin` の付与はコアが配送経路で決め、plugin から human を選べない (事実 3) | **可能**。切り詰め + 別 sid resume は実測で成立 (事実 5) | 自明 |
| 復元範囲 | 会話 + コード | 会話のみ (事実 6) | — |
| 主な副作用 | (仮に実現しても) 受信のたびに user turn が増え、TL がノイズ化し checkpoint 100 個上限を通知で食い潰す | 元セッションは無傷、新 sid に分岐するので破壊性が無い | 選択肢が実質 4 個のまま |
| コスト/文脈への影響 | 受信ごとに turn 境界が増える = キャッシュ再利用が切れて課金・レイテンシとも悪化 | 手術自体は追加課金なし。resume 後は通常どおり | なし |

### 推し: B

理由は 3 つ。

1. **A は原理的に閉じている**。`origin` の分類はコアの配送経路判定で、plugin が介入できる場所が無い。
   仮にコアが変わって可能になったとしても、副作用 (通知で checkpoint 上限を食う / turn 境界が増えて cache が切れる) が利得を上回る。
2. **B は破壊性が無い**。別 sid のファイル名にコピーして resume するだけで、元セッションのファイルには一切書き込まない (事実 5)。
   失敗しても元が残るので、やり直しが常に効く。
3. **「会話のみ」という限界は実質的な損失にならない**。ccmsg の作業実体はサブエージェント編集で、
   そもそも公式仕様上 checkpoint に追跡されない (事実 6)。コード復元は A を採っても得られない。

### B を作る場合の実装メモ (実測に基づく)

- 切り詰め位置は「この msg を配送した `type:"user"` レコードの直前」。同 turn の `queue-operation` も落とす。
- コピー先は新規 uuid のファイル名。**レコード内の `sessionId` は書き換えなくてよい**。
- 起動は `claude --resume <新sid>`。`--fork-session` は元セッション全体を複製するだけで切り詰めはしないので、
  切り詰めが要る本用途では代替にならない (併用の必要もない)。
- UI 上は「コードは戻らない / 会話だけが戻る」ことを明示する。

## 検証の詳細

### 何をどう観測したか

**実装述語の抽出**: `claude` は単一バイナリ (`~/.local/share/claude/versions/2.1.224`、265MB、bun compile) だが JS バンドルを内包しているので、
`rg -a` でバイナリ直接 grep して該当関数を復元した。
rewind メニュー component の `e.filter(K6e)` を起点に `K6e` / `$je` / `Pye` の定義を取り、
さらに `{kind:"human"}` / `{kind:"task-notification"}` / `{kind:"peer"}` の代入箇所から `origin` 分類ロジックを確認した。
これは「rewind メニューに何が出るか」を TUI 越しの代理観測ではなく**実装の一次情報**で確定させたもの。

**実セッションの分布**: ccmsg の実セッション jsonl 1 本 (3946 行) を `jq` で集計。
`promptSource` は文字列、`origin` はオブジェクトという型の非対称があるため、最初 `.promptSource.kind` で取ろうとして失敗している (この点は途中で訂正済み)。

**隔離実験**: `CLAUDE_CONFIG_DIR=/tmp/rewind-lab/config`、cwd `/tmp/rewind-lab/work`、
`--safe-mode --model haiku --max-budget-usd 0.5` で plugin ロードを止めてコストを抑えた。
本物のセッション・本番 daemon には触れていない。3 turn 構築 → 切り詰め → 別 sid resume → 対照との比較、の順で実施。

### 検証マトリクス

| # | 検証 | 手段 | 結果 |
|---|---|---|---|
| 1 | rewind 一覧の filter 条件 | バイナリからの述語復元 | `origin` 有 かつ human 以外は除外 (確定) |
| 2 | ccmsg 受信の `origin` | 実セッション jsonl 集計 | `task-notification` 288 件、本文は `<event>{"type":"msg"...}` |
| 3 | teammate 受信の `origin` | 同上 | `peer` + `isMeta:true` (二重除外) |
| 4 | 通常プロンプトの `origin` | 同上 | `typed`/`queued` + `human` = 4 件のみ |
| 5 | `-p`/SDK turn の `origin` | 隔離実測 | `origin: null` → rewind 対象になる |
| 6 | 切り詰め + 別 sid resume | 隔離実測 | 成立 (`ALPHA, BRAVO` vs 対照 `ALPHA, BRAVO, CHARLIE`) |
| 7 | `sessionId` 書き換えの要否 | 隔離実測 (書き換え有/無の 2 通り) | **不要**。ファイル名で解決 |
| 8 | 元セッションへの副作用 | resume 前後の行数・内容比較 | 無し |

### 未検証

- **対話 TUI の `/rewind` メニュー表示そのもの**は自動化できないため直接見ていない。
  事実 1 は実装述語からの確定であって、画面の目視確認ではない。ただし述語はメニュー一覧の生成元そのものなので、
  表示と乖離する余地は無いと判断している。
- **稼働中セッションの jsonl を同 sid のまま切り詰めた場合の挙動**は試していない (危険なため意図的に回避)。
  別 sid コピーで用が足りるので試す必要が無い、という判断。
- 切り詰め位置を `assistant` の途中など turn 境界以外に取った場合の耐性は未確認。
  実装するなら turn 境界に限定するのが安全。

### 後片付け

隔離環境 `/tmp/rewind-lab/` は削除しようとしたが権限プロンプトで拒否されたため**残置**している。不要なら手動で削除。
