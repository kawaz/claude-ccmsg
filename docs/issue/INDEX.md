このファイルは local-issue が各 issue の frontmatter から生成する。手で編集しない (編集しても次の生成で戻る)。

| date | category | status | issue | title | blocked_by |
|---|---|---|---|---|---|
| 2026-09-19 | idea | idea | [replace-chat-refs-with-quotes](./2026-09-19-replace-chat-refs-with-quotes.md) | ccmsg room/メッセージ参照を引用形式に置き換える |  |
| 2026-07-10 | design | idea | [webrtc-datachannel-transport](./2026-07-10-webrtc-datachannel-transport.md) | WebRTC DataChannel transport 構想 |  |
| 2026-07-10 | design | idea | [webui-bun-fullstack-serving](./2026-07-10-webui-bun-fullstack-serving.md) | Bun 1.3 fullstack 機能への webui 配信経路置換検討 |  |
| 2026-11-20 | design | open | [daemon-env-carries-spawning-session-identity](./2026-11-20-daemon-env-carries-spawning-session-identity.md) | CLI が起こす daemon が、起こしたセッションの Claude Code の変数 (session id・messaging の token 等) を持ち続ける |  |
| 2026-11-16 | task | open | [keepalive-pause-op-unused](./2026-11-16-keepalive-pause-op-unused.md) | keepalive の停止の op (llm_keepalive_pause) を呼ぶものが webui に無くなった |  |
| 2026-11-16 | design | open | [tool-use-result-pairing](./2026-11-16-tool-use-result-pairing.md) | TL で tool_use と tool_result を全部の tool で組にして表示する |  |
| 2026-11-13 | request | open | [request-commission-marker-stall-watchdog](./2026-11-13-request-commission-marker-stall-watchdog.md) | 返事が要る依頼にマーカーを付け、END が無いまま受け手が止まったら送り手に知らせる |  |
| 2026-11-12 | bug | open | [catch-up-refold-holds-event-loop](./2026-11-12-catch-up-refold-holds-event-loop.md) | daemon の再起動の直後、live のセッションの transcript の読み直しで event loop が 100ms 以上塞がる |  |
| 2026-11-12 | bug | open | [http-daemon-webui-prepare-holds-fs-pool](./2026-11-12-http-daemon-webui-prepare-holds-fs-pool.md) | HTTP を配る daemon は、起動直後の webui の bundle と圧縮で非同期のファイル操作を 1 秒前後待たせる |  |
| 2026-11-12 | bug | open | [plugin-cache-old-versions-accumulate](./2026-11-12-plugin-cache-old-versions-accumulate.md) | plugin キャッシュに旧版が溜まり続けて 11 GB になっている (1 版 約 150 MB × 74 版) |  |
| 2026-11-12 | request | open | [secret-handoff-to-session](./2026-11-12-secret-handoff-to-session.md) | webui から秘密の値をセッションのエージェントに渡す (daemon が預かり、CLI のパイプで取り出す) |  |
| 2026-11-11 | design | open | [peer-model-workspace-vcs-repo](./2026-11-11-peer-model-workspace-vcs-repo.md) | セッションの一覧のモデルを整理する (name / workspace / repository / VCS の種類と remote を足し、その後 ws と repo を消す) |  |
| 2026-11-11 | bug | open | [single-tool-fold-remounts-when-second-arrives](./2026-11-11-single-tool-fold-remounts-when-second-arrives.md) | TL で tool が 1 件だけの時に直接見せている中身が、2 件目が来ると fold に包まれて作り直される |  |
| 2026-11-11 | design | open | [vcs-workspace-name-from-jj-record](./2026-11-11-vcs-workspace-name-from-jj-record.md) | peers の vcs.workspace を jj の記録にある workspace 名から取る (今はディレクトリ名) |  |
| 2026-11-10 | bug | open | [in-view-search-live-range-webkit](./2026-11-10-in-view-search-live-range-webkit.md) | webui の画面内検索が live Range を CSS.highlights に登録していて、WebKit で重くなる可能性 |  |
| 2026-11-05 | bug | open | [timeline-push-cost-after-older](./2026-11-05-timeline-push-cost-after-older.md) | older で読み切った Timeline では live tail の push ごとに重い |  |
| 2026-11-02 | bug | open | [bun-preload-default-timeout-first-file-only](./2026-11-02-bun-preload-default-timeout-first-file-only.md) | preload の setDefaultTimeout(15_000) が最初に走るテストファイルにしか効かず、2 番目以降は 5000ms のまま |  |
| 2026-10-18 | design | open | [split-pane-teammate-sessions](./2026-10-18-split-pane-teammate-sessions.md) | split pane の teammate を ccmsg のセッションとしてどう扱うか |  |
| 2026-10-18 | design | open | [translate-queue-cancel](./2026-10-18-translate-queue-cancel.md) | 詰まった翻訳が後続の翻訳を最大 240 s 止め、webui から取り消せない |  |
| 2026-09-10 | task | open | [ecosystem-review-2026-09](./2026-09-10-ecosystem-review-2026-09.md) | エコシステム外部レビュー (2026-09) の指摘への対応検討 |  |
| 2026-09-07 | design | open | [multi-host-cluster](./2026-09-07-multi-host-cluster.md) | 複数ホストの ccmsg daemon を mesh で束ねる (クラスタ化) |  |
| 2026-09-06 | design | open | [session-list-sections](./2026-09-06-session-list-sections.md) | セッション一覧のセクション再設計 (Paused / Disappeared / 生存統合) |  |
| 2026-08-20 | design | open | [timeline-message-hover-toolbar](./2026-08-20-timeline-message-hover-toolbar.md) | Timeline のメッセージバブル hover ツールバー設計 |  |
| 2026-07-24 | design | open | [ipad-voice-notify-webrtc-audio](./2026-07-24-ipad-voice-notify-webrtc-audio.md) | iPad webapp への音声割り込み通知 (WebRTC audio track + TTS) |  |
| 2026-07-12 | design | open | [passkey-signed-post-antispoofing](./2026-07-12-passkey-signed-post-antispoofing.md) | Passkey 署名による post のなりすまし対策強化 |  |
