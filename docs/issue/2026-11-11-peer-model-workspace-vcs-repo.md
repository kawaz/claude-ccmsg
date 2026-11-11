---
title: peer-model-workspace-vcs-repo セッションの一覧のモデルを整理する
status: open
category: design
created: 2026-11-11T21:02:22+09:00
last_read:
open_entered: 2026-11-11T21:02:22+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered:
discard_reason:
pending_reason:
close_reason:
blocked_by:
origin: kawaz の指示 (2026-11-11)
---

# peer-model-workspace-vcs-repo セッションの一覧のモデルを整理する

## 概要

daemon が配るセッションの一覧 (op `peers` の答えと `ev:"peers"`、`PeerInfo`。CLI の `ccmsg peers` と webui の Sessions 一覧が使う) の欄を整理する。kawaz の指示 (2026-11-11): `ws` は会話での呼び方がそのまま欄の名前になったもので、モデルの欄の名前として良くない。VCS の種類 (git / jj) と remote の一覧も持ちたい。`repo` を `{ owner, name, url }` のように整理したい。セッションの名前も、daemon が突き合わせればすぐ得られるのに載っていない。

## 背景

### 今の欄 (コードで確かめた事実)

- `repo`: `owner/name` の文字列。`ws`: jj の workspace / git の worktree の名前で、無ければ branch の名前 (2 つの意味が混ざっている。`packages/cli/src/session-begin.ts` の `deriveWs`、`packages/daemon/src/repo-derive.ts`)。`branch`: 今の branch / bookmark。`repo_root`: そのリポの workspace 群を収めるディレクトリ (ファイルのブラウズの根、DR-0008)。`repo_url`: リポの web のページの URL (認証情報を落としてある)
- `name` は `PeerInfo` に無い。名前は Claude Code の記録から読むもので、daemon はプロセスの一覧 (`agents`、`AgentInfo`) の側に持っている。webui は `peers` と `agents` を両方購読してセッション id で突き合わせている。CLI の `ccmsg peers` は `peers` しか聞かないので名前が出ない。`.claude/skills/verify/SKILL.md` は試験用セッションの名前を「`ccmsg peers` で見分けられるように」付けると書いているが、今の出力では見分けられない
- daemon は cwd から上へ `.jj` / `.git` を探してどちらかを判定している (`repo-derive.ts` の `findRepoRoot` の `backend`) が、結果を捨てている。git の設定ファイルから全部の remote を読んでいる (`parseGitConfigRemotes`) が、origin (無ければ唯一の remote) を 1 つ選んで使っているだけ。どちらも追加の読み取りなしで載せられる。導出はセッションの登録のたびに走る

### 進め方 (kawaz の裁定 2026-11-11: 2 段に分ける)

- **1 段目: 追加だけ。** `ws` を残したまま、新しい欄を足す。セッションが daemon に名乗る形 (hello) は変えないので、protocol への影響は無く、動いているセッションの再起動は要らない。足すもの: セッションの名前、`workspace` (workspace / worktree の名前だけ。branch を混ぜない)、VCS の種類、remote の一覧、リポの詳細
- **2 段目: `ws` を消す。** `ws` を使っている所 (hello の欄、webui、CLI、DR) を `workspace` に向け直してから消す。hello の形が変わるので、protocol の版の上げ方と、動いているセッションの再起動の要否をここで決める

### 決まっていないこと (`docs/QUESTIONS.md` の HP-Q1)

- VCS の欄を `vcs: { type, workspace?, branch?, remotes: [{ name, url }] }` のようにまとめるか、`vcs_type` / `vcs_remotes` のように並べるか (kawaz の最初の書き方は後者、統括の案は前者)
- `repo` の形。今の `repo` は文字列なので、同じ名前のまま `{ owner, name, url }` にすると既存の欄の型が変わり、1 段目の「追加だけ」に収まらない。1 段目では別の名前で足すか、2 段目で `ws` と一緒に形を変えるか
- `repo` に host を入れるか (入れると forge ごとに違うもの、例えば issue の URL の作り方を host で分けられる。今は `#123` のリンクが GitHub 決め打ち、`packages/webui/src/client/issue-ref.ts`)。owner が多段の時 (GitLab の `group/sub/demo`) の分け方
- セッションの名前を `PeerInfo` に足すと、名前が変わるたびに `ev:"peers"` が全タブに流れる (今は `agents` の知らせだけ)。頻度は `/rename` の時だけ

### 守ること

- remote の URL には認証情報が入っていることがある (`https://user:token@host/…`)。載せる時は URL から認証情報を落とす (`repo_url` を作る `remoteWebUrl` と同じ扱い)
- エージェントが使う tool の `peers` の出力 (`peer_list`) には欄を足さない (kawaz の裁定: 相手を選ぶ材料にならず、1 行が長くなるだけ。[findings 2026-11-11-peers-tool-usage](../findings/2026-11-11-peers-tool-usage.md))
- 後方互換のための分岐や版の比較は置かない。1 段目で `ws` を残すのは、hello の形を変える作業を 2 段目に分けるためで、互換のためではない

## 受け入れ条件 (1 段目)

- [ ] `ccmsg peers` の出力の各セッションに、名前・workspace・VCS の種類・remote の一覧・リポの詳細が載る
- [ ] remote の URL に認証情報が出ない
- [ ] hello の形と hooks の bundle が変わらない (動いているセッションがそのまま動く)
- [ ] webui が名前を `peers` から取れるなら、`agents` との突き合わせを減らす (減らさないなら理由を書く)
- [ ] DR を今の形に合わせ、verify の手順書の記述と実物が合う
