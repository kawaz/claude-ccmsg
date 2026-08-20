# checkpoint / rewind と ccmsg 受信メッセージ

対象: Claude Code v2.1.224 (実測)。ccmsg 受信メッセージが `/rewind` の選択肢に出ない問題の原因特定と、任意地点へ rewind する手段。

## 判明した事実

### 1. rewind メニューに載る条件は実装上の述語で確定している

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
teammate 経路は `origin.kind:"peer"` かつ `isMeta:true` で二重に除外される。

**このセッションで rewind 選択肢になるのは 4 件だけ** (3946 行のうち)。kawaz の体感はこの数字そのもの。

### 3. 配送経路の `origin` はコアが決めるので、plugin 側から human 化できない

`origin` は配送チャネルごとにコアが分類して付与する。human に分類される外部経路は
`client_platform` の allowlist 判定を通った bridge 経由の inbound (Slack / claude.ai 系) のみで、
allowlist 外は `demoting unwrapped inbound message to peer origin` の warn を出して peer に降格される。
ローカル plugin / Monitor stdout からこの分類を選ぶ手段は無い。

### 4. `--resume-session-at=<uuid>` = 任意地点 rewind の native 手段 (これが本命)

> **Addendum 2026-08-21 (v2.1.237 実測)**: 本節・以降の実測は v2.1.227 時点のもの。
> v2.1.237 では `--resume-session-at` は **print mode (`-p`) 専用**になり、対話起動では
> 黙って無視される (指定あり / なしで input tokens 完全一致、バイナリ内説明にも
> "use with --resume in print mode" と明記)。対話で使うには print bootstrap の二段起動が
> 必要 (DR-0018 §3.3.1 が現行の正)。

`claude --help` に出ない**非公開オプション**が実在する: `--resume-session-at=`, `--resume-drops-turn=`
(`--fork-session` は help 掲載あり)。

実装:

```js
if(t.resumeSessionAt){
  let u = c.messages.findIndex((d)=>d.uuid === t.resumeSessionAt);
  if(u < 0) return grr(`No message found with message.uuid of: ${t.resumeSessionAt}`), exit(1);
  if(t.resumeDropsTurn !== void 0){ /* 破棄範囲の帰属チェック、NG なら refuse */ }
  c.messages = c.messages.slice(0, u+1);
}
```

つまり **セッションを読み込んだ後、メモリ上の message 配列を指定 uuid まで (その uuid を含む) で切る**。
**jsonl ファイルには一切手を触れない**。`--fork-session` と併用すれば新 sid のセッションになる。

実測 (隔離環境、ALPHA/BRAVO/CHARLIE の 3 turn セッション):

| `--resume-session-at` に渡した uuid | 「今までの codeword を全部」への応答 |
|---|---|
| assistant "ok1" の uuid | `ALPHA` |
| assistant "ok2" の uuid | `ALPHA, BRAVO` |
| (指定なし = 通常 resume) | `ALPHA, BRAVO, CHARLIE` |
| 存在しない uuid | `No message found with message.uuid of: ...` で exit 1 |

`--fork-session` 併用時、**元セッションのファイルは md5 一致で無変更**。新しい sid のファイルが 1 本増える。

### 5. fork は履歴を「コピー」する (参照ではない) ので、fork ファイルは自己完結する

fork で生成されたファイルは、**先祖レコードを uuid と timestamp を保ったまま複製し、`sessionId` だけ新 sid に書き換えたもの**。
ファイル横断の uuid 解決はしていない。

- 実 fork 3 本 (`5b537ed3` / `6b50a9d5` / `6f4f4c8f`) は先頭 33 レコードの uuid 列が**順序込みで完全一致**し、`first_ts` も同一。
  それぞれ fork 地点から独立に伸びて 46 / 46 / 121 uuid になっている。
- 隔離実測でも、ok1 地点で fork したファイル (15 行) は `ALPHA` を含み `BRAVO` / `CHARLIE` を含まない。

したがって **「切り詰めると履歴が消える」心配は当たらない**。fork は元ファイルを読み取るだけで、
新ファイルに切り詰め済みのコピーを作る。元は無傷のまま残る。

