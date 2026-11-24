このファイルは local-issue が各 issue の frontmatter から生成する。手で編集しない (編集しても次の生成で戻る)。

| date | category | status | issue | title | blocked_by |
|---|---|---|---|---|---|
| 2026-09-19 | idea | idea | [replace-chat-refs-with-quotes](./2026-09-19-replace-chat-refs-with-quotes.md) | ccmsg room/メッセージ参照を引用形式に置き換える |  |
| 2026-07-10 | design | idea | [webrtc-datachannel-transport](./2026-07-10-webrtc-datachannel-transport.md) | WebRTC DataChannel transport 構想 |  |
| 2026-07-10 | design | idea | [webui-bun-fullstack-serving](./2026-07-10-webui-bun-fullstack-serving.md) | Bun 1.3 fullstack 機能への webui 配信経路置換検討 |  |
| 2026-11-24 | bug | open | [comment-filter-scroll-position-shifts](./2026-11-24-comment-filter-scroll-position-shifts.md) | 💬 のフィルタで、スレッドを開くと押したコメントが上下に動く / 行の位置で開いた直後に着地先が画面の外 |  |
| 2026-11-24 | bug | open | [e2e-mermaid-spacer-webkit-fails-once](./2026-11-24-e2e-mermaid-spacer-webkit-fails-once.md) | e2e: mermaid の切り替えの spacer の試験が webkit で 1 回だけ落ちた |  |
| 2026-11-24 | bug | open | [narrow-layout-half-pixel-shift](./2026-11-24-narrow-layout-half-pixel-shift.md) | 720px 以下の幅で、本文が左に 0.5px はみ出し、右に 0.5px の隙間が出る |  |
| 2026-11-24 | bug | open | [tl-end-pills-oscillate](./2026-11-24-tl-end-pills-oscillate.md) | TL の末尾で 2 つのピルが毎フレーム交互に出入りし続ける |  |
| 2026-11-24 | bug | open | [webui-bundle-tests-timeout-first-run](./2026-11-24-webui-bundle-tests-timeout-first-run.md) | just test で webui の bundle を作るテスト 2 件が 5 秒の timeout で落ちた (1 回目だけ) |  |
| 2026-11-23 | task | open | [btw-leftovers-after-fork-migration](./2026-11-23-btw-leftovers-after-fork-migration.md) | btw を module の fork に替えた後に残った小さい後片付け |  |
| 2026-11-22 | bug | open | [person-filter-misses-queued-command-prompts](./2026-11-22-person-filter-misses-queued-command-prompts.md) | tool の実行中に送った人の発言 (queued_command の行) が TL の人の発言として描かれず、👤 のフィルタにも出ない |  |
| 2026-11-22 | bug | open | [prompt-send-trusts-inherited-hyoui-session-id](./2026-11-22-prompt-send-trusts-inherited-hyoui-session-id.md) | prompt.send の Enter が、継いだだけの HYOUI_SESSION_ID の端末 (別のセッションの端末) に押されうる |  |
| 2026-11-22 | bug | open | [userscript-save-replaces-symlink](./2026-11-22-userscript-save-replaces-symlink.md) | userscript の保存が config dir の userscript.ts を一時ファイルの rename で置き換えるので、symlink だと実ファイルになり、mode も変わる |  |
| 2026-11-20 | design | open | [daemon-env-carries-spawning-session-identity](./2026-11-20-daemon-env-carries-spawning-session-identity.md) | CLI が起こす daemon が、起こしたセッションの Claude Code の変数 (session id・messaging の token 等) を持ち続ける |  |
| 2026-11-20 | task | open | [file-edit-line-block-branch](./2026-11-20-file-edit-line-block-branch.md) | Files の編集の打鍵の重さを直す未取り込みの枝 (1 行 1 block の contenteditable、DR-0055 案) を取り込むか決める |  |
| 2026-11-16 | task | open | [keepalive-pause-op-unused](./2026-11-16-keepalive-pause-op-unused.md) | keepalive の停止の op (llm_keepalive_pause) を呼ぶものが webui に無くなった |  |
| 2026-11-16 | design | open | [tool-use-result-pairing](./2026-11-16-tool-use-result-pairing.md) | TL で tool_use と tool_result を全部の tool で組にして表示する |  |
| 2026-11-13 | request | open | [request-commission-marker-stall-watchdog](./2026-11-13-request-commission-marker-stall-watchdog.md) | 返事が要る依頼にマーカーを付け、END が無いまま受け手が止まったら送り手に知らせる |  |
| 2026-11-12 | bug | open | [plugin-cache-old-versions-accumulate](./2026-11-12-plugin-cache-old-versions-accumulate.md) | plugin キャッシュに旧版が溜まり続けて 11 GB になっている (1 版 約 150 MB × 74 版) |  |
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
