# Issue INDEX

active な issue の一覧。close 済みは `archive/` にあり、ここには載せない。

| date | category | status | slug | 概要 |
|---|---|---|---|---|
| 2026-07-04 | design | idea | [daemon-side-subscribe-detection](./2026-07-04-daemon-side-subscribe-detection.md) | UserPromptSubmit hook の subscribe 稼働検出を ps 走査から daemon 問い合わせへ置き換える案 |
| 2026-07-09 | design | wip | [webui-workspace-roadmap](./2026-07-09-webui-workspace-roadmap.md) | webui を workspace UI に育てる長期 roadmap (セッションリスト/ルームリスト+チャット/ファイルツリー+コードビューア、並列進行) |
| 2026-07-10 | design | idea | [webrtc-datachannel-transport](./2026-07-10-webrtc-datachannel-transport.md) | ccmsg メッセージを WebRTC DataChannel に載せ、静的ホスティング + ICE candidate URL + passkey 認証で tailnet 非依存の transport を実現する構想 |
| 2026-07-10 | design | idea | [webui-bun-fullstack-serving](./2026-07-10-webui-bun-fullstack-serving.md) | webui 配信経路を自作 Bun.build+キャッシュ構成から Bun 1.3 公式 fullstack 機能 (HTML import + Bun.serve routes) へ置換できないか検討 |
| 2026-07-11 | design | idea | [origin-isolated-app-reverse-proxy](./2026-07-11-origin-isolated-app-reverse-proxy.md) | 自己所有ドメイン + wildcard ACME の app リバースプロキシ構想 (docroot ごとの origin 分離で JS 実行可能な file serving) |
| 2026-07-12 | design | open | [post-release-daemon-upgrade-lag](./2026-07-12-post-release-daemon-upgrade-lag.md) | リリース後、新 client が daemon に接触するまで旧 daemon が配信され続けるギャップの改善案 (push 直後 1 回接触/webui バナー/daemon self-upgrade) |
| 2026-07-12 | design | open | [passkey-signed-post-antispoofing](./2026-07-12-passkey-signed-post-antispoofing.md) | Passkey 署名を post に添付し daemon 検証する、なりすまし対策強化案 |
| 2026-07-12 | design | open | [peers-live-update-protocol](./2026-07-12-peers-live-update-protocol.md) | state.peers に live 更新経路が無く、接続/切断がリアルタイム反映されない (ev:"peers" push の protocol 拡張案) |
| 2026-07-12 | bug | open | [bun-test-flaky-fullsuite-parallel](./2026-07-12-bun-test-flaky-fullsuite-parallel.md) | bun test フルスイート並列実行時に稀に 1 件 fail する flaky の追跡 (fail テスト名未確定、不安定さの軸調査中) |
| 2026-07-12 | bug | open | [daemon-startup-notification-noise](./2026-07-12-daemon-startup-notification-noise.md) | デーモン先起動のたびに既存セッションへ通知が飛んでうるさい、先起動時の通知抑止 + lazy ensure 一本化の検討依頼 (cache-warden からの部外者フィードバック) |
| 2026-07-14 | task | idea | [webui-component-render-test-infrastructure](./2026-07-14-webui-component-render-test-infrastructure.md) | webui/test が pure helper + reducer 型のみで fab/panel の open-close 遷移や effect の DOM 挙動を単体テスト化できない、render テスト基盤 (testing-library/preact 等) 導入検討 |
| 2026-07-14 | design | idea | [dr-0009-transcript-read-after-param](./2026-07-14-dr-0009-transcript-read-after-param.md) | DR-0009 transcript_read が before のみで after (差分取得) を持たず、TLR-Q1=b 実装が全 tail 再取得経路になった件。after 追加 + append merge 化の検討 |
| 2026-07-17 | design | open | [session-search-query-options](./2026-07-17-session-search-query-options.md) | Session Search (DR-0021) に in-view 検索 (DR-0022) と同じ case-sensitive/regex トグルと複数行 AND を導入。protocol/daemon/webui 拡張、regex 時のプリフィルタ戦略は実装時に実測判断。DR-0022 完了後着手 |
| 2026-07-17 | design | open | [session-search-ux-followups](./2026-07-17-session-search-ux-followups.md) | Session Search の UX 改善 3 点: 検索クエリ/トグルを TL in-view 検索に継承、選択時にパネルを閉じない、pin ボタンをタブヘッダーに常設し自動 pin を廃止。(1) は DR-0022 land 後着手 |
| 2026-07-17 | design | open | [session-creator-command-preview](./2026-07-17-session-creator-command-preview.md) | SessionCreator に実行コマンドのプレビュー + その場編集を追加。protocol に command override 追加、DR-0018 § 3.2 に supersede 追記が必要 |
| 2026-07-17 | bug | open | [subscribe-jsonl-msg-last-column](./2026-07-17-subscribe-jsonl-msg-last-column.md) | subscribe msg イベント jsonl のカラム順を msg 本文が必ず最後に来る形に並べ替え、harness truncation による後続フィールド (reply_hint 等) の silent 消失を防ぐ |
| 2026-07-17 | task | open | [host-translation-followups](./2026-07-17-host-translation-followups.md) | ja(host) 翻訳 + TL 表示のフォローアップ 5 件: ctx 消費表示、thinking 翻訳バッチ化による高速化、全文日本語 skip、select 機能の完全削除、teams 要約行表示。simplify workflow 完了後に着手 |
| 2026-07-17 | task | idea | [webui-simplify-componentization](./2026-07-17-webui-simplify-componentization.md) | webui の場当たり改修で重複したパターン (localStorage load/save、FAB+popup、fs_list dispatch、details 折りたたみ、タブ切替) のコンポーネント化・simplify 棚卸し。機能実装キューが捌けた後に着手 |
| 2026-07-17 | design | open | [status-teams-section](./2026-07-17-status-teams-section.md) | Status タブに teams (agent teams) セクションを追加。daemon の session_status fold を拡張し Agent spawn/SendMessage/relay 受信を突合して teammate 一覧を表示。実 transcript 観測後に schema 決定。DR-0022 完了後の実装キュー |
| 2026-07-17 | request | open | [status-context-usage](./2026-07-17-status-context-usage.md) | Status タブにメインコンテキストサイズ・使用率を表示。transcript の直近 assistant 行 usage 合算で取得可能 (hook/statusline 不要)、分母はモデル名からの推定。DR-0022 完了後の実装キュー、teams セクションと同一 fold 拡張 |
| 2026-07-17 | design | wip | [cli-help-diet-and-reply-rails](./2026-07-17-cli-help-diet-and-reply-rails.md) | ccmsg CLI の `--help` / SKILL.md を基本レール (reply/post/peers/create-room/subscribe/notify) のみに絞り、詳細は `--help-full` へ隠す。post が reply_hint:"tl" ガードを素通りする実害を確認、1on1 room 拒否レール追加 + reply 側拒否実装の検証が最優先 |
| 2026-07-17 | bug | open | [session-search-double-escape-literal-miss](./2026-07-17-session-search-double-escape-literal-miss.md) | Session Search literal モードが二重 JSON エスケープの ccmsg メッセージ (queue-operation 行) を検索できない既存制限。プリフィルタ needle に二重エスケープ綴りも OR 追加が修正候補 |
| 2026-07-17 | request | open | [cli-self-exec-latest](./2026-07-17-cli-self-exec-latest.md) | ccmsg CLI が plugin cache のバージョン付き絶対パスで起動された場合、PATH 上の ccmsg が semver で自分より新しければ exec で譲る self-redirect。daemon の newer-wins upgrade と対になる CLI 側レール |
| 2026-07-17 | design | open | [one-on-one-initial-msg-guard](./2026-07-17-one-on-one-initial-msg-guard.md) | create-room/next-room の 1on1 宛初期 msg も session 発なら reply_via_tl で拒否 (kawaz 裁定 r26 mid=103、RL-Q1 の抜け道を塞ぐ確定)。v0.45.0 post ガードと同じ文言、broadcast 初期 msg 例外 (DR-0013 §2.10) は維持 |
| 2026-07-17 | design | open | [files-vscode-workspace-section](./2026-07-17-files-vscode-workspace-section.md) | Files ツリーに「ワークスペース」セクション追加 (kawaz r26 mid=113)。cwd 直下の `*.code-workspace` の folders を解決して root 表示。containment 外 path は DR-0024 fs_read_external 同様の allowlist 拡張が必要、DR 化してから実装 |
| 2026-07-17 | request | open | [rooms-sidebar-new-button](./2026-07-17-rooms-sidebar-new-button.md) | ROOMS サイドバー見出しに「+ 新規」ボタン追加 (kawaz r26 mid=114)。SESSIONS の SessionCreator と対称、SessionRooms.tsx の既存新規作成フォームを流用/共通化、作成成功で room を開く、creator/search と同じ排他開閉 |
| 2026-07-17 | request | open | [subscribe-no-backlog-default](./2026-07-17-subscribe-no-backlog-default.md) | subscribe のデフォルトを過去メッセージ再送なしに変更 (kawaz 裁定)。接続時イベントを `{roomid, last_mid}` 一覧のみにし、追いつき判断をセッション側に委ねる。従来挙動は `--since` 等へ退避、daemon+CLI+SKILL.md 追従 |
| 2026-07-17 | task | open | [session-creator-cwd-picker-unify](./2026-07-17-session-creator-cwd-picker-unify.md) | SessionCreator の cwd 選択 UI を統合 (kawaz 裁定)。手入力欄とツリー検索欄を1つに統合、選択後は確定表示+編集ボタンに切替。コマンドプレビュー workflow (wf_89c77eac) 完了後に着手 |
| 2026-07-20 | design | wip | [agent-session-tree](./2026-07-20-agent-session-tree.md) | サブエージェント (Agent tool の子) のセッションツリー表示 (kawaz r44 m6-m7)。m6 済 (commit 3a001e9e)、m7 (孫再帰収集+専用パネル UI) を実装着手中 |
