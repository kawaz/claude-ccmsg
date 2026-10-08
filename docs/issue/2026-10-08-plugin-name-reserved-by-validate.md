---
title: claude plugin validate が plugin 名 claude-ccmsg を reserved として error にする
status: open
category: bug
created: 2026-10-08T11:51:25+09:00
last_read:
open_entered: 2026-10-08T11:51:25+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered:
discard_reason:
pending_reason:
close_reason:
blocked_by:
origin: 自リポ TODO
---

# claude plugin validate が plugin 名 claude-ccmsg を reserved として error にする

## 概要

Claude Code 2.1.293 の `claude plugin validate .` が、このリポの plugin 名 `claude-ccmsg` を "reserved" として error にする。DR-0035 段 1 の実装中に判明した。今回の変更より前からある状態。

2.1.293 では plugin も hooks module も問題なく読まれるが、validate は失敗のまま。`just ci` の validate 段が落ちる可能性と、将来の build で読み込みを拒否される可能性がある。

## validate の error 文言

Claude Code 2.1.293 で取得。`.claude-plugin/marketplace.json` の `plugins[0].name` と `.claude-plugin/plugin.json` の `name` の 2 か所で error になる。marketplace の `name` (`claude-ccmsg`) は error になっていない。

```
Plugin name "claude-ccmsg" is reserved: it passes as one of Anthropic's own. A third party's plugin name cannot start with "claude-", "anthropic-", "anthropics-", or "cc-plugin-", be "claude", "anthropic", "anthropics", "claude-code", or "claude-mods", or put "official" beside "claude" or "anthropic". Name it for what it does.
```

## 方針

plugin 名を `ccmsg-v1` に改名する (kawaz 提案、統括賛成)。

- `ccmsg` は v2 (kawaz/ccmsg) の plugin 名と衝突するため使えない。marketplace.json に既に `renames: {"ccmsg": "claude-ccmsg"}` があり、一度 ccmsg から離した経緯がある
- docs でも本リポを v1 と呼んでいる
- 改名は DR-0035 の段 1 と同じリリースに載せる

## 改名時に確かめること

- marketplace.json の `renames` に `claude-ccmsg` → `ccmsg-v1` を足すと、インストール済み環境が移行されるか
- plugin 名を前提にした箇所の洗い出し。grep で見つかった候補: `.claude-plugin/plugin.json` / `.claude-plugin/marketplace.json` の name、`hooks/hooks.json` の command marker (`#ccmsg`)、`justfile` (plugin update と `plugins/cache/claude-ccmsg/claude-ccmsg` の cache_dir)、`README.md` / `README-ja.md` の install / update コマンド
- marketplace 名を変えるか。validate は marketplace 名を error にしていないので据え置きが候補

## 受け入れ条件

- [x] reserved とされる規則を validate の出力で確認する (`claude-` 始まり等、上記 error 文言)
- [x] plugin 名の変更が要るか判断する (`ccmsg-v1` へ改名)
- [x] `renames` による移行、hooks marker など plugin 名依存箇所、marketplace 名の扱いを確かめて決める
- [ ] 改名を DR-0035 段 1 と同じリリースに載せる
- [x] `claude plugin validate .` が通る (または通らないままで良い根拠が記録されている)

## 結果

commit 96baae2d で plugin 名を `ccmsg-v1` に改名した。

- `marketplace.json` の `renames` を `{"ccmsg": "claude-ccmsg", "claude-ccmsg": "ccmsg-v1"}` の連鎖にした。公式 docs の host-marketplace "Migrate users with a renames map" と marketplace-reference によると、renames は append-only の履歴として書き、Claude Code は最古の名前から連鎖を辿る。user / project / local scope の `enabledPlugins` と `pluginConfigs` の key が新名に書き換わる。git から追加した marketplace では、一度 `/plugin install <new>@<marketplace>` するまで "not cached" が出続ける
- `hooks/hooks.json` の `#ccmsg` marker は plugin 名に依存せず、どこからも読まれていないので据え置き
- marketplace 名 `claude-ccmsg` は validate で error にならないので据え置き
- Claude Code 2.1.295 で `claude plugin validate .` が passed

## リリース時の移行手順

personal / emrd / bare の 3 config home ごとに行う。

1. `marketplace update claude-ccmsg`
2. settings.json の `enabledPlugins` が `ccmsg-v1@claude-ccmsg` に書き換わったか確認
3. `claude plugin install ccmsg-v1@claude-ccmsg` で cache を作る
4. 旧 cache `plugins/cache/claude-ccmsg/claude-ccmsg/` が残れば、移行確認後に消すか判断 (自動で消えるかは未確認)

残る受け入れ条件: リリースに載せる。
