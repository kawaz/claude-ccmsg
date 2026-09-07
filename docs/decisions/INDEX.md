# Decision Records (DR) INDEX

このプロジェクトの設計判断記録一覧。`DR-NNNN-<slug>.md` 形式。

区分は **現行系 (v1 の daemon / webui) が今も従っているか** で分ける。「v2 での扱い」列は
[DR-0032](./DR-0032-repo-split-protocol-first.md) §3 の振り分けで、値は次の 5 つ:

| 値 | 意味 |
|---|---|
| 据え置き | v2 でもこの判断のまま |
| 契約に吸収 | protocol リポの契約 ([protocol-v2](../design/protocol-v2.md) / [op 表](../design/protocol-v2-op-table.md)) が引き取る |
| webui へ移管 | webui リポの設計文書へ内容を移す |
| 置き換わる予定 | v2 では別の判断になる (旧系は凍結して動き続けるので Superseded にはしない) |
| 対象外 | v2 には存在しない |

## Active

現行系が従っている判断。

| ID | Status | v2 での扱い | Title |
|---|---|---|---|
| [DR-0001](./DR-0001-central-daemon-architecture.md) | Accepted | 一部 置き換わる予定 | Central daemon + room messaging architecture (rewrite from cmux-msg) — daemon 中枢の骨子は据え置き。§1 single host は mesh (DR-0032 §2.3) が、§3〜§6 の room / BBS モデルは protocol-v2 §2.1 が置き換える |
| [DR-0002](./DR-0002-daemon-supervision.md) | Accepted | 置き換わる予定 | Daemon supervision & lifecycle — 起動は [daemon-v2](../design/daemon-v2.md) §8.4 の常駐登録へ。§4 の互換方針は DR-0032 §3「互換経路は持たない」で決着 |
| [DR-0003](./DR-0003-wire-protocol.md) | Accepted | 契約に吸収 | Wire protocol & room semantics — room 語彙は v2 で持たない |
| [DR-0006](./DR-0006-id-scheme-v2.md) | Accepted | 契約に吸収 | ID 体系 v2 (member id を u/a namespace の型付き文字列に分離) |
| [DR-0007](./DR-0007-path-installation.md) | Accepted | 対象外 | PATH への symlink インストールと自己更新 — v2 の配布は `ccmsg plugin install` (DR-0032 §2.4) |
| [DR-0008](./DR-0008-workspace-file-access.md) | Accepted | 契約に吸収 | Workspace file access (fs_list / fs_read op) — control 面 |
| [DR-0009](./DR-0009-session-transcript-access.md) | Accepted | 契約に吸収 | Session transcript access (transcript_read op) — control 面 |
| [DR-0010](./DR-0010-timeline-markdown-rendering.md) | Accepted | webui へ移管 | Timeline アシスタント発言の Markdown レンダリング (mdast → JSX walker) |
| [DR-0011](./DR-0011-to-delivery-filter.md) | Accepted | 置き換わる予定 | `to` を mention から配信フィルタへ変更 + drag & drop invite — v2 は sid 宛の 1 対 1 配送 (protocol-v2 §2.1) |
| [DR-0012](./DR-0012-room-archive-and-kick.md) | Accepted | 置き換わる予定 | room アーカイブ (表示整理フラグ) + 強制 leave (kick、admin 専用) — room 廃止に伴う |
| [DR-0013](./DR-0013-broadcast-room.md) | Accepted | 置き換わる予定 | broadcast room (auto-populated session broadcast) — room 廃止に伴う |
| [DR-0015](./DR-0015-composer-attachments.md) | Proposed (実装済み) | webui へ移管 (裁定待ち) | Composer 添付ファイル機能 (画像/任意ファイル + clipboard paste) — 移送可否は [webui-rebuild-checklist](../design/webui-rebuild-checklist.md) の未決 3 件 |
| [DR-0016](./DR-0016-storage-event-seq.md) | Accepted | 置き換わる予定 | StorageEvent 横断の per-room 連番 `seq` — v2 は `mid` / `seq` を持たない (protocol-v2 §2.1) |
| [DR-0017](./DR-0017-reply-command.md) | Accepted | 契約に吸収 | `ccmsg reply` (daemon 仲介の返信) + `reply_via` 実行指示 — 返信経路の指示は messaging 面へ |
| [DR-0018](./DR-0018-session-launcher.md) | Accepted | webui へ移管 | Session Launcher (webui からの新規セッション起動 UI、Phase 分割) |
| [DR-0019](./DR-0019-fs-write-inbox.md) | Accepted | 契約に吸収 + webui へ移管 | fs_write (webui Files からの新規ファイル作成、docs/inbox 先行) — op は control 面、UI は webui リポ |
| [DR-0020](./DR-0020-session-status-tab.md) | Accepted | webui へ移管 | Status タブ (workflow / background / TODO の可視化、transcript fold) |
| [DR-0021](./DR-0021-session-search.md) | Accepted | webui へ移管 | Session Search (ccmsg 未起動の過去セッションの検索・pinned 閲覧) |
| [DR-0022](./DR-0022-in-view-search.md) | Accepted | webui へ移管 | In-view キーワード検索 (TL/ビューアのハイライト + index nav) |
| [DR-0023](./DR-0023-daemon-local-translation.md) | Accepted | 据え置き | daemon 経由ローカル翻訳 (macOS Translation.framework、Safari フォールバック) — control 面の capability |
| [DR-0024](./DR-0024-out-of-project-files.md) | Accepted | webui へ移管 | プロジェクト外セクション (セッションが触った cwd 外ファイルの表示 + allowlist 読み出し) |
| [DR-0025](./DR-0025-workflow-drilldown.md) | Proposed (実装済み) | webui へ移管 (裁定待ち) | workflow/teammate 掘り下げ UI (Phases/エージェント一覧 → 各 TL 閲覧) |
| [DR-0026](./DR-0026-vscode-workspace-section.md) | Accepted | webui へ移管 | ワークスペースセクション (.code-workspace folders の allowlist ブラウズ) |
| [DR-0027](./DR-0027-tl-ccmsg-canonical-lookup.md) | Accepted | webui へ移管 | TL の ccmsg を daemon 一次情報で完全復元 + AI 発 post/reply の TL 表示 — 一次情報の経路は messaging 面の変更に追従 |
| [DR-0028](./DR-0028-session-kill.md) | Proposed (実装済み) | webui へ移管 (裁定待ち) | session_kill (完了セッションのプロセス停止、Status タブ危険色ボタン) |
| [DR-0029](./DR-0029-async-io-principle.md) | Accepted | 契約に吸収 | IO を伴うイベント/メッセージ処理は全て非同期化する原則 (まとめ処理は要承認) |
| [DR-0030](./DR-0030-sandbox-origin-serving.md) | Accepted | 据え置き | canddy sandbox origin 経由の非信頼コンテンツ配信 (生ファイル / HTML / 大出力) |
| [DR-0031](./DR-0031-webui-design-tokens-and-catalog.md) | Accepted | webui へ移管 | webui デザイントークンと自作コンポーネントカタログ |
| [DR-0032](./DR-0032-repo-split-protocol-first.md) | Accepted | 据え置き (v2 の起点) | リポ分離と規約ファーストの作り直し (daemon / protocol / webui) |
| [DR-0033](./DR-0033-webui-color-system.md) | Proposed | webui へ移管 | webui カラーシステム (少数の入力から全色を導出する 3 層構造 + テーマエディタ) |