なお `last-prompt` + `leafUuid` のヘッダだけを持つ手製ファイルは resume できない
(`No conversation found with session ID: ...`)。実体のメッセージレコードが要る。

### 6. 切る位置は「戻したい user turn の 1 つ手前」

`slice(0, u+1)` は **指定 uuid を含む**。実測で、CHARLIE の user レコードの uuid を渡すと
その prompt が未応答のまま残り、モデルがまず `ok3` と答えてから次の質問に答えた (結果 `ALPHA, BRAVO, CHARLIE`)。

「msg X の直前に戻す」なら、渡すのは **X の 1 つ前の assistant レコードの uuid**。X 自身の uuid ではない。

### 7. `--fork-session` を付けない場合は同一ファイル内で分岐する (破壊はしない)

使い捨てコピーで実測: `--resume-session-at` のみ (fork なし) だと応答は正しく切り詰まる (`ALPHA, BRAVO`) が、
新しい turn は**同じファイルに追記**され、32 行 → 41 行になった。**CHARLIE のレコードは消えずに残る**。
つまりファイルが枝分かれした DAG になり、有効な leaf が新しい枝へ移る。非破壊だが、
1 ファイルに複数の枝が同居するので、外部から読む側 (ccmsg webui 等) は leaf 追跡が要る。

**webui から使うなら `--fork-session` 併用が明確に安全**。

### 8. コード状態は戻らない前提でよい

公式仕様上、bash 由来の変更とサブエージェント (background) の編集は checkpoint に追跡されない。
ccmsg の作業実体は大半がサブエージェント編集なので、**コード復元は元々期待できない**。
実 fork ファイルには `file-history-snapshot` が 23 件コピーされていたので fork がコード履歴を引き継ぐ余地はあるが、
そこは未検証 (下記)。

### 9. `--resume-session-at` の成否を決めるのはレコードの種類ではなく「生きた枝に載っているか」

「どの uuid なら動くのか、ダメなパターンはあるのか」を隔離環境で実測した (v2.1.227、haiku、
tool 使用を含む 2 turn + subagent 1 回のセッション)。判定は起動できただけでなく
**resume 後に 1 発話が正常に返ったか**まで。

| 指定した uuid のレコード | 結果 |
|---|---|
| user プロンプト (`promptSource:"sdk"`) | ✅ 応答あり |
| `attachment` (user 直後 / tool_result 直後の 2 箇所) | ✅ 応答あり |
| assistant (`thinking` のみの行、2 箇所) | ✅ 応答あり |
| **assistant (`tool_use`。対応する tool_result より前で切る、2 箇所)** | ✅ 応答あり |
| user (`tool_result`、3 箇所。並列 tool の途中を含む) | ✅ 応答あり |
| assistant (最終 `text`、2 箇所) | ✅ 応答あり |
| user (`isMeta:true`。skill 注入の実レコード、2 箇所) | ✅ 応答あり |
| **放棄された分岐上のレコード** | ❌ `No message found with message.uuid of:` |
| subagent transcript (`subagents/agent-*.jsonl`) のレコード | ❌ 同上 |
| 存在しない uuid | ❌ 同上 |

**種類は一切関係ない。** 最有力の失敗候補だった「tool_use と tool_result の間で切る」ケースも
普通に成功する。fork ファイルを見ると **dangling な tool_use をそのまま残したまま**次の user
発話が続いており (合成 tool_result は挿入されていない)、それでも API 呼び出しは通っている。

効いているのは 1 つだけ: **`c.messages` に載っているか**。`c.messages` は
ファイルの全行ではなく **最終行から `parentUuid` を遡って再構成した鎖**なので、

- `--fork-session` なしの resume で枝分かれしたファイル (事実 7) の**旧枝側**のレコードは、
  ファイルに残っていて webui にも描画されるのに **resume では読み込まれない = 指定すると必ず失敗する**
- 別ファイルである subagent transcript のレコードも当然載らない

