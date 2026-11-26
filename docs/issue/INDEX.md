このファイルは local-issue が各 issue の frontmatter から生成する。手で編集しない (編集しても次の生成で戻る)。

| date | category | status | issue | title | blocked_by |
|---|---|---|---|---|---|
| 2026-09-19 | idea | idea | [replace-chat-refs-with-quotes](./2026-09-19-replace-chat-refs-with-quotes.md) | ccmsg room/メッセージ参照を引用形式に置き換える |  |
| 2026-07-10 | design | idea | [webrtc-datachannel-transport](./2026-07-10-webrtc-datachannel-transport.md) | WebRTC DataChannel transport 構想 |  |
| 2026-07-10 | design | idea | [webui-bun-fullstack-serving](./2026-07-10-webui-bun-fullstack-serving.md) | Bun 1.3 fullstack 機能への webui 配信経路置換検討 |  |
| 2026-11-26 | request | open | [tool-usage-into-descriptions](./2026-11-26-tool-usage-into-descriptions.md) | tool の使い方を skill から tool の description に移し、skill は tool 名の列挙と短い説明に止める |  |
| 2026-11-25 | request | open | [agy-tool](./2026-11-25-agy-tool.md) | agy (Antigravity の CLI) を ccmsg の tool から会話として使う |  |
| 2026-11-25 | bug | open | [dump-misses-queued-person-prompts](./2026-11-25-dump-misses-queued-person-prompts.md) | ccmsg dump が、tool の実行中に送った人の発言 (queued_command の行) を出さない |  |
| 2026-11-25 | request | open | [lean-highlight-and-svg-script-run](./2026-11-25-lean-highlight-and-svg-script-run.md) | markdown の描画に、Lean 4 のシンタックスハイライトと svg のスクリプトの実行を入れる (dirview と揃える) |  |
| 2026-11-23 | task | open | [btw-leftovers-after-fork-migration](./2026-11-23-btw-leftovers-after-fork-migration.md) | btw を module の fork に替えた後に残った小さい後片付け |  |
| 2026-11-20 | design | open | [daemon-env-carries-spawning-session-identity](./2026-11-20-daemon-env-carries-spawning-session-identity.md) | CLI が起こす daemon が、起こしたセッションの Claude Code の変数 (session id・messaging の token 等) を持ち続ける |  |
| 2026-11-20 | task | open | [file-edit-line-block-branch](./2026-11-20-file-edit-line-block-branch.md) | Files の編集の打鍵の重さを直す未取り込みの枝 (1 行 1 block の contenteditable、DR-0055 案) を取り込むか決める |  |
| 2026-11-16 | task | open | [keepalive-pause-op-unused](./2026-11-16-keepalive-pause-op-unused.md) | keepalive の停止の op (llm_keepalive_pause) を呼ぶものが webui に無くなった |  |
| 2026-11-16 | design | open | [tool-use-result-pairing](./2026-11-16-tool-use-result-pairing.md) | TL で tool_use と tool_result を全部の tool で組にして表示する |  |
| 2026-11-13 | request | open | [request-commission-marker-stall-watchdog](./2026-11-13-request-commission-marker-stall-watchdog.md) | 返事が要る依頼にマーカーを付け、END が無いまま受け手が止まったら送り手に知らせる |  |
| 2026-11-11 | design | open | [vcs-workspace-name-from-jj-record](./2026-11-11-vcs-workspace-name-from-jj-record.md) | peers の vcs.workspace を jj の記録にある workspace 名から取る (今はディレクトリ名) |  |
| 2026-11-05 | bug | open | [timeline-push-cost-after-older](./2026-11-05-timeline-push-cost-after-older.md) | older で読み切った Timeline では live tail の push ごとに重い |  |
| 2026-10-18 | design | open | [split-pane-teammate-sessions](./2026-10-18-split-pane-teammate-sessions.md) | split pane の teammate を ccmsg のセッションとしてどう扱うか |  |
| 2026-10-18 | design | open | [translate-queue-cancel](./2026-10-18-translate-queue-cancel.md) | 詰まった翻訳が後続の翻訳を最大 240 s 止め、webui から取り消せない |  |
| 2026-09-10 | task | open | [ecosystem-review-2026-09](./2026-09-10-ecosystem-review-2026-09.md) | エコシステム外部レビュー (2026-09) の指摘への対応検討 |  |
| 2026-09-07 | design | open | [multi-host-cluster](./2026-09-07-multi-host-cluster.md) | 複数ホストの ccmsg daemon を mesh で束ねる (クラスタ化) |  |
| 2026-09-06 | design | open | [session-list-sections](./2026-09-06-session-list-sections.md) | セッション一覧のセクション再設計 (Paused / Disappeared / 生存統合) |  |
| 2026-08-20 | design | open | [timeline-message-hover-toolbar](./2026-08-20-timeline-message-hover-toolbar.md) | Timeline のメッセージバブル hover ツールバー設計 |  |
| 2026-07-24 | design | open | [ipad-voice-notify-webrtc-audio](./2026-07-24-ipad-voice-notify-webrtc-audio.md) | iPad webapp への音声割り込み通知 (WebRTC audio track + TTS) |  |
| 2026-07-12 | design | open | [passkey-signed-post-antispoofing](./2026-07-12-passkey-signed-post-antispoofing.md) | Passkey 署名による post のなりすまし対策強化 |  |
