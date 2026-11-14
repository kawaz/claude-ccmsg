---
title: セッションの一覧のモデルを整理する (name / workspace / repository / VCS の種類と remote を足し、その後 ws と repo を消す)
status: open
category: design
created: 2026-11-11T21:02:22+09:00
origin: kawaz の指示 (2026-11-11)
---

# セッションの一覧のモデルを整理する (name / workspace / repository / VCS の種類と remote を足し、その後 ws と repo を消す)

## 概要

daemon が配るセッションの一覧 (op `peers` の答えと `ev:"peers"`、`PeerInfo`。CLI の `ccmsg peers` と webui の Sessions 一覧が使う) の欄を整理する。kawaz の指示 (2026-11-11): `ws` は会話での呼び方がそのまま欄の名前になったもので、モデルの欄の名前として良くない。VCS の種類 (git / jj) と remote の一覧も持ちたい。`repo` は `repository` (`{ owner, name, url }`) に改名して置き換えたい (`ws` → `workspace` と同じ 2 段)。セッションの名前も、daemon が突き合わせればすぐ得られるのに載っていない。

## 背景

### 今の欄 (コードで確かめた事実)

- `repo`: `owner/name` の文字列。`ws`: jj の workspace / git の worktree の名前で、無ければ branch の名前 (2 つの意味が混ざっている。`packages/cli/src/session-begin.ts` の `deriveWs`、`packages/daemon/src/repo-derive.ts`)。`branch`: 今の branch / bookmark。`repo_root`: そのリポの workspace 群を収めるディレクトリ (ファイルのブラウズの根、DR-0008)。`repo_url`: リポの web のページの URL (認証情報を落としてある)
- `name` は `PeerInfo` に無い。名前は Claude Code の記録から読むもので、daemon はプロセスの一覧 (`agents`、`AgentInfo`) の側に持っている。webui は `peers` と `agents` を両方購読してセッション id で突き合わせている。CLI の `ccmsg peers` は `peers` しか聞かないので名前が出ない。`.claude/skills/verify/SKILL.md` は試験用セッションの名前を「`ccmsg peers` で見分けられるように」付けると書いているが、今の出力では見分けられない
- CLI の `ccmsg peers` を使うのはスクリプトや別のリポのセッション (workboard-personal/main 等)。今は名前を知るために、使う側が `claude agents --json` の出力と自分で突き合わせて補っている (kawaz 2026-11-11)。受け入れ条件の「名前が載る」は、この使う側が突き合わせなしで名前を読めること
- daemon は cwd から上へ `.jj` / `.git` を探してどちらかを判定している (`repo-derive.ts` の `findRepoRoot` の `backend`) が、結果を捨てている。git の設定ファイルから全部の remote を読んでいる (`parseGitConfigRemotes`) が、origin (無ければ唯一の remote) を 1 つ選んで使っているだけ。どちらも追加の読み取りなしで載せられる。導出はセッションの登録のたびに走る

### 進め方 (kawaz の裁定 2026-11-11: 2 段に分ける)

- **1 段目: 追加だけ。** `ws` を残したまま、新しい欄を足す。セッションが daemon に名乗る形 (hello) は変えないので、protocol への影響は無く、動いているセッションの再起動は要らない。足すもの: セッションの名前、`workspace` (workspace / worktree の名前だけ。branch を混ぜない)、VCS の種類、remote の一覧、`repository` (`{ owner, name, url }` の形。今の文字列の `repo` は残す)
- **2 段目: `ws` と `repo` を消す。** `ws` と `repo` を使っている所 (hello の欄、webui、CLI、DR) を `workspace` と `repository` に向け直してから消す。`repo_url` は `repository.url` と同じ値になるので、2 段目で一緒に消すかを決める (`repo_root` は役割が違うので残す)。hello の形が変わるので、protocol の版の上げ方と、動いているセッションの再起動の要否をここで決める