## Superseded (一部)

本文の一部が別の文書に置き換わったもの。残りは現行系が従っているので Active 相当として読む。

| ID | 置き換えた文書 | v2 での扱い | Title |
|---|---|---|---|
| [DR-0004](./DR-0004-webui-architecture.md) | §4 実装方式 → [DR-0005](./DR-0005-webui-frontend-architecture.md) / §5 locator → [webui-url-grammar](../design/webui-url-grammar.md) | 置き換わる予定 | webui architecture (HTTP/WS transport + UI) — origin 制限は DR-0032 §2.1 の「許可 origin の設定」へ。§4「protocol 拡張はしない」は面の分離 (protocol-v2 §2) が引き取る |
| [DR-0005](./DR-0005-webui-frontend-architecture.md) | §1 action/reducer・§3 配信形態 → [DR-0032](./DR-0032-repo-split-protocol-first.md) §2.1 | webui へ移管 | webui frontend architecture (workspace 化を見込んだ器) |
| [DR-0014](./DR-0014-1on1-room-and-reply-via.md) | reply_via 部 → [DR-0017](./DR-0017-reply-command.md) | 置き換わる予定 / UI 部は webui へ移管 | 1on1 room + msg 応答経路 hint (reply_via) — 1on1 room は protocol-v2 §2.1 の sid 宛配送へ |

## Archived

該当なし。`decisions/archive/` は未作成。
