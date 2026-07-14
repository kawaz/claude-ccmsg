# DR-0015: Composer 添付ファイル機能

- **Status**: Proposed
- **Date**: 2026-07-14
- **前提**: [DR-0001](./DR-0001-central-daemon-architecture.md) の room model、[DR-0003](./DR-0003-wire-protocol.md) の post、[DR-0004](./DR-0004-webui-architecture.md) の HTTP transport (webui backend)、[DR-0010](./DR-0010-timeline-markdown-rendering.md) の Markdown rendering
- **記述規約**: DR-0001 と同じ ([kawaz] / [提案] / [保留])

## 1. Context / 動機

kawaz が新機能を発案 (r12 mid=35、verbatim §7):

> ROOM の入力フォーム左側に画像アップロードボタン (iOS の写真ライブラリ) とファイルアップロードボタン (ダウンロードとか iCloud ファイルなどの選択のやつ) を置きたい。

現状の Composer はテキストのみ。webui で kawaz が room を眺めながら「これ見て」的な画像/ファイルを共有する経路が無い。kawaz は iOS PWA からの共有導線を含めて要望している (task #17 の topbar reload と同源の PWA UX 補完)。

## 2. Decision

### 2.1 添付保存先とライフサイクル [kawaz]

- **保存場所**: `TMPDIR/claude-ccmsg-<uid>/attachment/<UUID>.<ext>` (daemon プロセスの effective uid、`TMPDIR` は `os.tmpdir()` 相当)
- **ファイル名**: 保存名は **UUID + 拡張子** (元ファイル名は別途 metadata で保持)
- **cleanup**: **OS の TMPDIR 削除ポリシーに任せる** [kawaz]。daemon は消さない (再起動時 scan もしない)。参照が切れた添付は最終的に OS が回収する
- **可視性**: 同一 UID の全プロセスが読める。同一 UID trust (DR-0001 §5) の枠内

### 2.2 Upload 経路 [提案]

- daemon の HTTP transport (DR-0004、webui backend の同経路) に **`POST /attachment`** endpoint を追加
- Body: `multipart/form-data`、`file` field で binary 送信
- Response: `{ok: true, uuid, ext, size, mime, path}`
  - `uuid`: 生成 UUID (拡張子なし)
  - `ext`: 元ファイル名から抽出した拡張子 (`.` 込みで正規化、未知なら空文字)
  - `size`: bytes
  - `mime`: 判定した MIME (`Content-Type` or 拡張子ベース)
  - `path`: 保存フルパス (agent が Bash/Read で開く用途、同一 UID trust の下で公開可)
- **WS 経由の upload は不採用**: base64 encode で 33% overhead + WS frame 制限 (通常 16MB) にすぐ当たる。HTTP multipart なら binary そのままで stream 化も可能
- **サイズ上限**: [保留] daemon config で調整可能に (default 案: 50MB)。超過は `413` response

### 2.3 添付 metadata の protocol 追加 [提案]

- `AttachmentUploadResponse`: `{ok:true, uuid, ext, size, mime, path, name}` (name = 元ファイル名の basename)
- **msg jsonl には attachment 専用フィールドを追加しない**: 添付は本文の **Markdown 記法** で表現する (§2.4)、DR-0010 の rendering 経路にそのまま乗る。これにより既存 read/subscribe/store は無変更で対応可能

### 2.4 本文への markdown 記法埋め込み [kawaz]

- upload 成功時、webui Composer は本文の **カーソル位置 or 末尾** に `[FILE<N>]` プレースホルダを挿入 (N は Composer 内の連番、1 始まり)
- 送信時、Composer が本文の `[FILE<N>]` を `[FILE<N>:<filename>](<path>)` に **置換してから post** する [kawaz]。置換は webui client 側の責務 (daemon は関与しない)
- 保存 msg (jsonl) には最終形の Markdown リンクが記録される
- 例:
  - Composer 入力: `これ見て [FILE1] と [FILE2] を確認`
  - 送信本文 (post 経由で jsonl): `これ見て [FILE1:diagram.png](/tmp/claude-ccmsg-501/attachment/abc-...png) と [FILE2:notes.pdf](/tmp/claude-ccmsg-501/attachment/def-...pdf) を確認`

### 2.5 Composer UI [kawaz]

- 入力フォーム **左側** に:
  - 画像アップロードボタン (`<input type="file" accept="image/*" capture="library">`、iOS で写真ライブラリを開く)
  - ファイルアップロードボタン (`<input type="file">`、iOS でファイル App / iCloud を開く)
- 選択時 **即 upload**、直ちに送信はしない [kawaz]
- 入力欄下に添付一覧を「`FILE<N>: <filename>`」の小さめフォントで並べる (存在アピール)
- 送信 or 手動除去 (× ボタン) で添付一覧から消える
- **clipboard paste**: Composer に paste event listener を張り、`ClipboardEvent.clipboardData.items` に `image/*` mime があれば file として抽出して upload 経路に流す [kawaz]

### 2.6 添付表示 (受信側の rendering)

- 既存の Markdown rendering (DR-0010) に乗る:
  - `[FILE<N>:<name>](<path>)` は Markdown link として解釈される
  - webui は image mime の場合、link ではなくインライン画像表示に切り替える (path は daemon の HTTP endpoint `GET /attachment/<uuid>.<ext>` に置換して browser で表示、または `file://` は browser sandbox で読めないため daemon 経由が必須)
  - agent (Claude Code process) は同一 UID trust の下で `path` を直接 Read / Bash で開ける

### 2.7 daemon の HTTP endpoint `GET /attachment/<uuid>.<ext>` [提案]

- upload された添付を browser から取得できるようにする
- 同一 UID trust の下、webui backend (認証済み webui) からのアクセスは許可
- Content-Type は upload 時に判定した `mime` を返す
- `Content-Disposition` は inline (browser 表示、download 強制しない)

## 3. Alternatives considered

- **WS で base64 upload**: 不採用。overhead + frame size 制限 (§2.2)
- **添付を storage の別ディレクトリ (`~/.local/share/ccmsg/attachments`) に恒久保存**: 不採用 [kawaz、「tmp なので OS 任せで放置で ok」]。恒久保存だと disk 圧迫 + プライバシー (残留) の懸念、tmp が意味論的に正しい
- **msg jsonl に attachment 型を専用フィールドで持つ**: 不採用。既存 Markdown rendering 経路をそのまま使う方が単純で表示 UI 追加コストが小さい
- **daemon 側で `[FILE<N>]` → markdown link 置換**: 不採用。原本文が本文として保存されるべき、client 側で送信前に確定させる方が自然 (置換タイミングを 1 箇所に集約、post req = 最終形)
- **添付 filename に UUID を使わず元ファイル名で保存**: 不採用。ファイル名衝突 (同名の複数 upload) と PATH インジェクション懸念 (`..` を含む名前)、UUID なら両方防げる。元ファイル名は Markdown link の表示用ラベルで保持

## 4. 実装スコープ

### 4.1 protocol (`packages/protocol/src/index.ts`)

- `AttachmentUploadResponse` 型 (HTTP endpoint 用、既存 WS response 型とは別ファミリー)
- `ErrorCode` は既存 `bad_request` などで足りる想定 (専用 code 追加は保留)

### 4.2 daemon (`packages/daemon/src/server.ts`) と HTTP layer

- **`POST /attachment`** endpoint 実装:
  - multipart parser (bun 標準)
  - TMPDIR に mkdir `-p` (`claude-ccmsg-<uid>/attachment/`)
  - UUID 生成 (uuidv4)、拡張子は元ファイル名から抽出 (未知は空)
  - ファイル書き込み → response
  - サイズ上限 chek (default 50MB、超過は 413)
- **`GET /attachment/<uuid>.<ext>`** endpoint 実装:
  - path traversal 対策 (uuid が UUID 形式であること、ext は英数のみ)
  - ファイル存在確認 (無ければ 404、OS が消した場合の想定)
  - Content-Type + Content-Disposition inline で serve

### 4.3 webui (`packages/webui/src/client`)

- `Composer` 拡張:
  - 添付一覧 state (`{n, name, uuid, ext, size, mime, path}[]`)
  - 添付ボタン 2 種 (画像 / ファイル) を左側に配置
  - `<input type="file">` の `onChange` → fetch(`POST /attachment`) → 成功時 state に追加 + 本文にプレースホルダ挿入
  - clipboard `paste` event listener で image mime を検出 → 同経路
  - 添付一覧 UI (小さめフォント、× で除去)
  - 送信時に本文の `[FILE<N>]` 置換して post
- 添付一覧の表示コンポーネントは Composer と分離 (`ComposerAttachments.tsx` 等) [提案]

### 4.4 SKILL (`skills/ccmsg/SKILL.md`)

- **添付ファイル** 節を新設:
  - webui からの添付は Markdown link 形式 (`[FILE<N>:<name>](<path>)`) で本文に埋め込まれる
  - agent 側は path から直接 Read/Bash で開ける (同一 UID trust)
  - path は `TMPDIR/claude-ccmsg-<uid>/attachment/<uuid>.<ext>`、OS の tmp 削除タイミングで消える (長期保存は期待しない)

## 5. Open questions

- **サイズ上限**: default 50MB か、config で調整可能にするか — 実装時判断 [保留]
- **画像 mime 判定**: MIME sniff (magic bytes) を daemon 側でやるか、拡張子ベースで足りるか — [提案] 拡張子ベースで開始、実運用で false-positive が出たら sniff 追加
- **同一 UUID 衝突**: UUIDv4 なので実質衝突なしだが、既存ファイルがある場合に上書きを許すか error にするか — [提案] 存在チェック → 存在なら 500 error (実質発生しない安全網)
- **webui 側の image インライン表示ロジック**: MIME 見て `<img>` にするか、link のまま Markdown renderer に任せるか — [提案] MIME `image/*` は `<img>` に置換、他は link のまま
- **agent への path 通知**: agent は post 経由で受け取った本文の Markdown link を parse するだけ ([FILE<N>:name](path) の path 部分)、追加の hint フィールドは不要 [提案]

## 6. verbatim (kawaz r12 mid=35、2026-07-14)

> ROOMの入力フォーム左側に画像アップロードボタン（iOSの写真ライブラリ）とファイルアップロードボタン（ダウンロードとかiCloudファイルなどの選択のやつ）を置きたい。ファイルや画像選択したら即送らず入力欄の下に添付ファイルがあるかのように表示しておくだけでメッセージ送信と共にファイルも送りつける。クリップボードにmimeがimageが入ってればペーストで添付したい。ファイル自体はwsに乗せるとデカくて気になるなら別postでも良いやり易い形でok。添付した時点で即uploadで送る。送る際「UUID.拡張子」で送りフォーム下に「FILE1:ファイル名」みたいなのを小さめフォントで並んで存在アピールしてれば良い。添付ファイルはTMPDIR/claude-ccms-{uid}/attachment/UUID.ext とか適当な場所に置く。アップロードしたらメッセージ本文にのカーソル位置または末尾に [FILE1] とテキスト挿入。送信時には [FILE1] の部分を [FILE1:ファイル名](フルパス/uuid.ext) に書き換えてjsonlに記録して通知を送る。アップロード一時ファイルの削除はtmpなのでOS任せで放置でok。

(kawaz 原文の `claude-ccms-` は typo、実装では `claude-ccmsg-` を採用)

## 7. Next steps

1. 本 DR を kawaz 確認のうえ Accepted へ
2. 実装: daemon HTTP endpoint (POST/GET) → protocol 型追加 → webui Composer 拡張 → SKILL 追記 の順で 1 バッチ
3. 1on1 実装 (DR-0014 バッチ) の完了後、または並行で
4. v0.28.0 想定 (additive feature、minor bump)
