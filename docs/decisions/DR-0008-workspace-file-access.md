# DR-0008: Workspace file access (fs_list / fs_read op)

- **Status**: Accepted (2026-07-10、kawaz 裁定「どんどん進めてくれて構わないです」による一任)
- **Date**: 2026-07-10
- **Author**: AI agent (一次資料の kawaz 発言に基づく)
- **一次資料**: 本セッション 2026-07-10 の kawaz 発言 (優先順位表明、下記 Context に逐語転記)
- **前提 DR**: DR-0004 (webui architecture、trust model 全般)・DR-0005 (frontend architecture)

## 記述規約 (attribution)

DR-0001 と同じ: **[kawaz]** = 一次資料に逐語あり / **[提案]** = エージェント由来 / **[保留]** = 意図的に未決。

## Context

webui workspace UI の Phase 1 スコープ確定にあたり、kawaz が優先順位を明言した [kawaz、逐語]:

> 優先順位はセッションリスト、ルームリストは必須でしょ。ルームリストのチャットはシンプルなのならコンポーネントは作ないからサクッといけるかな。セッションリストの方は、セッション選んだらまずファイルツリーとコードビューアが欲しいな。リモートからだとファイルが見れないのが辛い。pushしてくれたらghじょうでみれはするんだけど。てことでプロジェクト内ファイルビューアが個人的に優先度高いです。でも並列で進められるのもどんどん進めてくれて構わないです。

この発言から確定する事項:

- ルーム一覧 + チャットは「シンプルなら専用コンポーネント不要」= 既存の room view 実装で要件を満たしている。本 Phase での変更なし [kawaz]
- セッションリスト選択後の**ファイルツリー + コードビューア**が個人的最優先 [kawaz]。動機は「リモート (tailscale 経由スマホ等) からだと push 前のファイルが見れない」という具体的な不便の解消
- 「並列で進めてくれて構わない」= 具体設計は一任 [kawaz]。以下の Decision は全て [提案] 起点

## Decision

### 1. ファイルアクセスは WS op (fs_list / fs_read)、REST エンドポイントは生やさない [提案]

- DR-0004 §2 の「同じプロトコル」原則 (socket と web は同一 line protocol を喋る) をそのまま踏襲する。`fs_list` / `fs_read` を通常の op として追加し、`hello` → `fs_list`/`fs_read` の呼び出し順は他 op (`rooms`/`read`/`peers`) と同じ形
- REST (`GET /api/fs?...`) を別途生やす案は DR-0004 が既に「不採用」とした「REST API 変換層」パターンの再演になる。op が増えるたびに二重メンテになるため見送り

### 2. browsable universe = 「現在接続中セッションの cwd」のみ、任意 root 指定は許可しない [提案]

- クライアントは `sid` (peers に出る session id) + 相対 `path` を指定する。FS root を直接指定する手段は無い (`FsListRequest`/`FsReadRequest` に絶対パスやルート指定フィールドを持たせない)
- 任意パス API (例: `{"op":"fs_read","path":"/etc/passwd"}` のような絶対パス許可、または env で許可 root を追加登録する方式) は不採用: browser 経由でホスト全体の任意ファイルへの到達路を作ることになり、DR-0004 が確立した trust model (「webui から到達できるのは kawaz 本人の操作範囲に限る」) を再び壊す。DR-0004 Critical trust-model 修正の教訓 (source-IP allowlist だけでは reachable == user を保証できない) と同種の失敗パターンを、機能追加のたびに再導入しないための制約
- 「現在接続中セッションの cwd」に絞ることで、閲覧可能な範囲は「kawaz が既に実際に Claude Code セッションを走らせているディレクトリ」に自動的に一致する — 新たな許可設定を用意しなくても安全側に閉じる

### 3. realpath containment 検証で symlink 脱出を遮断 [提案]

- `fs_list`/`fs_read` が受け取った相対 `path` はセッション cwd を root として解決した後、**realpath を取ってから root prefix 一致を検証**する。symlink が root 外を指す場合、その entry 自体は `fs_list` の一覧には出す (`FsEntry.type: "symlink"` として存在は見せる) が、`fs_read` 等でその実体を辿ろうとする操作は `path_forbidden` で拒否する
- 文字列ベースの `..` チェックだけでは不十分 (symlink 経由で root 外の実体に到達できてしまう) なため、実際の OS レベル解決結果 (realpath) を根拠にする

### 4. hello を fs_list / fs_read の必須前提にする (IDENTITY_OPS へ追加) [提案]

