# Decision Records (DR) INDEX

このプロジェクトの設計判断記録一覧。`DR-NNNN-<slug>.md` 形式。

| ID | Status | Title |
|---|---|---|
| [DR-0001](./DR-0001-central-daemon-architecture.md) | Accepted | Central daemon + room messaging architecture (rewrite from cmux-msg) |
| [DR-0002](./DR-0002-daemon-supervision.md) | Accepted | Daemon supervision & lifecycle |
| [DR-0003](./DR-0003-wire-protocol.md) | Accepted | Wire protocol & room semantics |
| [DR-0004](./DR-0004-webui-architecture.md) | Accepted | webui architecture (HTTP/WS transport + UI) |
| [DR-0005](./DR-0005-webui-frontend-architecture.md) | Accepted | webui frontend architecture (workspace 化を見込んだ器) |
| [DR-0006](./DR-0006-id-scheme-v2.md) | Accepted | ID 体系 v2 (member id を u/a namespace の型付き文字列に分離) |
| [DR-0007](./DR-0007-path-installation.md) | Accepted | PATH への symlink インストールと自己更新 |
| [DR-0008](./DR-0008-workspace-file-access.md) | Accepted | Workspace file access (fs_list / fs_read op) |
| [DR-0009](./DR-0009-session-transcript-access.md) | Accepted | Session transcript access (transcript_read op) |
| [DR-0010](./DR-0010-timeline-markdown-rendering.md) | Accepted | Timeline アシスタント発言の Markdown レンダリング (mdast → JSX walker) |
| [DR-0011](./DR-0011-to-delivery-filter.md) | Accepted | `to` を mention から配信フィルタへ変更 + drag & drop invite |
| [DR-0012](./DR-0012-room-archive-and-kick.md) | Accepted | room アーカイブ (表示整理フラグ) + 強制 leave (kick、admin 専用) |
| [DR-0013](./DR-0013-broadcast-room.md) | Accepted | broadcast room (auto-populated session broadcast) |
| [DR-0014](./DR-0014-1on1-room-and-reply-via.md) | Accepted (reply_via 部は DR-0017 で置換) | 1on1 room + msg 応答経路 hint (reply_via) |
| [DR-0015](./DR-0015-composer-attachments.md) | Proposed | Composer 添付ファイル機能 (画像/任意ファイル + clipboard paste) |
| [DR-0016](./DR-0016-storage-event-seq.md) | Accepted | StorageEvent 横断の per-room 連番 `seq` (subscribe 再接続 cursor の全 event 型拡張) |
| [DR-0017](./DR-0017-reply-command.md) | Accepted | `ccmsg reply` (daemon 仲介の返信) + `reply_hint` + 指示文行 (reply_via 置換) |
| [DR-0018](./DR-0018-session-launcher.md) | Accepted | Session Launcher (webui からの新規セッション起動 UI、Phase 分割) |
| [DR-0019](./DR-0019-fs-write-inbox.md) | Accepted | fs_write (webui Files からの新規ファイル作成、docs/inbox 先行) |
| [DR-0020](./DR-0020-session-status-tab.md) | Accepted | Status タブ (workflow / background / TODO の可視化、transcript fold) |
| [DR-0021](./DR-0021-session-search.md) | Accepted | Session Search (ccmsg 未起動の過去セッションの検索・pinned 閲覧) |
| [DR-0022](./DR-0022-in-view-search.md) | Accepted | In-view キーワード検索 (TL/ビューアのハイライト + index nav) |
| [DR-0023](./DR-0023-daemon-local-translation.md) | Accepted | daemon 経由ローカル翻訳 (macOS Translation.framework、Safari フォールバック) |
| [DR-0024](./DR-0024-out-of-project-files.md) | Accepted | プロジェクト外セクション (セッションが触った cwd 外ファイルの表示 + allowlist 読み出し) |
