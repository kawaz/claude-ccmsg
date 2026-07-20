# Issue INDEX

active な issue の一覧。close 済みは `archive/` にあり、ここには載せない。

| date | category | status | slug | 概要 |
|---|---|---|---|---|
| 2026-07-04 | design | idea | [daemon-side-subscribe-detection](./2026-07-04-daemon-side-subscribe-detection.md) | UserPromptSubmit hook の subscribe 稼働検出を ps 走査から daemon 問い合わせへ置き換える案 |
| 2026-07-09 | design | wip | [webui-workspace-roadmap](./2026-07-09-webui-workspace-roadmap.md) | webui を workspace UI に育てる長期 roadmap (セッションリスト/ルームリスト+チャット/ファイルツリー+コードビューア、並列進行) |
| 2026-07-10 | design | idea | [webrtc-datachannel-transport](./2026-07-10-webrtc-datachannel-transport.md) | ccmsg メッセージを WebRTC DataChannel に載せ、静的ホスティング + ICE candidate URL + passkey 認証で tailnet 非依存の transport を実現する構想 |
| 2026-07-10 | design | idea | [webui-bun-fullstack-serving](./2026-07-10-webui-bun-fullstack-serving.md) | webui 配信経路を自作 Bun.build+キャッシュ構成から Bun 1.3 公式 fullstack 機能 (HTML import + Bun.serve routes) へ置換できないか検討 |
| 2026-07-11 | design | idea | [origin-isolated-app-reverse-proxy](./2026-07-11-origin-isolated-app-reverse-proxy.md) | 自己所有ドメイン + wildcard ACME の app リバースプロキシ構想 (docroot ごとの origin 分離で JS 実行可能な file serving) |
| 2026-07-12 | design | open | [passkey-signed-post-antispoofing](./2026-07-12-passkey-signed-post-antispoofing.md) | Passkey 署名を post に添付し daemon 検証する、なりすまし対策強化案 |
| 2026-07-12 | bug | wip | [bun-test-flaky-fullsuite-parallel](./2026-07-12-bun-test-flaky-fullsuite-parallel.md) | bun test フルスイート並列実行時に稀に 1 件 fail する flaky の追跡 (tailscale origin 系の真因確定、修正実装中) |
| 2026-07-12 | bug | open | [daemon-startup-notification-noise](./2026-07-12-daemon-startup-notification-noise.md) | デーモン先起動のたびに既存セッションへ通知が飛んでうるさい、先起動時の通知抑止 + lazy ensure 一本化の検討依頼 (cache-warden からの部外者フィードバック) |
| 2026-07-14 | task | idea | [webui-component-render-test-infrastructure](./2026-07-14-webui-component-render-test-infrastructure.md) | webui/test が pure helper + reducer 型のみで fab/panel の open-close 遷移や effect の DOM 挙動を単体テスト化できない、render テスト基盤 (testing-library/preact 等) 導入検討 |
| 2026-07-14 | design | idea | [dr-0009-transcript-read-after-param](./2026-07-14-dr-0009-transcript-read-after-param.md) | DR-0009 transcript_read が before のみで after (差分取得) を持たず、TLR-Q1=b 実装が全 tail 再取得経路になった件。after 追加 + append merge 化の検討 |
| 2026-07-17 | design | open | [session-search-ux-followups](./2026-07-17-session-search-ux-followups.md) | Session Search の UX 改善 3 点: 検索クエリ/トグルを TL in-view 検索に継承、選択時にパネルを閉じない、pin ボタンをタブヘッダーに常設し自動 pin を廃止。(1) は DR-0022 land 後着手 |
| 2026-07-17 | task | open | [host-translation-followups](./2026-07-17-host-translation-followups.md) | ja(host) 翻訳 + TL 表示のフォローアップ 5 件: ctx 消費表示、thinking 翻訳バッチ化による高速化、全文日本語 skip、select 機能の完全削除、teams 要約行表示。simplify workflow 完了後に着手 |
| 2026-07-17 | task | idea | [webui-simplify-componentization](./2026-07-17-webui-simplify-componentization.md) | webui の場当たり改修で重複したパターン (localStorage load/save、FAB+popup、fs_list dispatch、details 折りたたみ、タブ切替) のコンポーネント化・simplify 棚卸し。機能実装キューが捌けた後に着手 |
| 2026-07-17 | design | open | [status-teams-section](./2026-07-17-status-teams-section.md) | Status タブに teams (agent teams) セクションを追加。daemon の session_status fold を拡張し Agent spawn/SendMessage/relay 受信を突合して teammate 一覧を表示。実 transcript 観測後に schema 決定。DR-0022 完了後の実装キュー |
| 2026-07-17 | design | wip | [cli-help-diet-and-reply-rails](./2026-07-17-cli-help-diet-and-reply-rails.md) | ccmsg CLI の `--help` / SKILL.md を基本レール (reply/post/peers/create-room/subscribe/notify) のみに絞り、詳細は `--help-full` へ隠す。post が reply_hint:"tl" ガードを素通りする実害を確認、1on1 room 拒否レール追加 + reply 側拒否実装の検証が最優先 |
| 2026-07-17 | bug | open | [session-search-double-escape-literal-miss](./2026-07-17-session-search-double-escape-literal-miss.md) | Session Search literal モードが二重 JSON エスケープの ccmsg メッセージ (queue-operation 行) を検索できない既存制限。プリフィルタ needle に二重エスケープ綴りも OR 追加が修正候補 |
| 2026-07-17 | task | open | [session-creator-cwd-picker-unify](./2026-07-17-session-creator-cwd-picker-unify.md) | SessionCreator の cwd 選択 UI を統合 (kawaz 裁定)。手入力欄とツリー検索欄を1つに統合、選択後は確定表示+編集ボタンに切替。コマンドプレビュー workflow (wf_89c77eac) 完了後に着手 |
