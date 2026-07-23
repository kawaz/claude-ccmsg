---
title: filepath リンク化 Phase B/C: daemon 存在確認 (fs_stat_batch) + external files 経路 + キャッシュ
status: open
category: design
created: 2026-07-23T11:49:44+09:00
last_read:
open_entered: 2026-07-23T11:49:44+09:00
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

# filepath リンク化 Phase B/C: daemon 存在確認 (fs_stat_batch) + external files 経路 + キャッシュ

## 概要

Phase A (v0.73.0 予定) で inline code 内の `filepath[:L1[-L2]]` / `filepath[:LINE[:COL]]` をリンク化済み
(拡張子 or 行番号ヒューリスティックで branch 名/ディレクトリを排除、kawaz r46m55-58 の対象/対象外例をテスト固定)。

本 issue は精度を上げる Phase B/C の設計。kawaz 裁定済み事項:

- (r46m57) 存在確認は daemon 経由で OK (レイテンシ許容)
- (r46m58) プロジェクト外絶対パスは DR-0024 external files allowlist に乗せ、認可外は存在有無を漏らさない

worker (impl-filepath-linkify) の設計提案:

- **B1**: protocol に `fs_stat_batch` op を追加 (`paths[]` → `(FsStatEntry|null)[]`。null は not_found/forbidden/非ファイルを区別しない)
- **B2**: daemon `fs-access.ts` に `fsStatBatch` を実装 (contained → workspace DR-0026 → external DR-0024 の順で既存 resolver を再利用、isFile のみ、user-role only)
- **C1**: client に存在確認キャッシュ (sid × absPath。TimelineItem マウント時に batch enqueue → `ws.fsStatBatch` → cache hit で `<a>` に切替)
- **C2**: `resolveFilePathRef` の client 側 rebase を廃止し、daemon response の path を `fileHref` に直結

見積り: 600-700 行 (テスト込み)。

## 背景

Phase A で拡張子/行番号ヒューリスティックによる誤検出排除は済んだが、「実在しないパスをリンク化してしまう」「プロジェクト外パスの扱い」の精度向上が残課題として残った。daemon の既存 fs-access resolver 資産 (workspace/external allowlist) を再利用する形で解決する設計。

## 受け入れ条件

- [ ] `fs_stat_batch` op が protocol に追加され、daemon 側で contained/workspace(DR-0026)/external(DR-0024) の順に既存 resolver を再利用して isFile 判定を返す
- [ ] 認可外パスについては存在有無を漏らさない (forbidden も not_found も同じ null)
- [ ] client 側に sid×absPath の存在確認キャッシュが実装され、TimelineItem マウント時に batch 問い合わせされる
- [ ] `resolveFilePathRef` の client 側 rebase ロジックが廃止され、daemon response の path が `fileHref` に直結する

## 未裁定事項 (次セッションで kawaz に確認)

1. batch 粒度: 1 メッセージ単位で良いか、debounce+coalescing にすべきか
2. cache invalidation: セッション寿命で保持で良いか
3. fold 内の先読み: 「拡張子ヒューリスティックで大半排除済み、fold 内の残り false 陽性は許容」の妥協案 (worker 推し・main も推し) で良いか

## 対象外 (Phase B/C ではやらない)

- カラム位置 (`path:42:7` の COL) ハイライトは FileViewer に列概念が無いため drop 中。必要なら別途 issue 起票
