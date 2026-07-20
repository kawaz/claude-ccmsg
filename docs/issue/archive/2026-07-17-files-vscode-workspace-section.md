---
title: Files ツリーに「ワークスペース」セクションを追加
status: resolved
category: design
created: 2026-07-17T21:08:34+09:00
last_read:
open_entered: 2026-07-17T21:08:34+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered: 2026-07-21T03:39:13+09:00
discard_reason:
pending_reason:
close_reason: ["dr/DR-0026","implemented"]
blocked_by:
origin: 自リポ TODO
---

# Files ツリーに「ワークスペース」セクションを追加

## 概要

Files ツリーに「ワークスペース」セクションを追加する (kawaz r26 mid=113)。セッションの cwd 直下 (working copy 直下) に `*.code-workspace` ファイル (例 `kuu/main/kuu.code-workspace`) がある場合、その `folders[].path` を解決して各パスをブラウズ可能な root としてセクション表示する。

## 背景

VSCode の `.code-workspace` はマルチルート構成を宣言するファイルで、これを読めば「ユーザが実際に併せて見ているディレクトリ群」が分かる。Files ツリーの root 候補としてこれを自動的に汲み上げれば、ユーザが個別に root 登録する手間が省ける。

## 設計検討

1. `.code-workspace` の JSON は JSONC (コメント許容) の場合があるので寛容 parse が必要
2. `folders` の相対 path は workspace ファイルの位置基準で解決する
3. containment root 外のパスが `folders` に含まれる場合の読み出し認可: DR-0024 の `fs_read_external` と同様に「workspace ファイルに列挙されたパス集合」を allowlist とする拡張が要る (任意ブラウズには広げない)
4. セクション位置は「お気に入り / ワークスペース / プロジェクト / プロジェクト外」の並びを想定 (実装時に自然な順を判断)

DR 化して認可設計を明記してから実装する (`fs_read_external` の前例に倣う)。

## 受け入れ条件

- [ ] DR で `.code-workspace` folders の allowlist 認可設計が明記されている
- [ ] cwd 直下の `*.code-workspace` を検出し、folders を解決してセクション表示する
- [ ] JSONC (コメント付き) の `.code-workspace` を正しく parse できる
- [ ] containment root 外パスへのアクセスが allowlist 経由でのみ許可される
