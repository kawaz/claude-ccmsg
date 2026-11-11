# Issue INDEX

active な issue の一覧。close 済みは `archive/` にあり、ここには載せない。

| date | category | status | slug | 概要 |
|---|---|---|---|---|
| 2026-11-12 | bug | open | [plugin-cache-old-versions-accumulate](./2026-11-12-plugin-cache-old-versions-accumulate.md) | plugin キャッシュに旧版が溜まり続けて 11 GB になっている (1 版 約 150 MB × 74 版) |
| 2026-11-12 | bug | open | [catch-up-refold-holds-event-loop](./2026-11-12-catch-up-refold-holds-event-loop.md) | daemon の再起動の直後、live のセッションの transcript の読み直しで event loop が 100ms 以上塞がる |
| 2026-11-11 | bug | open | [hello-transcript-search-slow](./2026-11-11-hello-transcript-search-slow.md) | 本番の daemon で、hello の transcript の探索に 550〜640ms かかるセッションがある |
| 2026-11-11 | bug | open | [single-tool-fold-remounts-when-second-arrives](./2026-11-11-single-tool-fold-remounts-when-second-arrives.md) | TL で tool が 1 件だけの時に直接見せている中身が、2 件目が来ると fold に包まれて作り直される |
| 2026-11-11 | design | open | [vcs-workspace-name-from-jj-record](./2026-11-11-vcs-workspace-name-from-jj-record.md) | セッションの一覧の vcs.workspace (と ws) は、jj の workspace の名前をそのディレクトリ名から取っている… |
| 2026-11-11 | design | open | [peer-model-workspace-vcs-repo](./2026-11-11-peer-model-workspace-vcs-repo.md) | セッションの一覧のモデルを整理する (name / workspace / repository / VCS の種類と remote を足し、その後 ws と repo を消す) |
| 2026-11-11 | bug | open | [test-daemons-read-real-home](./2026-11-11-test-daemons-read-real-home.md) | テストが起こす daemon が開発者の実際の HOME の .claude*/projects を読んでいる |
| 2026-11-10 | bug | open | [in-view-search-live-range-webkit](./2026-11-10-in-view-search-live-range-webkit.md) | webui の画面内検索が live Range を CSS.highlights に登録していて、WebKit で重くなる可能性 |
| 2026-11-06 | task | open | [drop-legacy-client-version-hello-key](./2026-11-06-drop-legacy-client-version-hello-key.md) | hello の wire field client_version は ccmsg_version に改名済み。移行期間の旧名の受け口を、旧 module が全部再起動された後に外す |
| 2026-11-05 | bug | open | [timeline-push-cost-after-older](./2026-11-05-timeline-push-cost-after-older.md) | older で読み切った TL では live tail の push ごとに最大 1.3 秒の long task が出る (読んだ量に比例する layout と markdown の parse) |
| 2026-11-02 | bug | open | [bun-preload-default-timeout-first-file-only](./2026-11-02-bun-preload-default-timeout-first-file-only.md) | preload の setDefaultTimeout(15_000) が最初に走るテストファイルにしか効かず、2 番目以降は 5000ms のまま |
| 2026-10-29 | task | open | [dr0045-say-leftovers](./2026-10-29-dr0045-say-leftovers.md) | DR-0045 の実装後に残った say まわりの 2 点 (say-read.json の刈り込み、追いつき中の compaction 再 push) |
| 2026-10-28 | bug | open | [fs-read-external-symlink-swap-without-module](./2026-10-28-fs-read-external-symlink-swap-without-module.md) | module の無いセッションの fs_read_external は毎回の走査で allowlist を作り直すので、許可されたパスの先祖が後から symlink に差し替わると差し替え先が読める |
| 2026-10-25 | task | open | [drop-legacy-session-launcher-keys](./2026-10-25-drop-legacy-session-launcher-keys.md) | 新 daemon は session_launcher の旧キー shell / templates / timeout_seconds を移行期間として無視して読む (DR-0018 §3.1…  |
| 2026-10-18 | bug | open | [send-message-served-dir-test-flaky-macos-ci](./2026-10-18-send-message-served-dir-test-flaky-macos-ci.md) | served dir への send_message のテストが macOS CI で確率的に no_peer_socket になる |
| 2026-10-18 | design | open | [translate-queue-cancel](./2026-10-18-translate-queue-cancel.md) | daemon の翻訳は helper に直列送信で、詰まった request が watchdog 期限 (最大 240 s) まで後続を止め、webui から取り消せない |
| 2026-10-18 | design | open | [split-pane-teammate-sessions](./2026-10-18-split-pane-teammate-sessions.md) | split pane の teammate を ccmsg のセッションとしてどう扱うか。agent teams が有効で teammateMode が tmux / iTerm2 の split pane…  |
| 2026-09-10 | task | open | [ecosystem-review-2026-09](./2026-09-10-ecosystem-review-2026-09.md) | エコシステム外部レビュー (2026-09) の指摘への対応検討 |
| 2026-09-07 | design | open | [multi-host-cluster](./2026-09-07-multi-host-cluster.md) | 複数ホストの ccmsg daemon を mesh で束ねる (クラスタ化)。room はクラスタ横断、持ち主 daemon が mid/seq 発行 |
| 2026-09-06 | design | open | [session-list-sections](./2026-09-06-session-list-sections.md) | セッション一覧のセクション再設計 (Paused/Disappeared/生存統合)。r278 裁定済、実装待ち |
| 2026-08-20 | design | open | [timeline-message-hover-toolbar](./2026-08-20-timeline-message-hover-toolbar.md) | Timeline のメッセージバブル hover ツールバー設計 (kawaz 議論まとめ)。応答バブルの翻訳タブ・md/source 切替・重い操作の格下げを決定、実装未着手 |
| 2026-09-19 | idea | idea | [replace-chat-refs-with-quotes](./2026-09-19-replace-chat-refs-with-quotes.md) | ccmsg room/メッセージ参照 (mid=) を引用形式に置き換える。docs lint PoC で 168 件検出、v1 廃止で room log が消える前に |
| 2026-07-10 | design | idea | [webui-bun-fullstack-serving](./2026-07-10-webui-bun-fullstack-serving.md) | webui 配信経路を自作 Bun.build+キャッシュ構成から Bun 1.3 公式 fullstack 機能 (HTML import + Bun.serve routes) へ置換できないか検討 |
| 2026-07-10 | design | idea | [webrtc-datachannel-transport](./2026-07-10-webrtc-datachannel-transport.md) | ccmsg メッセージを WebRTC DataChannel に載せ、静的ホスティング + ICE candidate URL + passkey 認証で tailnet 非依存の transport を実現する構想 |
| 2026-07-24 | design | open | [ipad-voice-notify-webrtc-audio](./2026-07-24-ipad-voice-notify-webrtc-audio.md) | iPad webapp で別アプリ使用中でも音声で気づける通知を、WebRTC audio track + server-side TTS で実現する構想。DataChannel transport 構想との統合検討含む |
| 2026-07-12 | design | open | [passkey-signed-post-antispoofing](./2026-07-12-passkey-signed-post-antispoofing.md) | Passkey 署名を post に添付し daemon 検証する、なりすまし対策強化案 |
