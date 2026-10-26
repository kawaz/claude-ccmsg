# Decision Records (DR) INDEX

このプロジェクトの設計判断記録一覧。`DR-NNNN-<slug>.md` 形式。

区分は **現行系 (v1 の daemon / webui) が今も従っているか** で分ける。「v2 での扱い」列は[DR-0032](./DR-0032-repo-split-protocol-first.md) §3 の振り分けで、値は次の 5 つ:

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
| [DR-0008](./DR-0008-workspace-file-access.md) | Accepted | 契約に吸収 | Workspace file access (fs_list / fs_read op) — control 面 |
| [DR-0009](./DR-0009-session-transcript-access.md) | Accepted | 契約に吸収 | Session transcript access (transcript_read op) — control 面 |
| [DR-0010](./DR-0010-timeline-markdown-rendering.md) | Accepted | webui へ移管 | Timeline アシスタント発言の Markdown レンダリング (mdast → JSX walker) |
| [DR-0015](./DR-0015-composer-attachments.md) | Proposed (実装済み) | webui へ移管 (裁定待ち) | Composer 添付ファイル機能 (画像/任意ファイル + clipboard paste) — 移送可否は [webui-rebuild-checklist](../design/webui-rebuild-checklist.md) の未決 3 件 |
| [DR-0018](./DR-0018-session-launcher.md) | Accepted (✅ 実装済み) | webui へ移管 | Session Launcher — エージェントの tool `launch` と webui のフォームから、claude のオプション名を field にした入力で、config で固定した 1 つの起動コマンドにセッションを起動させる。daemon は入力を JSON で渡して結果を返すだけで、session role からも起動できる |
| [DR-0019](./DR-0019-fs-write-inbox.md) | Accepted | 契約に吸収 + webui へ移管 | fs_write (webui Files からの新規ファイル作成、docs/inbox 先行) — op は control 面、UI は webui リポ |
| [DR-0020](./DR-0020-session-status-tab.md) | Accepted | webui へ移管 | Status タブ (workflow / background / TODO の可視化、transcript fold) |
| [DR-0021](./DR-0021-session-search.md) | Accepted | webui へ移管 | Session Search (ccmsg 未起動の過去セッションの検索・pinned 閲覧) |
| [DR-0022](./DR-0022-in-view-search.md) | Accepted | webui へ移管 | In-view キーワード検索 (TL/ビューアのハイライト + index nav) |
| [DR-0023](./DR-0023-daemon-local-translation.md) | Accepted | 据え置き | daemon 経由ローカル翻訳 (macOS Translation.framework、Safari フォールバック) — control 面の capability |
| [DR-0024](./DR-0024-out-of-project-files.md) | Accepted | webui へ移管 | プロジェクト外セクション (セッションが触った cwd 外ファイルの表示 + allowlist 読み出し) |
| [DR-0025](./DR-0025-workflow-drilldown.md) | Proposed (実装済み) | webui へ移管 (裁定待ち) | workflow/teammate 掘り下げ UI (Phases/エージェント一覧 → 各 TL 閲覧) |
| [DR-0026](./DR-0026-vscode-workspace-section.md) | Accepted | webui へ移管 | ワークスペースセクション (.code-workspace folders の allowlist ブラウズ) |
| [DR-0028](./DR-0028-session-kill.md) | Proposed (実装済み) | webui へ移管 (裁定待ち) | session_kill (完了セッションのプロセス停止、Status タブ危険色ボタン) と session_restart (止めて同じ id で resume する、Status タブの再起動ボタン) |
| [DR-0029](./DR-0029-async-io-principle.md) | Accepted | 契約に吸収 | IO を伴うイベント/メッセージ処理は全て非同期化する原則 (まとめ処理は要承認) |
| [DR-0030](./DR-0030-sandbox-origin-serving.md) | Accepted | 据え置き | canddy sandbox origin 経由の非信頼コンテンツ配信 (生ファイル / HTML / 大出力) |
| [DR-0031](./DR-0031-webui-design-tokens-and-catalog.md) | Accepted | webui へ移管 | webui デザイントークンと自作コンポーネントカタログ |
| [DR-0032](./DR-0032-repo-split-protocol-first.md) | Accepted | 据え置き (v2 の起点) | リポ分離と規約ファーストの作り直し (daemon / protocol / webui) |
| [DR-0033](./DR-0033-webui-color-system.md) | Proposed | webui へ移管 | webui カラーシステム (少数の入力から全色を導出する 3 層構造 + テーマエディタ) |
| [DR-0034](./DR-0034-peer-socket-injection.md) | Accepted / 実装済 | 置き換わる予定 | v1 daemon による room msg の peer messaging socket 直接注入 — v2 の配送経路は protocol-v2 が別途定める |
| [DR-0035](./DR-0035-user-input-via-composer-fill.md) | Accepted (✅ 実装済み) | 据え置き | webui からセッションへの人の入力を composer への fill + Enter で届け、1on1 room を作らず既存の 1on1 room を読み取り専用にする — v2 (kawaz/ccmsg) と同じ方式で、Enter は module が自分の端末に送る |
| [DR-0036](./DR-0036-retire-rooms-for-p2p.md) | Accepted (✅ 実装済み) | 据え置き | room を廃止し、セッション間メッセージを sid 宛の直送 (v2 の契約の封筒・mid・返信行) にする。既存の room のログは webui で読み取り専用で閲覧する — DR-0001 §3-§6 / 0003 / 0011 / 0012 / 0013 / 0016 / 0017 の room 前提部分を置き換える |
| [DR-0038](./DR-0038-json-is-parsed-by-schema.md) | Accepted (✅ 実装済み) | 据え置き | データの形は valibot のスキーマで定義して型を導き、外から来る JSON は境界でスキーマに通す。`as` (`as const` 以外)・`any`・非 null の主張は使わず lint で検査する |
| [DR-0039](./DR-0039-all-mods-and-typed-tools.md) | Accepted (✅ 実装済み) | 据え置き | classic hook (command hook の SessionStart と module の `classic.*`) を全廃して hooks module 1 本に寄せ、エージェントが使う ccmsg の口 (セッション間の送信・say・宛先の候補) を `$.tool.register` の typed tool にする。CLI は人の口と module の transport に縮め、module の無いセッションは no_module の 1 状態でフォールバックを持たない |
| [DR-0040](./DR-0040-permit-request-tool.md) | Accepted (✅ 実装済み) | 据え置き | auto mode の classifier に止められたエージェントが人に許可を求める tool `permit`。webui の TL に許可依頼のバブルを出して音声で知らせ、添付は人が開いた時に daemon が読む。「許可する」で許可の文 (添付のパスと、許可する intents / commands の全文) をクリップボードに写して依頼を既読にする。未読の依頼は Sessions 一覧に 🔐 で出す。許可の状態は持たない |
| [DR-0041](./DR-0041-request-model-effort-override.md) | Proposed (実装済み、裁定待ち 6 点) | 据え置き | webui から走行中のセッションの model / effort を request 単位で上書きする。通しの上書きは daemon が持って module に送り、単発の上書きは webui の入力 1 回に付けて、その turn の終わりまで効かせる。差し替えは module の `turn.step` で行い、engine の既定も表示も変えないので、ccmsg が実効値を出す |

