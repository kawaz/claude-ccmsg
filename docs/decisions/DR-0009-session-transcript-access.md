# DR-0009: Session transcript access (transcript_read op)

- **Status**: Accepted (2026-07-10、kawaz 裁定「どんどん進めてくれて構わないです」による一任)
- **Date**: 2026-07-10
- **Author**: AI agent (一次資料の kawaz 発言に基づく)
- **一次資料**: `docs/research/2026-07-09-kawaz-webui-vision-statement.md`、`docs/issue/2026-07-09-webui-workspace-roadmap.md`
- **前提 DR**: DR-0004 (webui architecture、trust model 全般)・DR-0005 (frontend architecture)・DR-0008 (workspace file access、fs_list/fs_read の同型 op として設計を引き継ぐ)

## 記述規約 (attribution)

DR-0001 / DR-0008 と同じ: **[kawaz]** = 一次資料に逐語あり / **[提案]** = エージェント由来 / **[保留]** = 意図的に未決。

## Context

webui workspace UI roadmap (`docs/issue/2026-07-09-webui-workspace-roadmap.md`) の次項目、「jsonl リッチビューア」フェーズ [kawaz、roadmap TODO]。

roadmap の最終形イメージに以下がある [kawaz]:

> セッション選択で jsonl からリッチレンダリング

DR-0008 でファイルツリー + コードビューアは実装済みだが、**セッションの Claude Code transcript (jsonl)** はそのファイルツリーの対象外にある: transcript は session の cwd 配下ではなく `CLAUDE_CONFIG_DIR` (例 `~/.claude/projects/<encoded-cwd>/<sid>.jsonl`) 配下に置かれる。DR-0008 の containment (「browsable universe = 現在接続中セッションの cwd」) はセッション cwd を root とする設計のため、そもそも cwd の外にある transcript には届かない。「サクッと fs_read の browsable root を config dir まで広げる」という発想は不採用 (詳細は Alternatives 案 C) — transcript 専用の新規 op として独立させる。

## Decision

### 1. transcript は「session が hello で申告した単一 jsonl ファイル」のみ読める (案 A) [提案]

- `transcript_read` op は `sid` のみを受け取り、**パスを一切受け取らない**。読める対象は、その `sid` のセッションが hello 時に自己申告し daemon が受理した 1 ファイルに固定される
- クライアント (webui) 視点では「このセッションの transcript を読む」という操作しかなく、「どのファイルを読むか」を選ぶ余地が構造的に存在しない。fs_list/fs_read が持っていた「相対 path + realpath containment 検証」という traversal 対策そのものが、本 op には不要になる (= 検証すべき traversal 面が存在しない)
- 申告経路: SessionStart hook が stdin から transcript_path を取得 → 提案コマンドに `CCMSG_TRANSCRIPT_PATH` env prefix で渡す → cli の `resolveIdentity` がこれを読んで `hello` の `transcript_path` フィールドに乗せる (`SessionIdentity.transcript_path`)

### 2. hello 時検証: 絶対パス + `.jsonl` 拡張子 + basename が `<sid>.jsonl` と一致、違反は黙って無視 [提案]

検証項目 (すべて満たさないと不採用):

- 絶対パスであること (相対パスは cwd 依存で解決が曖昧になるため拒否)
- 拡張子が `.jsonl` であること
- basename が `"<sid>.jsonl"` と一致すること (`sid` は同じ hello リクエスト内の値)

いずれかに違反した場合、**hello 自体は失敗させず、`transcript_path` を meta に採用しないだけ** に留める (= `SessionIdentity.transcript_path` が `undefined` のまま、`PeersResponse` の該当 peer にも `transcript_path` が乗らない)。

