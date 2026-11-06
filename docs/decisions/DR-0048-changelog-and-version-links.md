# DR-0048: 版ごとの変更点を直下の CHANGELOG.md に書き、bump の gate で節を必須にし、webui の版の表示からその節を開く

- Status: Accepted (2026-11-06、kawaz 裁定) — ✅ 実装済み (`CHANGELOG.md`、justfile の `check-changelog` と `bump-version` / `push` からの呼び出し、webui の `changelog-url.ts` と状態行・GLOBALS の版のリンク)
- Date: 2026-11-06

## Context

webui は版を 2 か所に出している: TL 下の状態行の `ccmsg v<版>` / `claude v<版>` ([DR-0020](./DR-0020-session-status-tab.md) Addendum、[DR-0041](./DR-0041-request-model-effort-override.md) §6.4) と、サイドバーの GLOBALS の daemon の版と Claude Code の版 ([DR-0043](./DR-0043-sidebar-folds-and-globals.md) §5.2〜§5.3)。版が上がったことは見えるが、何が変わったかを見る口が無い。ccmsg の変更は commit log にしか無く、1 版に何十行の commit message が並ぶので、版単位の要点にならない。

Claude Code は版ごとの変更点を `https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md` に `## <版>` の見出しで書いている (2026-11-06 に確認、最新の節は `## 2.1.318`)。GitHub は見出しにアンカーを付ける (`## 2.1.318` → `#21318`、ページの見出しの一覧の `anchor` で確認)。

## Decision

### 1. 目的

版ごとに何が変わったかを 1 画面で見る口を持ち、webui の版の表示からその版の変更点を開けるようにする。増やしたくないものは、版を上げる作業の手数と、変更点を書き忘れた版。

### 2. 置き場はリポ直下の `CHANGELOG.md`

- GitHub はリポ直下の `CHANGELOG.md` を特別扱いし (リポのトップから辿れる)、版の見出しのアンカーで外から版の節へ飛べる。webui のリンク先として安定した URL になる
- kawaz/* の docs の配置規約 (reference の `docs-authoring/docs-layout`) は、直下の文書を `README{,-ja}.md` と任意の `CHANGELOG.md` に限っている。これはその `CHANGELOG.md` にあたる
- 日本語だけで書き、英訳は持たない

### 3. 書式

- Keep a Changelog に倣い、新しい版が上。1 版は数行の箇条書きで、Added / Changed 等の小見出しは置かない
- 版の見出しは `## v<版>` だけにし、日付はその下の 1 行目に書く。見出しに日付を入れると (`## v0.214.1 - 2026-11-06` → `#v02141---2026-11-06`)、版しか知らない webui がアンカーを組み立てられない
- 「Unreleased」の節は持たない。bump のたびに新版の節を書く
- 過去の版は書かない。最初の節は、この仕組みが入る版の節

### 4. bump と push の gate

- justfile の `check-changelog [version]`: `CHANGELOG.md` の最初の `## ` の見出しが `## v<version>` でなければ失敗する。version を省くと今の版 (`bump-semver get` の version ファイル群)
- `just bump-version` は、`bump-semver <bump> <version ファイル群>` を `--write` 無しで実行して新版を先に出し、`check-changelog <新版>` を通ってから version ファイルを書いて Release commit を作る。節が無ければ version ファイルに触れずに止まり、足す節の形 (見出し・日付・箇条書き) をエラー文で示す
- bump する側は、bump の前に節を書いて commit する (`ensure-clean` があるので、書いたまま bump はできない)
- `just push` の deps に `check-changelog` (今の版) を `check-version-bumped` と同じ階層で入れる。Release commit が節を伴うことを push の時にも保証する。`push-without-bump` には入れない (版が変わらない push なので)
- 最初の節が新版であることまで求めるのは、節を古い節の下に書く・版を書き違える誤りも同じ検査で止めるため

### 5. webui の版のリンク

- ccmsg の版 (状態行の `ccmsg v<版>`、GLOBALS の daemon の版) は `https://github.com/kawaz/claude-ccmsg/blob/main/CHANGELOG.md#<アンカー>`、アンカーは見出し `v<版>` の GitHub の規則によるもの (`v0.214.1` → `v02141`)
- Claude Code の版 (状態行の `claude v<版>`、GLOBALS の Claude Code の版) は `https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md#<アンカー>`、アンカーは見出し `<版>` のもの (`2.1.318` → `21318`)
- GitHub の規則: 小文字にし、文字・数字・`_`・`-`・空白以外を落とし、空白を `-` にする。webui の `githubHeadingAnchor` がこれを実装する
- 節の無い版 (古すぎる・新しすぎる) は、ページの先頭が開くだけで壊れない
- 新しいタブで開く (`target="_blank" rel="noopener noreferrer"`、webui の他の外部リンクと同じ)。`noreferrer` で webui の origin (tailnet の名前) を GitHub に送らない
- 見た目: 状態行は「枠なし 1 行、押せるのは値だけ」([DR-0041](./DR-0041-request-model-effort-override.md) §6) のまま、リンクは行の色で下線なし、hover とキーボードの focus で下線を出す。GLOBALS も同じ。hover の説明 (title) の最後の行にリンク先の URL を書く
- 版の値が無い間は、今までどおり状態行に出さない / GLOBALS は `—` で、リンクも無い

## Alternatives Considered

- **`docs/` の下に置く**: 規約の上では置けるが、GitHub の直下の扱いと、外から版へ飛ぶ短い URL を失う
- **GitHub Releases に書く**: 版の作成を `just` の外 (gh / Web) に広げ、オフラインの checkout に変更点が残らない。gate も Releases の API に依存する
- **commit log から自動生成**: commit message は「何をどうした (理由)」の長文で、版の要点にならない。要点の選別は人 (エージェント) の判断で、生成に任せると増やしたくない「読まれない長文」になる
- **見出しに日付を入れる (`## v0.214.1 - 2026-11-06`)**: Keep a Changelog の通常の形だが、webui は版しか知らないのでアンカーを組み立てられない (§3)

## Consequences

- `just bump-version` の前に `CHANGELOG.md` の節を書く手順が 1 つ増える。忘れると bump がエラー文で何を書くかを示して止まる
- 最初の Release (この DR が入る版) より前の版は CHANGELOG に無く、webui のリンクはページの先頭を開く
- Claude Code の CHANGELOG の見出しの形 (`## <版>`) が変わると、そのリンクはページの先頭を開くだけになる (壊れはしない)

## 関連

- [DR-0020](./DR-0020-session-status-tab.md) Addendum — 状態行の版
- [DR-0041](./DR-0041-request-model-effort-override.md) §6 — 状態行の見た目
- [DR-0043](./DR-0043-sidebar-folds-and-globals.md) §5 — GLOBALS の版
