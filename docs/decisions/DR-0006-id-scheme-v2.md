# DR-0006: ID 体系 v2 — member id を u/a namespace の型付き文字列に分離

- **Status**: Proposed (2026-07-09。2026-07-04 の消失した合意の回収。実装先行、明示レビュー待ち)
- **Date**: 2026-07-09
- **Author**: kawaz (発掘・整理: AI agent)
- **一次資料**: [docs/research/2026-07-04-kawaz-id-scheme-statements.md](../research/2026-07-04-kawaz-id-scheme-statements.md)
- **関係 DR**: DR-0003 の member identity (`uid` 整数、`0` = User 予約) を supersede。DR-0004 §5 / DR-0005 のロケータ・webui は本体系に追従

## 記述規約 (attribution)

DR-0001 と同じ: **[kawaz]** / **[提案]** / **[保留]**。

## Context

kawaz 提案 (2026-07-04) [kawaz]: 「u0 がユーザ」という特別ルールをやめ、**エージェント = aN / ユーザ = uN** に namespace を分離する。基本 u1 = kawaz (admin) しか居ないが、webui にゲスト招待 (権限の弱い u2+) が混じるロードマップが考えられるため。旧セッションで方向合意まで進んだが、セッション終了により DR / issue に落ちず消失。uid 0 方式のまま v0.2.x まで実装が進んだため、実データがデモ 1 room しか無い今が breaking change の最終好機。

## Decision

### 1. member id = 型付き文字列 `uN` / `aN` [kawaz + 提案]

- `from` / `to` / member イベントの識別子は整数をやめ、**`u1` / `a3` 形式の型付き文字列** (コロンなし) にする。1 つの `from` に人間/エージェント 2 つの namespace が同居するため、型接頭辞は判別そのもの [kawaz 00:39 「後者は駄目」]
- フィールド名は `uid` → **`id`** に変更 (値が self-typing になるため generic 名が適合) [提案、00:40]
- ロケータ記法 (`#r7-m10-15` / `#u1` / `#a3`) と ID がそのまま一致し、変換層が不要になる。DR-0004 §5 のロケータ `-uNN` は `-<id>` (例 `#r7-u1`, `#r7-a2`) に読み替える

### 2. `u1` = admin (kawaz) 予約、`u2+` = ゲスト [kawaz]

- `u1` は admin の予約 id。**全 room に暗黙参加** (旧 uid 0 と同じ挙動、member 行不要)。「特別扱い」は消えるのではなく、根拠が magic number から role に移る
- `u2+` はゲスト: 暗黙参加**しない**通常メンバー (member イベントで join、`role: "guest"`)。番号は room-local、人物同一性は member イベントのメタで取る (グローバルユーザレジストリは作らない) [提案]
- member イベントに `role` フィールドを追加。**権限 enforcement は本 DR のスコープ外** (webui ゲスト招待の phase で DR 追補) [kawaz「当面不要」]
- agent は `a1, a2, ...` の room 内参加順 seq (旧 uid 1.. と同じ採番)

### 3. room id は `rN` 連番生成 [kawaz 00:39 + 提案]

- daemon の生成形式を `r` + 連番 (`r1, r2, ...`) にする。「形式ルールなし・クライアントは parse しない」(DR-0003) は不変で、これは**生成慣習**。ログやチャットに裸で書いても何の ID か自明になる
- 旧 `r-XXXXXXXX` (random hex) は生成慣習の変更であり、互換性の問題はない (opaque 前提のため)

### 4. mid は整数のまま [提案、00:40]

- mid は連番ギャップ検出・範囲指定 (`10-15`)・大小比較という**算術が本務の序数**。文字列化しない。`mNN` はロケータ層 (`#r7-m10`) の表記に留める

### 5. 移行: migration しない [提案]

- 旧形式 (整数 uid) の room jsonl とは非互換。実データはデモ 1 room のみのため **migration 機構は作らず、rooms ディレクトリの旧ファイルは破棄**する (本 DR 適用リリースのノートに明記)
- notify の `from` (role/sid 構造) は本 DR の対象外 (room 内 id ではなく接続 identity のため現行のまま)

## Alternatives considered

- **`{u:N} {a:N}` (フィールド分離 + 整数)**: 不採用 [kawaz]。`from` に入れる時に区別が破綻する
- **`u:1` (コロン付き)**: 不採用 [提案]。ロケータ (`#r7-u1`) と揃わず変換層が要る
- **uid 0 方式の維持**: 不採用。「人間は 1 人」のハードコードでゲスト導入時に表現不能。「from:0 だけがユーザ」の部族知識が SKILL 頼みで、データ自体が語らない
- **mid も `mN` 文字列化**: 不採用。全クライアントが数値化し直すコストだけで得るものは装飾 (§4)

## Consequences

- 「どれがユーザ発言か」がデータ自体に載る (`from:"u1"`)。承認誤認防止 (SKILL の from:0 規則) が記法レベルで強制される
- protocol / daemon / cli / webui / SKILL / hooks を横断する breaking change (実装時点で minor bump)
- ゲスト導入 (webui 招待) が schema 変更なしで可能になる (enforcement DR のみ)
- 旧 jsonl は読めない (migration なし、§5)

## Next steps

1. protocol / daemon / cli / webui の一括実装 + テスト追従 (breaking、v0.3.0)
2. SKILL.md の from 判定規則 (`from: 0` → `from: "u1"` 系) と DR-0003/0004 の該当記述の追従
3. 既存 rooms データの破棄 (kawaz の実データはデモ room のみ)
4. ゲスト権限 enforcement は webui ゲスト招待 phase で DR 追補