- transcript 申告はあくまで「あれば便利な追加情報」であり、hook の実装ミスや将来の Claude Code バージョン差異で transcript_path の形式が想定と違っても、hello という基本機能(メッセージング)自体を壊さないため。fail-open (機能は使えないが実害もない) を選ぶ
- basename 一致を要求するのは、他セッションの transcript_path を騙って読める余地を potential でも残さないため。仮に daemon がパスの中身を信用して「申告されたものは何でも読む」とすると、hello を偽装して任意 sid の任意ファイルを覗く経路になりかねない (実際には他コンポーネントが sid をランダム発行するため悪用は困難だが、契約として明示的に閉じておく)

### 3. transcript_read は byte-offset ページング、行境界アライン、TRANSCRIPT_READ_MAX_BYTES (256 KiB) clamp [提案]

- `TranscriptReadRequest.before` (省略時 = ファイル末尾) を起点に、その offset **以前で終わる行**を集めて返す。初回呼び出し (`before` 省略) は tail から読むため、webui は「開いたら直近ログが見える」を実現できる
- 返却は必ず**完全な行**の集合 (`TranscriptReadResponse.lines: string[]`、各行は生 jsonl 文字列)。行の途中で切れた断片を返さない — クライアントは各行をそのまま `JSON.parse` すればよく、部分行の結合処理を持たない
- `max_bytes` は `TRANSCRIPT_READ_MAX_BYTES` (256 KiB) で clamp する。数十〜数百 MB の transcript を一度に読み切ることを防ぎ、webui 側は「もっと読む (`start` を次の `before` に渡す)」の pull 型ページングで遡る
- `TranscriptReadResponse.size` (現在のファイルサイズ) を毎回返す。session 実行中は transcript が伸び続けるため、webui はこれを見て「新着があるか」を判定し、必要なら次のポーリングで `before` にこの `size` を渡して追従できる

### 4. hello を transcript_read の必須前提にする (IDENTITY_OPS へ追加) [提案]

- DR-0008 で `fs_list`/`fs_read` を `IDENTITY_OPS` に追加した判断をそのまま踏襲する。`transcript_read` も新規 op であり、CLI の既存呼び出し経路と衝突する事情が無いため、hello 必須にコストなく積める
- hello を経ていない接続からの `transcript_read` は `hello_required` で拒否する

### 5. `registerSession` の transcript_path は「latest hello wins」の対象外: 申告なしの再 hello は既存値を保持 [提案]

repo/ws/cwd は毎回「最新の hello が勝つ」(= 省略されたら空文字列で上書き) でよいが、`transcript_path` だけは非対称に扱う: **新しい hello が有効な値を申告した時のみ上書きし、省略時は既存の採用済み値を保持する**。

- `transcript_path` は hook (`CCMSG_TRANSCRIPT_PATH` env prefix) 経由でしか届かない。`subscribe` プロセスが死んで再起動する経路 (UserPromptSubmit hook の nag、または手動での裸 `CCMSG_SID=<sid> ccmsg subscribe` 再実行) では、transcript_path 抜きの hello が普通に発生する — repo/ws/cwd 同様に「省略 = クリア」としてしまうと、再 subscribe のたびに webui の Timeline 表示が理由なく消える
- 悪用可能性は無い: transcript_path は hello 時に basename/拡張子/絶対パス検証済みの値のみが採用される (本 DR の 2.) ため、「省略時に前の値を保持する」を選んでも、他 sid の transcript を覗ける経路が新たに開くわけではない
- 対称性を崩す判断なので repo/ws/cwd との差を明示: 新 hello が `transcript_path` を申告すればそちらが勝つ (通常の latest-hello-wins のまま)、申告が無い時だけ既存値を維持する

## Alternatives considered

