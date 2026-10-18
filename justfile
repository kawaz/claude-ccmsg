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
# 配布物 (packages/ の CLI・daemon、launcher、hook スクリプト) と、その挙動を
# 左右する lock / tsconfig を対象にする。docs/ や *.md / justfile / version ファイル
# 自身などは除外。completions 等を足したらここに追記する。

bump-trigger-paths := "packages/ bin/ hooks/ bun.lock tsconfig.json"

# bump 対象の version ファイル群 (claude-plugin 固有: 3 ファイルの version 一致は bump-semver が保証)

version-files := ".claude-plugin/plugin.json .claude-plugin/marketplace.json package.json"

# package 別のカバレッジ下限 (`package:lines%:functions%`)。coverage/lcov.info の合計
# (LH/LF・FNH/FNF) と比べ、どれかを下回ったら `just coverage` を落とす。
# 値の根拠は docs/findings/2026-10-14-test-coverage-baseline.md

coverage-thresholds := "protocol:97:98 daemon:80:88 cli:87:85 webui:74:80 hooks:90:93"

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

# CI 単一エントリ (lint→typecheck→coverage (= test + 計測)→validate→hooks module の bundle 確認を依存重複排除で1回ずつ保証)
ci: lint typecheck coverage validate check-hooks-bundle

# ---------- dev recipes (push/ci の依存、利用者が直接叩くこともある) ----------

# macOS Translation.framework helper を単発ビルド (DR-0023)。CI 依存には
# しないため、Translation.framework の無い Linux でも通常の ci は通る。
build-translate-helper:
    mkdir -p packages/translate-helper/.build
    swiftc -parse-as-library -framework Translation packages/translate-helper/main.swift -o packages/translate-helper/.build/translate-helper

# lint (justfile フォーマット確認 + oxlint (type-aware) + oxfmt の整形確認。TS の型チェックは typecheck recipe で行う)
lint:
    just --fmt --check --unstable
    bun x oxlint
    bun x oxfmt --check
    just docs-lint

# docs の機械検査 (Jev は呼ばない)。指摘が 1 件でもあれば失敗
[private]
[script]
docs-lint:
    command -v docs-lint >/dev/null || { echo "docs-lint: not installed, skipped" >&2; exit 0; }
    out=$(docs-lint --machine-only . 2>/dev/null)
    hits=$(printf '%s' "$out" | jq '[.machine.checks[]] | add')
    if [ "$hits" != "0" ]; then printf '%s' "$out" | jq '.machine.checks | with_entries(select(.value > 0)), .machine.aggregates'; exit 1; fi

# 型チェック (monorepo 全体を tsc --noEmit。webui の client (preact/TSX, DOM lib)
# はルート tsconfig の除外先なので packages/webui/tsconfig.json で別途チェック)
typecheck: lint
    bun x tsc --noEmit
    bun x tsc --noEmit -p packages/webui

# テスト (bun test で全 package の *.test.ts を実行)
# warm は macOS の Gatekeeper 評価 (inode 単位、初回 exec 時に同期ブロック) を
# テストの外で先に済ませるための前処理。詳細は packages/testkit/src/mock-bin.ts
# セッションの環境変数 (CLAUDE_CODE_* / CCMSG_*) は外して走らせる。Claude Code の
# セッション内から回すと CLI がその sid を自分の identity として継承し、CI (どの
# セッションでもない) と結果が変わるため。
test: lint typecheck
    bun packages/testkit/src/warm.ts
    env -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_CHILD_SESSION -u CCMSG_SID bun test

# テスト + カバレッジ計測 (要約を表示し coverage/lcov.info を出力、package 別下限を検査)。
# 計測の設定 (除外パターン等) は bunfig.toml の [test]
coverage: lint typecheck
    bun packages/testkit/src/warm.ts
    env -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_CHILD_SESSION -u CCMSG_SID bun test --coverage
    @just _coverage-check