実測手順: 使い捨てコピーに対し `--fork-session` なしで途中 resume して枝を作り
(旧枝の末尾レコードは残存)、その旧枝の uuid を `--resume-session-at` に渡すと失敗した。
一方その直前の共通祖先は成功する。

なお **手で追記したレコードも同様に失敗する**。injection 実験で、`parentUuid` の鎖に
繋がない (= 次の行の `parentUuid` を書き換えない) と `isMeta` の値に関係なく
`No message found` になった。「isMeta だから落ちた」と誤読しかけたが、
`isMeta:false` の対照実験も同じく落ちたので原因は鎖の断絶。実レコードでの `isMeta:true` は
上表のとおり成功する。

#### webui への含意

fork 地点として提示してよいのは **生きた鎖の上のレコードだけ**。種類で絞る必要は無い
(assistant / thinking / tool_use / tool_result / attachment / isMeta すべて可)。
webui は最終行から `parentUuid` を遡って鎖を求め、そこに無い項目には fork 導線を出さない。

## 実用的な示唆

### 推奨実装: native の `--resume-session-at` + `--fork-session`

jsonl の手術は不要。webui の「この msg 時点へ会話 rewind」は次の 1 コマンドで足りる:

```bash
claude --resume <元sid> --resume-session-at=<戻したい地点のuuid> --fork-session
```

- 渡す uuid は「戻したい msg の 1 つ前の assistant レコード」(事実 6)
- 元セッションのファイルは無変更 (事実 4)
- 新 sid のセッションが切り詰め済みの履歴コピーを持って起動する (事実 5)
- `--resume-drops-turn=<turnId>` を足すと、破棄範囲が宣言した turn に帰属しない時に refuse する安全弁になる (任意)

### 選択肢の比較

| | A: 受信を checkpoint 経路に乗せる | B: `--resume-session-at` + `--fork-session` | C: 現状維持 + 運用回避 |
|---|---|---|---|
| 実現可能性 | **不可**。origin 付与はコアが配送経路で決める (事実 3) | **可能**。native 機能、実測済み (事実 4) | 自明 |
| ファイル操作 | — | **不要** | — |
| 元セッションへの影響 | — | 無変更 (md5 一致で確認) | — |
| 復元範囲 | 会話 + コード | 会話 (コードは事実 8 の前提で期待しない) | — |
| 主なリスク | 受信ごとに turn が増えて checkpoint 100 個上限を通知で食い潰し、cache も切れる | **非公開オプション**なので将来のバージョンで消える/変わる可能性 | 選択肢が実質 4 個のまま |

### 推し: B

A は原理的に閉じている上、仮に開いても副作用 (通知で checkpoint 上限を食う / turn 境界が増えて prompt cache が切れる) が利得を上回る。
B は native 機能で、ファイルを一切触らないので破壊性が無く、実測で期待どおり動く。

**唯一の懸念は B が非公開オプションであること**。`claude --help` に出ないため、バージョン更新で挙動が変わる可能性がある。
実装するなら起動時に 1 度だけ生存確認 (既知 uuid で dry-run し、
`No message found with message.uuid of:` 以外のエラーが出ないか) を入れて、失敗時は機能を無効化する形が安全。

## 検証の詳細

### 何をどう観測したか

**実装の抽出**: `claude` は単一バイナリ (`~/.local/share/claude/versions/2.1.224`、265MB、bun compile) だが
JS バンドルを内包しているので `rg -a` でバイナリを直接 grep して該当関数を復元した。
rewind メニュー component の `e.filter(K6e)` を起点に述語を取り、
`--fork-session` 周辺の文字列テーブルから `--resume-session-at=` / `--resume-drops-turn=` を発見して
`resumeSessionAt` の実装ブロックまで辿った。
これは TUI 越しの代理観測ではなく**実装の一次情報**。

**隔離実験**: `CLAUDE_CONFIG_DIR=/tmp/rewind-lab/config`、cwd `/tmp/rewind-lab/work`、
`--safe-mode --model haiku --max-budget-usd 0.5` で plugin ロードを止めてコストを抑えた。
ALPHA / BRAVO / CHARLIE を 1 turn ずつ覚えさせた 3 turn セッションを作り、
どの地点まで記憶が残るかで切り詰め位置を判定した。本物のセッション・本番 daemon には触れていない。
`--fork-session` を付けない検証だけは使い捨てコピーに対して行い、元ファイルには適用していない。