- 現行 `IDENTITY_OPS` (`post`/`create_room`/`next_room`/`subscribe`/`notify`/`leave`) に `fs_list`/`fs_read` を追加し、hello なしでの到達を `hello_required` で拒否する
- DR-0004 追補の Critical 修正で `rooms`/`read`/`peers`/`shutdown` を hello 必須化 **しない** 判断をした理由 (「Origin 検証で reachable == user が既に回復しているため追加防御効果が薄い」「`shutdown` は CLI の `connectIfRunning` 経路と衝突する」) は fs 系には当てはまらない: fs_list/fs_read は新規 op であり、CLI の既存呼び出し経路と衝突する事情が無い。二重の防御層 (Origin 検証 + hello 必須) をコストなく積める場面で積まない理由が無い。よって fs 系だけ既存 4 op と異なり hello 必須にする

### 5. fs_read は FS_READ_MAX_BYTES で truncate、先頭 8KiB の NUL で binary 判定 [提案]

- 512 KiB (`FS_READ_MAX_BYTES`) を超えるファイルは切り詰めて `truncated: true` を返す。webui のコードビューアが単一ファイルで無制限にメモリ・帯域を消費しないための上限
- 先頭 8 KiB に NUL バイトが 1 つでもあれば binary と判定し、`content` を空にして `binary: true` のみ返す。テキストビューアに任意の binary データを流し込んで表示崩れ・意図しないレンダリングを起こさないための簡易判定 (完全な MIME 判定は行わない — ビューア用途には十分)

### 6. ビューア v1 はプレーンテキスト + 行番号、シンタックスハイライトは持たない [提案]

- Phase 1 のスコープは「リモートからファイルが読める」の解消。シンタックスハイライトは強く欲しい機能ではあるが、`packages/webui` は DR-0004 §4 で「vanilla ESM JS + CSS、フレームワーク・bundler なし」と定めており、monaco / highlight.js 等の同梱は bundle サイズと依存追加を伴う
- 素のビューア (行番号付きプレーンテキスト) で「読める」要件は満たせるため、ハイライトは後続 issue として切り出す

## Security boundary (DR-0004 addendum との関係)

- 本 DR は DR-0004 Critical trust-model 修正 (Origin 検証 + loopback bind) が既に前提として効いている状態に乗る。fs_list/fs_read は新しい攻撃面を作るのではなく、既存の「webui から到達できる = kawaz 本人」という trust boundary の中で読み取り操作を追加するだけ
- `CCMSG_HTTP_ALLOW_ORIGIN` で追加した origin (tailscale serve 経由の `https://<machine>.<tailnet>.ts.net` 等) からも fs_list/fs_read は到達可能になる。これは制限ではなく **まさに Context の kawaz 発言が指すユースケース本体** (リモート = スマホ等からのファイル閲覧)
- 書き込み系 API (ファイル編集・作成・削除、コマンド実行等) は本 DR のスコープ外。将来必要になれば「作業操作系」として別 DR を立てる (読み取りより遥かに大きい trust 判断を要するため、混ぜて拡張しない)

## Alternatives considered

- **REST エンドポイント (`GET /api/fs/list` 等)**: 不採用。DR-0004 §2 の「同じプロトコル」原則に反し、op 追加のたびに REST 層も二重メンテになる
- **任意 root 指定 + allowlist env (`CCMSG_FS_ALLOW_ROOTS` 等)**: 不採用。「webui から到達できる = kawaz 本人の操作範囲」という trust model を、設定ミスや将来の env 追加時の考慮漏れで壊しうる形にしたくない。「現在接続中セッションの cwd のみ」は追加設定なしに安全側へ自動的に閉じる
- **monaco-editor / highlight.js 同梱によるシンタックスハイライト**: 不採用 (現 Phase)。DR-0004 §4 のビルドレス・軽量方針に反する。プレーンテキストビューアで Phase 1 の要件 (リモートから読める) は満たせるため、ハイライトは後続 issue

## Consequences

- kawaz は tailscale 経由のスマホ等からでも、現在走らせている Claude Code セッションの cwd 配下のファイルを push 前でも閲覧できる — Context の「リモートからだとファイルが見れないのが辛い」の解消
- 閲覧可能な範囲はセッションの生存期間に紐づく (= セッションが終了して peers から消えれば、その cwd への `sid` 経由アクセスも失われる)。これは制限ではなく「現在能動的に作業しているディレクトリだけ」という意図した安全側の挙動
- ルーム一覧・チャット UI は本 Phase で変更しない (Context 参照。既存実装で要件充足と判断)

## Next steps

1. daemon: `fs_list`/`fs_read` ハンドラ実装 (realpath containment、`FS_READ_MAX_BYTES` truncate、binary 判定)、`IDENTITY_OPS` へ追加、`ErrorCode` (`session_not_found`/`path_forbidden`/`not_found`) の使用箇所実装、テスト
2. packages/webui: ファイルツリー + プレーンテキストビューア (行番号付き) の実装
3. dogfood: tailscale 経由スマホからのファイル閲覧の実機確認 (kawaz)