# coverage/lcov.info を package 別に合計し coverage-thresholds と比べる。
# bun の coverageThreshold はファイル単位で判定する (1 ファイルでも下回れば落ちる) ため
# package 単位の下限には使えず、ここで検査する
[private]
[script]
_coverage-check:
    awk -v thresholds="{{ coverage-thresholds }}" '
      /^SF:/ {
        path = substr($0, 4)
        if (path ~ /^packages\//) { split(path, seg, "/"); pkg = seg[2] }
        else if (path ~ /^hooks\//) { pkg = "hooks" }
        else { pkg = "other" }
      }
      /^LF:/ { lf[pkg] += substr($0, 4) }
      /^LH:/ { lh[pkg] += substr($0, 4) }
      /^FNF:/ { ff[pkg] += substr($0, 5) }
      /^FNH:/ { fh[pkg] += substr($0, 5) }
      function pct(hit, found) { return found == 0 ? 100 : 100 * hit / found }
      END {
        n = split(thresholds, items, " ")
        fail = 0
        printf "%-10s %8s %8s %12s\n", "package", "lines%", "funcs%", "min(l/f)"
        for (i = 1; i <= n; i++) {
          split(items[i], t, ":")
          p = t[1]
          l = pct(lh[p], lf[p]); f = pct(fh[p], ff[p])
          ng = (l < t[2] || f < t[3])
          printf "%-10s %8.2f %8.2f %12s%s\n", p, l, f, t[2] "/" t[3], ng ? "  FAIL" : ""
          if (ng) fail = 1
        }
        if (fail) { print "coverage が下限を下回った (下限は justfile の coverage-thresholds)" > "/dev/stderr"; exit 1 }
      }
    ' coverage/lcov.info
# Claude Plugin の構造検証
validate: lint
    claude plugin validate .

# hooks module (hooks/composer-fill.ts) を Claude Code が読む 1 ファイルに bundle する (DR-0038 §4)
build-hooks:
    bun hooks/bundle.ts

# 配る bundle (hooks/composer-fill.bundle.js) が今の source の bundle か確かめる。
# GitHub CI は bundle の 1 行目が記録している bun でこれを走らせる (.github/workflows/ci.yml の hooks-bundle)
check-hooks-bundle:
    bun hooks/bundle.ts --check

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

# push 成功直後の local 反映: 全 config dir (~/.claude*/) の marketplace + plugin を
# update する。全面を回す claude-plugin-update.sh (dotfiles) が PATH に無い環境では
# 現セッションの config dir だけ update する。ccmsg が未 install の環境 (skeleton
# 段階等) では skip 扱いにする (- prefix)。
[private]
_local-plugin-reload:
    -@if command -v claude-plugin-update.sh >/dev/null; then claude-plugin-update.sh; else claude plugin marketplace update ccmsg-v1 && claude plugin update ccmsg-v1@ccmsg-v1; fi
    -@just _local-daemon-upgrade
    @echo ""
    @echo "[hint] /reload-plugins to apply in this session without restart"

# push 直後に最新 plugin cache 実体で daemon へ 1 回接触し、newer-wins upgrade を
# 即時発動させる (issue 2026-07-12-post-release-daemon-upgrade-lag 案 (a))。
# これが無いと新バージョン client の初接触まで旧 daemon (旧 webui bundle) が
# 配信され続ける。接触は読むだけの peers で行う (daemon の版を比べて入れ替える
# のは daemon を起こす経路 (ensureDaemon) を通るコマンドだけで、status は通らない)。
[private]
[script]
_local-daemon-upgrade:
    cache_dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/cache/ccmsg-v1/ccmsg-v1"
    latest=$(ls "$cache_dir" | sort -V | tail -1)
    [ -x "$cache_dir/$latest/bin/ccmsg" ] || exit 0
    "$cache_dir/$latest/bin/ccmsg" peers > /dev/null 2>&1 || true
    echo "[local-daemon-upgrade] contacted daemon with v$latest client (newer-wins)"

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