### 検証マトリクス

| # | 検証 | 手段 | 結果 |
|---|---|---|---|
| 1 | rewind 一覧の filter 条件 | バイナリからの述語復元 | `origin` 有 かつ human 以外は除外 (確定) |
| 2 | ccmsg 受信の `origin` | 実セッション jsonl 集計 | `task-notification` 288 件、本文は `<event>{"type":"msg"...}` |
| 3 | teammate 受信の `origin` | 同上 | `peer` + `isMeta:true` (二重除外) |
| 4 | 通常プロンプトの `origin` | 同上 | `typed`/`queued` + `human` = 4 件のみ |
| 5 | `-p`/SDK turn の `origin` | 隔離実測 | `origin: null` → rewind 対象になる |
| 6 | `--resume-session-at` の切り詰め | 隔離実測 (3 地点) | ok1→`ALPHA` / ok2→`ALPHA, BRAVO` / 無指定→全部 |
| 7 | 元ファイルへの副作用 (fork 併用) | md5 比較 | **無変更** |
| 8 | 存在しない uuid | 隔離実測 | `No message found with message.uuid of:` で exit 1 |
| 9 | fork = コピーか参照か | 実 fork 3 本の uuid 列比較 + 隔離実測 | **コピー**。先頭 33 uuid が順序込み一致、fork ファイルは自己完結 |
| 10 | user レコード uuid を指定 | 隔離実測 | その prompt を含むので再応答が起きる (1 つ前を指定すべき) |
| 11 | `--fork-session` 無し | 使い捨てコピーで実測 | 同一ファイルに追記して分岐。旧レコードは残る (非破壊) |
| 12 | ヘッダのみの手製 fork ファイル | 隔離実測 | `No conversation found` で不成立。実メッセージが必要 |
| 13 | uuid の種類別 成否 (7 種) | 隔離実測 (v2.1.227、各セル resume 後の応答まで確認) | **全種類成功**。tool_use 途中切りも可 (事実 9) |
| 14 | 放棄された分岐上の uuid | 使い捨てコピーで枝を作って実測 | **失敗** (`No message found`)。webui から到達しうる唯一の失敗 |
| 15 | subagent transcript の uuid | 隔離実測 | 失敗 (別ファイル = `c.messages` に無い) |
| 16 | 鎖に繋がない手製レコード | 隔離実測 (isMeta true/false 両方) | 両方失敗 = 原因は isMeta ではなく `parentUuid` の断絶 |

### 未検証

- **壊れた uuid を渡した時の claude 本体のエラー文言**は `No message found ...` のみ確認。
  それ以外の壊れ方 (uuid 形式が不正 等) は試していない。
- **turn 途中切りが会話品質に与える影響**。API 呼び出しが通って応答が返ることは確認したが、
  dangling tool_use を含む履歴でモデルの応答が劣化しないかは評価していない。
- **対話 TUI の `/rewind` メニュー表示そのもの**は自動化できないため目視していない。
  事実 1 は実装述語からの確定であって画面確認ではない (述語はメニュー生成元なので乖離余地は無いと判断)。
- **`--resume-drops-turn` の実挙動**。実装ブロックとエラー文言は読んだが、実際に渡して refuse させる検証はしていない。
- **fork がコード履歴 (`file-history-snapshot`) を実用的に引き継ぐか**。実 fork ファイルに 23 件コピーされている事実は
  確認したが、fork 先で `/rewind` のコード復元が機能するかは未確認。事実 8 のとおり ccmsg 用途では期待していないので優先度は低い。
- **非公開オプションの安定性**。v2.1.224 でのみ確認。過去/将来バージョンでの存在は未確認。

### 後片付け

隔離環境 `/tmp/rewind-lab/` は削除しようとしたが権限プロンプトで拒否されたため**残置**している。不要なら手動で削除。