### 決まっていないこと (`docs/QUESTIONS.md` の HP-Q1)

- VCS の欄を `vcs: { type, workspace?, branch?, remotes: [{ name, url }] }` のようにまとめるか、`vcs_type` / `vcs_remotes` のように並べるか (kawaz の最初の書き方は後者、統括の案は前者)
- `repository` に host を入れるか (入れると forge ごとに違うもの、例えば issue の URL の作り方を host で分けられる。今は `#123` のリンクが GitHub 決め打ち、`packages/webui/src/client/issue-ref.ts`)。owner が多段の時 (GitLab の `group/sub/demo`) の分け方
- セッションの名前を `PeerInfo` に足すと、名前が変わるたびに `ev:"peers"` が全タブに流れる (今は `agents` の知らせだけ)。頻度は `/rename` の時だけ

### 守ること

- remote の URL には認証情報が入っていることがある (`https://user:token@host/…`)。載せる時は URL から認証情報を落とす (`repo_url` を作る `remoteWebUrl` と同じ扱い)
- エージェントが使う tool の `peers` の出力 (`peer_list`) には欄を足さない (kawaz の裁定: 相手を選ぶ材料にならず、1 行が長くなるだけ。[findings 2026-11-11-peers-tool-usage](../findings/2026-11-11-peers-tool-usage.md))
- 後方互換のための分岐や版の比較は置かない。1 段目で `ws` を残すのは、hello の形を変える作業を 2 段目に分けるためで、互換のためではない

## 受け入れ条件 (1 段目)

- [x] `ccmsg peers` の出力の各セッションに、名前・workspace・VCS の種類・remote の一覧・`repository` が載る
- [x] remote の URL に認証情報が出ない
- [x] hello の形と hooks の bundle が変わらない (動いているセッションがそのまま動く)
- [ ] webui が名前を `peers` から取れるなら、`agents` との突き合わせを減らす → 減らさない (webui が agents を引くのは status / pid 等の名前以外の欄のため。ccmsg 未起動の行は peers に居ないので名前も agents から読むしかない)
- [x] DR を今の形に合わせ、verify の手順書の記述と実物が合う

## 1 段目の結果 (2026-11-11、v0.246.0)

- 足した欄: `name?` / `vcs?: { type, workspace?, branch?, remotes: [{ name, url }] }` / `repository?: { host, owner, name, url }`。形は docs/QUESTIONS.md の HP-Q1 の統括の推し (αa / βa / γa)。決まりは DR-0003 §3、スキーマは packages/protocol/src/response-sessions.ts
- 受け入れ条件 (1 段目) は満たした。webui の agents との突き合わせは減らしていない (webui が agents を引くのは status / pid 等の名前以外の欄のためで、ccmsg 未起動の行は peers に居ないので名前も agents から読むしかない)
- 実 daemon (v0.246.0) の `ccmsg peers` で確認: 13 セッション全部に name / vcs / repository が載り (git 7、jj 6)、vcs.branch も全部に入っていた。認証情報入りの remote URL は 0 件
- worker が置いた決め: `repository.host` は port を含まない hostname。remote の path に owner の段が無い時は `repository` を出さない。jj の default workspace と git の main worktree では `vcs.workspace` を出さない

## 2 段目で決めること

- HP-Q1 の裁定 (欄の形が違えば 2 段目の前に直す)
- `ws` / `repo` の利用箇所 (hello、webui、CLI、DR-0003 §3 の「5 フィールド」、DR-0046) を `vcs.workspace` / `repository` へ向け直す
- `repository.url` と同じ値の `repo_url` を消すか
- 一番上の `branch` (hello だけが源) と `vcs.branch` (hello、無ければ git の HEAD) が並んでいる。どちらかに寄せる
- `#123` のリンクを `repository.host` で forge ごとに分ける (今は GitHub 決め打ち)
- workspace の名前の取り方 (docs/issue/2026-11-11-vcs-workspace-name-from-jj-record.md)