- **案 B: transcript の親ディレクトリ全体を browsable にする** (= session だけでなく同一プロジェクトの他セッション・subagent の transcript も読める): 不採用。「セッション本人の作業を webui から見る」という DR-0008 由来の trust model (閲覧可能範囲 = 現在能動的に作業しているものだけ) を、transcript でも維持したい。subagent transcript や他セッションの transcript まで機密面積に含める必要が今は無く、必要になった時点で DR 追補として明示的に拡張範囲を再検討する方が安全側 (= 機密面積の最小化)
- **案 C: `CLAUDE_CONFIG_DIR` (config dir) 全体を fs_list/fs_read の browsable root に含める**: 不採用。DR-0008 の fs 系は「session cwd 配下のプロジェクトファイル」に閉じた設計であり、config dir には他プロジェクトの transcript・認証情報・設定ファイル等セッション cwd と無関係な機密情報が同居する。config dir を root に混ぜると、DR-0008 が確立した「閲覧可能範囲 = セッションの cwd」という境界がそのセッションだけでは説明のつかない範囲まで広がる。transcript 専用の独立 op (対象は 1 ファイルのみ、パス受け取りなし) として切り出す方が、契約上「何が読めるか」を機械的に説明しやすい
- **行 index の事前構築 / 全走査してから返す方式**: 不採用。数十〜数百 MB の実測 jsonl に対し、毎回全体を走査またはインデックス化するのはメモリ・レイテンシの両面で不要なコスト。stateless に「offset から後方/前方に行境界を探して chunk を切り出す」で必要十分 (= O(読みたいチャンク量) で完結し、daemon 側に transcript ごとの index 状態を持たなくて済む)
- **WS ストリーム (`op: "transcript_subscribe"` のような push 型 live tail)**: 延期。Phase 2 のスコープは「開いたら読める / 遡れる」の解消であり、リアルタイム追従は pull 型ページング (`size` を見て次の `before` を組み立てる) で当面代替できる。真に live tail が要る段階になったら別 DR で `subscribe` 系との整合を設計する

## AI による transcript 閲覧は非推奨

`transcript_read` は **人間 (kawaz) が webui 経由で閲覧するための op** であり、AI 自身が自分や他セッションの transcript をまるごと読み込む用途には向かない。`work-principles` rule の「サブエージェントの `Full transcript available at:` ファイルを読んではいけない」禁則と同根の理由: transcript は JSONL 形式で全ツール入出力を含み、AI が読むと context を容易に溢れさせる。webui のユースケースは常に「人間が一部分をスクロールして見る」であって「AI がまとめて取り込む」ではない。

## jsonl フォーマットの安定性

Claude Code の transcript jsonl のフォーマットは、Claude Code 自体のバージョン間で構造の安定性が保証されているものではない。webui のビューアは特定バージョンのスキーマに強く依存した parse をせず、**未知の `type` / フィールド構成の行は安全に生 JSON 表示へフォールバックする** (= parse に失敗して画面が壊れる、より、判読はしにくくても情報を落とさず出すことを優先する)。

## Consequences

- kawaz は webui から、現在接続中セッションの transcript を tail から遡ってページングしながら閲覧できる (jsonl リッチビューアの基盤 API)
- transcript_read の閲覧可能範囲は hello 時に申告・検証された 1 ファイルのみであり、DR-0008 の fs_list/fs_read (cwd 配下の任意ファイル) より狭い契約 — 機密面積は増えない
- hook 側 (`CCMSG_TRANSCRIPT_PATH` 申告) の実装や将来の Claude Code バージョン差異で transcript_path の形式が変わっても、検証で弾かれるだけで hello 自体・メッセージング機能は壊れない (fail-open)

## Next steps

1. daemon: `transcript_read` ハンドラ実装 (hello 時の basename/拡張子/絶対パス検証、`IDENTITY_OPS` へ追加、byte-offset ページングと行境界アライン、`TRANSCRIPT_READ_MAX_BYTES` clamp)、テスト
2. cli: SessionStart hook で stdin transcript_path を取得し `CCMSG_TRANSCRIPT_PATH` env prefix 経由で `resolveIdentity` に渡す実装
3. packages/webui: jsonl リッチタイムラインビューア (未知 type のフォールバック表示含む)
