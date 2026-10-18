# Issue INDEX

active な issue の一覧。close 済みは `archive/` にあり、ここには載せない。

| date | category | status | slug | 概要 |
|---|---|---|---|---|
| 2026-10-18 | design | open | [split-pane-teammate-sessions](./2026-10-18-split-pane-teammate-sessions.md) | split pane の teammate を ccmsg のセッションとしてどう扱うか。agent teams が有効で teammateMode が tmux / iTerm2 の split pane…  |
| 2026-10-18 | bug | open | [translate-watchdog-vs-os-model-contention](./2026-10-18-translate-watchdog-vs-os-model-contention.md) | daemon の translate watchdog が、OS の on-device モデルの混雑中に正常な翻訳を「詰まった」と判断して helper を kill しうる |
| 2026-10-14 | design | open | [mods-consolidation-and-turn-events](./2026-10-14-mods-consolidation-and-turn-events.md) | classic hook を mods の session.start 等に寄せる検討と、TL の応答中を turn event で daemon に即時通知する設計 |
| 2026-10-10 | design | open | [pinned-sessions-storage-shape](./2026-10-10-pinned-sessions-storage-shape.md) | webui のピン留めセッションが protocol の SessionSearchHit をそのまま保存しており、必須 field が増えるたびに保存済みピンが全消えする。保存形を webui 内スキーマに分離 |
| 2026-10-10 | bug | open | [verify-isolated-daemon-receives-live-sessions](./2026-10-10-verify-isolated-daemon-receives-live-sessions.md) | verify の隔離 daemon に実行中の実セッションが繋がる。socket パス解決が state dir 外にある可能性、原因特定と隔離の完成 |
| 2026-10-09 | task | open | [sidecar-socket-relative-bind](./2026-10-09-sidecar-socket-relative-bind.md) | サイドカー socket を cwd 相対パスで bind / connect し、sun_path 長超過時の退避先 (別置き場) をなくせるか調査 |
| 2026-09-10 | task | open | [ecosystem-review-2026-09](./2026-09-10-ecosystem-review-2026-09.md) | エコシステム外部レビュー (2026-09) の指摘への対応検討 |
| 2026-09-07 | design | open | [multi-host-cluster](./2026-09-07-multi-host-cluster.md) | 複数ホストの ccmsg daemon を mesh で束ねる (クラスタ化)。room はクラスタ横断、持ち主 daemon が mid/seq 発行 |
| 2026-09-06 | design | open | [session-list-sections](./2026-09-06-session-list-sections.md) | セッション一覧のセクション再設計 (Paused/Disappeared/生存統合)。r278 裁定済、実装待ち |
| 2026-09-06 | design | open | [session-status-from-sessions-json](./2026-09-06-session-status-from-sessions-json.md) | セッション状態の取得元を `claude agents --json` から `sessions/<pid>.json` 直読みに変え、活動判定を transcript の turn 状態に寄せる |
| 2026-09-05 | request | open | [keepalive-pause-button](./2026-09-05-keepalive-pause-button.md) | webui からセッション単位で llm-gateway の keepalive を止める。daemon が gateway HTTP API を叩く方式 |
| 2026-08-20 | design | open | [timeline-message-hover-toolbar](./2026-08-20-timeline-message-hover-toolbar.md) | Timeline のメッセージバブル hover ツールバー設計 (kawaz 議論まとめ)。応答バブルの翻訳タブ・md/source 切替・重い操作の格下げを決定、実装未着手 |
| 2026-09-19 | idea | idea | [replace-chat-refs-with-quotes](./2026-09-19-replace-chat-refs-with-quotes.md) | ccmsg room/メッセージ参照 (mid=) を引用形式に置き換える。docs lint PoC で 168 件検出、v1 廃止で room log が消える前に |
| 2026-07-14 | design | idea | [dr-0009-transcript-read-after-param](./2026-07-14-dr-0009-transcript-read-after-param.md) | DR-0009 transcript_read が before のみで after (差分取得) を持たず、TLR-Q1=b 実装が全 tail 再取得経路になった件。after 追加 + append merge 化の検討 |
| 2026-07-10 | design | idea | [webui-bun-fullstack-serving](./2026-07-10-webui-bun-fullstack-serving.md) | webui 配信経路を自作 Bun.build+キャッシュ構成から Bun 1.3 公式 fullstack 機能 (HTML import + Bun.serve routes) へ置換できないか検討 |
| 2026-07-10 | design | idea | [webrtc-datachannel-transport](./2026-07-10-webrtc-datachannel-transport.md) | ccmsg メッセージを WebRTC DataChannel に載せ、静的ホスティング + ICE candidate URL + passkey 認証で tailnet 非依存の transport を実現する構想 |
| 2026-07-24 | design | open | [ipad-voice-notify-webrtc-audio](./2026-07-24-ipad-voice-notify-webrtc-audio.md) | iPad webapp で別アプリ使用中でも音声で気づける通知を、WebRTC audio track + server-side TTS で実現する構想。DataChannel transport 構想との統合検討含む |
| 2026-07-12 | design | open | [passkey-signed-post-antispoofing](./2026-07-12-passkey-signed-post-antispoofing.md) | Passkey 署名を post に添付し daemon 検証する、なりすまし対策強化案 |