## Superseded (一部)

本文の一部が別の文書に置き換わったもの。残りは現行系が従っているので Active 相当として読む。

| ID | 置き換えた文書 | v2 での扱い | Title |
|---|---|---|---|
| [DR-0004](./DR-0004-webui-architecture.md) | §4 実装方式 → [DR-0005](./DR-0005-webui-frontend-architecture.md) / §5 locator → [webui-url-grammar](../design/webui-url-grammar.md) | 置き換わる予定 | webui architecture (HTTP/WS transport + UI) — origin 制限は DR-0032 §2.1 の「許可 origin の設定」へ。§4「protocol 拡張はしない」は面の分離 (protocol-v2 §2) が引き取る |
| [DR-0005](./DR-0005-webui-frontend-architecture.md) | §1 action/reducer・§3 配信形態 → [DR-0032](./DR-0032-repo-split-protocol-first.md) §2.1 | webui へ移管 | webui frontend architecture (workspace 化を見込んだ器) |
| [DR-0007](./DR-0007-path-installation.md) | §1 symlink の提案・§2 自己更新・launcher の self-exec → [DR-0032](./DR-0032-repo-split-protocol-first.md) §2.2-4 (止めた) | 対象外 | PATH への symlink インストールと自己更新 — 現行なのは §3 の `version` |
| [DR-0027](./DR-0027-tl-ccmsg-canonical-lookup.md) | §2.1 の切り詰められた event の行の救済 parse → [DR-0038](./DR-0038-json-is-parsed-by-schema.md) §6 (止めた) | webui へ移管 | TL の ccmsg を daemon 一次情報で完全復元 + AI 発 post/reply の TL 表示 — 一次情報の経路は messaging 面の変更に追従 |

## Archived

後続の DR に置き換えられた DR は [archive/INDEX.md](./archive/INDEX.md)。
