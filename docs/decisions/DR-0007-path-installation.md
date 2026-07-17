# DR-0007: PATH への symlink インストールと自己更新

- **Status**: Accepted (2026-07-10、kawaz 提案の擬似コードに基づく。細部の [提案] は実装先行)
- **Date**: 2026-07-10
- **Author**: kawaz (整理: AI agent)
- **一次資料**: 本セッション 2026-07-10 の kawaz 発言 (擬似コード付き提案、下記 Context に転記)

## 記述規約 (attribution)

DR-0001 と同じ: **[kawaz]** / **[提案]** / **[保留]**。

## Context

kawaz が人間として `ccmsg` を叩くには PATH に居てほしいが、plugin の実体は versioned な plugin cache (`~/.claude*/plugins/cache/ccmsg/ccmsg/<version>/bin/ccmsg`) にあり、update のたびにパスが変わる。kawaz 提案 [kawaz、逐語]:

> SessionStart時、
> if PATHにccmsgがない
> if PATHに ~/.local/bin や ~/bin といった安定パスがある
> if 安定パスの候補を提示してそこにccmsgのsymlynkを置いて良いかをユーザに確認して許可されたら
> ln -sfn /path/to/versioned/bin/ccmsg {user_bin}/ccmsg でPATHを通す
>
> 以降、ccmsg 実行時、
> if 自身の $0 内のパスに自身のバージョンを含むか？ # hooks からプラグイン内のbin/ccmsgを実行する際はフルパスを使うはず
> if PATH に ccmsg が存在
> if 自身のバージョン > ccmsg --version
> ln -sfn でsymlinkを作り直す

## Decision

### 1. 初回インストール: SessionStart hook 経由でユーザ確認の上 symlink [kawaz]

- SessionStart hook が「PATH に ccmsg が無い」かつ「PATH 上に書き込み可能な安定 dir (`~/.local/bin` → `~/bin` の優先順) がある」時、additionalContext で AI に**ユーザ確認 (AskUserQuestion) を指示**する。許可されたら AI が `ln -sfn <versioned>/bin/ccmsg <stable>/ccmsg` を実行
- hook 自身は symlink を作らない (ユーザ確認が挟めないため。確認フローは AI が担う) [提案]
- **拒否の記録**: ユーザが断ったら state dir に decline マーカーを置き、以後のセッションでは提案しない (毎セッション nag の防止)。気が変わったらマーカー削除 or 手動 ln で opt-in [提案]

### 2. 自己更新: launcher (`bin/ccmsg`) が実行のたびに best-effort で symlink を進める [kawaz]

発火条件 (すべて成立時のみ、bash の文字列操作で完結させ bun を起動しない):

1. **自身の `$0` の実パスに自身の version ディレクトリが含まれる** (= plugin cache からの実行。dev checkout からの実行は対象外) [kawaz]
2. PATH に `ccmsg` が存在し、それが **symlink で、かつ plugin cache の versioned パスを指している** (それ以外 — 実ファイルや dev checkout への手動リンク — は**触らない**) [提案]
3. リンク先パスから読み取った version より **自分の version が新しい** (比較は readlink + パス文字列パース。`ccmsg --version` の subprocess 実行はしない — このチェックは毎 hook 呼び出しにも乗るため) [提案、kawaz 擬似コードの `--version` 比較の実装置換]

成立したら `ln -sfn` で自分に張り替える。全経路 best-effort (失敗しても本来のコマンド実行を妨げない、stderr にも既定では出さない)

### 3. `ccmsg --version` サブコマンドの追加 [提案]

- 人間が PATH の ccmsg の版を確認する手段として `--version` / `version` を追加 (CLI 衛生)。自己更新の判定には使わない (§2)

### 4. AI は引き続き `${CLAUDE_PLUGIN_ROOT}/bin/ccmsg` を使う (不変)

- SKILL.md の「PATH の ccmsg を使わない」規約は不変。PATH symlink は**人間 (kawaz) 用**であり、AI の version 固定の要請とは別物 *(2026-07-17 supersede: kawaz r26 mid=92 裁定で launcher 自身が semver 比較の self-redirect を持つように変更 — AI は引き続き絶対パスで起動してよいが、launcher が PATH 上の新しい版へ自動 exec する。issue cli-self-exec-latest 参照)*

## Alternatives considered

- **`ccmsg --version` subprocess での比較** [kawaz 擬似コード]: 実装置換。毎実行 (hook 含む) に bun 起動が乗るのは重く、versioned パス文字列に同じ情報がある
- **PATH 上の ccmsg を無条件に張り替え**: 不採用。dev checkout への手動 symlink 等、ユーザの意図的な配置を壊す
- **hook が直接 symlink を作る (確認なし)**: 不採用。ユーザの PATH への書き込みは明示同意が要る [kawaz の確認要求]
- **shell rc への PATH 追記**: 不採用。rc 汚染より既存の安定 bin dir への symlink が非侵襲

## Consequences

- kawaz は素のターミナルから `ccmsg` を叩ける。plugin update 後も次の ccmsg 実行 (hook の ensure 含む) で symlink が自動追従する
- 複数 CLAUDE_CONFIG_DIR 環境 (personal / 業務 overlay) で cache パスが異なっても、newer-wins なので最新版に収束する
- decline マーカーは state dir 配下 (機械可読)。「提案が来なくなった」時はそこを見る

## Next steps

1. `bin/ccmsg` に自己更新ロジック、SessionStart hook に検出 + AI への確認指示、CLI `--version` を実装
2. launcher の自己更新はテストで輪郭を固定 (新しい時だけ張り替え / 非対象 symlink 不干渉 / dev 実行不発火)
