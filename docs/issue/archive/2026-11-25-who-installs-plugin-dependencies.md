---
title: "plugin の依存を入れているのが Claude Code か launcher かを確かめる (DR-0032 §2.2-4 の前提)"
status: resolved
category: task
created: 2026-11-25
origin: "自リポ TODO (plugin のキャッシュの調査で出た食い違い)"
close_reason: documented
---

# plugin の依存を入れているのが Claude Code か launcher かを確かめる

## 食い違い

[DR-0032](../../decisions/DR-0032-repo-split-protocol-first.md) §2.2-4 は「`claude plugin install` / `update` は依存を入れない」を前提に、launcher (`bin/ccmsg`) が依存を入れる形を決めている。一方、Claude Code の公式ドキュメントと 2.1.332 の実行ファイルからは、Claude Code が `bun.lock` を見て依存を入れる仕組み (`bun install --frozen-lockfile --ignore-scripts`) を持つと読める ([findings 2026-11-25-plugin-cache-versions](../../findings/2026-11-25-plugin-cache-versions.md))。

## 分かっていること

- キャッシュの全ての版で、`packages/*/node_modules` が root の `node_modules` と同じ秒にできている。その場の `bun install` の形で、launcher が入れた跡に見える
- `workspaces` を持つ ccmsg を、Claude Code が入れ込みの対象にするかは読み切れていない

## やること

- 隔離した config dir で plugin を入れ、launcher を 1 度も呼ばない状態で `node_modules` ができるかを観測する
- できるなら、launcher の入れ込みと二重になっていないか、DR-0032 §2.2-4 の前提をどう直すかを決める

## 結果 (2026-11-25)

Claude Code 2.1.332 は ccmsg の依存を入れない。Claude Code が依存を入れるのは `bun.lock` の workspace が plugin の root 1 つだけの時で、workspace を複数持つ ccmsg は対象外。入れているのは launcher だけで、launcher を初めて呼んだ時 (セッションなら起動直後の `sidecar begin`) に入る。DR-0032 §2.2-4 の前提は正しく、記述を確かめた事実に合わせた。観測は [findings 2026-11-25-plugin-dependency-install](../../findings/2026-11-25-plugin-dependency-install.md)。
