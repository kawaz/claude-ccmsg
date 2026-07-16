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
| 2026-07-17 | design | open | [status-teams-section](./2026-07-17-status-teams-section.md) | Status タブに teams (agent teams) セクションを追加。daemon の session_status fold を拡張し Agent spawn/SendMessage/relay 受信を突合して teammate 一覧を表示。実 transcript 観測後に schema 決定。DR-0022 完了後の実装キュー |
