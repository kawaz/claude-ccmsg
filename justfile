# claude-ccmsg
#
# kawaz/* リポの共通テンプレ (kawaz/bump-semver justfile が canonical) に揃えてある。
# 言語依存箇所 (lint/typecheck/test) と claude-plugin 固有 (validate) のみカスタム。
# VCS 操作 (clean 判定 / diff / push / commit) と翻訳鮮度チェックは bump-semver vcs
# サブコマンド (DR-0020 / DR-0027) に委譲し、jj/git 分岐の手書きを撲滅する。
# 構造変更は bump-semver 側を先に直してからこちらへ追従する。
# ---------- settings ----------

set unstable
set guards
set lazy
set shell := ["bash", "-eu", "-o", "pipefail", "-c"]
set script-interpreter := ["bash", "-eu", "-o", "pipefail"]

# ---------- variables ----------
# bump-version トリガとなる product code パス (テンプレ流用時に各リポで上書き)。
# 配布物 (packages/ の CLI・daemon、launcher、hook スクリプト、skill) と、その挙動を
# 左右する lock / tsconfig を対象にする。docs/ や *.md / justfile / version ファイル
# 自身などは除外。completions 等を足したらここに追記する。

bump-trigger-paths := "packages/ bin/ hooks/ skills/ bun.lock tsconfig.json"

# bump 対象の version ファイル群 (claude-plugin 固有: 3 ファイルの version 一致は bump-semver が保証)

version-files := ".claude-plugin/plugin.json .claude-plugin/marketplace.json package.json"

# ---------- default ----------

# レシピ一覧を表示
default:
    @just --list

# ---------- main entries (利用者が直接叩く) ----------

# push (バージョン bump 済みを前提、全 gate 通過後に push してローカルも更新)
push: check-on-default-branch ensure-clean ci check-translations check-versions check-version-bumped
    bump-semver vcs push --branch main --jj-bookmark-auto-advance
    @just _local-plugin-reload

# push (ドキュメント更新等のみで bump 不要な場合)
push-without-bump: check-on-default-branch ensure-clean ci check-translations check-versions
    bump-semver vcs push --branch main --jj-bookmark-auto-advance
    @just _local-plugin-reload

# version を bump して Release commit を作成 (push は別途 `just push`)
[script]
bump-version bump="patch": ensure-clean
    new_version=$(bump-semver {{ bump }} {{ version-files }} --write --no-hint)
    bump-semver vcs commit --allow-nonexistent-path -m "Release v${new_version}" {{ version-files }}

# CI 単一エントリ (lint→typecheck→test→validate を依存重複排除で1回ずつ保証)
ci: lint typecheck test validate

# ---------- dev recipes (push/ci の依存、利用者が直接叩くこともある) ----------

# lint (justfile フォーマット確認のみ。TS の型チェックは typecheck recipe で行う)
lint:
    just --fmt --check --unstable

# 型チェック (monorepo 全体を tsc --noEmit)
typecheck: lint
    bun x tsc --noEmit

# テスト (bun test で全 package の *.test.ts を実行)
test: lint typecheck
    bun test

# Claude Plugin の構造検証
validate: lint
    claude plugin validate .

# 現在の version を表示 (3 ファイルの一致確認も兼ねる)
version:
    @bump-semver get {{ version-files }} --no-hint

# ---------- check recipes (push の sanity 検証、基本は push 経由でしか叩かない) ----------

# 現在の bookmark/branch が default (= main) 上にあるか確認 (DR-0038 dogfood)。
[private]
[script]
check-on-default-branch:
    if ! bump-semver vcs is on-default-branch; then
        bn=$(bump-semver vcs get default-branch)
        printf >&2 "⚠ default branch (%s) に合流してから push してください\n  1. just sync         # %s@origin に rebase\n  2. just promote      # %s bookmark を current commit に forward\n  3. %s ワークスペースに移動して just push\n" "$bn" "$bn" "$bn" "$bn"
        exit 1
    fi

# 現在の worktree を default branch (= origin/<default>) に rebase (DR-0038)
sync:
    bump-semver vcs sync --onto $(bump-semver vcs get default-branch)@origin

# default branch を現在の commit に forward (DR-0038、push しない)
promote:
    bump-semver vcs promote

# ワーキングコピーがクリーン (jj は @ が empty、git は porcelain 空。git/jj-agnostic, DR-0020)
ensure-clean: lint
    bump-semver vcs is clean

# 3 ファイル (plugin.json / marketplace.json / package.json) の version 一致を保証。
[private]
check-versions:
    @bump-semver get {{ version-files }} --no-hint >/dev/null

# push 成功直後の local 反映: 現セッションの marketplace + plugin を update する。
# ccmsg が未 install の環境 (skeleton 段階等) では skip 扱いにする (- prefix)。
[private]
_local-plugin-reload:
    -claude plugin marketplace update ccmsg
    -claude plugin update ccmsg@ccmsg
    @echo ""
    @echo "[hint] /reload-plugins to apply in this session without restart"

# 翻訳ペア (NAME-ja.md / NAME.md) の整合性チェック
check-translations: ensure-clean check-translation-freshness (_check-translation-headers "README")

# 翻訳ペアの鮮度: en の最終 commit timestamp >= ja (DR-0027)。
[private]
check-translation-freshness:
    bump-semver vcs outdated 'glob:**/*-ja.md' '$1/$2.md'

# 相互リンクヘッダの確認 (vcs outdated は timestamp のみ検証するので grep は別途)。
[private]
_check-translation-headers name:
    ?test -f {{ name }}-ja.md
    test -f {{ name }}.md
    head -5 {{ name }}-ja.md | grep -qF "> 🇬🇧 [README.md](./README.md)"
    head -5 {{ name }}.md    | grep -qF "> 🇯🇵 [README-ja.md](./README-ja.md)"

# product code に変更があれば version も main@origin より bump 済か検証 (変更なしならスキップ)。
[private]
[script]
check-version-bumped:
    rc=0
    bump-semver vcs diff -q main@origin -- {{ bump-trigger-paths }} || rc=$?
    case "$rc" in
      0) exit 0 ;;
      1) ;;
      *) echo "ERROR: bump-semver vcs diff failed (rc=$rc). main@origin が track されていない可能性。先に 'jj git fetch' を試してください" >&2; exit 1 ;;
    esac
    bump-semver compare gt .claude-plugin/plugin.json vcs:main@origin:.claude-plugin/plugin.json --no-hint && exit 0
    echo 'ERROR: bump-trigger-paths が変わってるが version 未 bump。"just bump-version" を実行してください' >&2
    exit 1
