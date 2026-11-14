このファイルは local-issue が各 issue の frontmatter から生成する。手で編集しない (編集しても次の生成で戻る)。

| date | category | status | issue | blocked_by |
|---|---|---|---|---|
| 2026-09-19 | idea | idea | [ccmsg room/メッセージ参照を引用形式に置き換える](./2026-09-19-replace-chat-refs-with-quotes.md) |  |
| 2026-07-10 | design | idea | [WebRTC DataChannel transport 構想](./2026-07-10-webrtc-datachannel-transport.md) |  |
| 2026-07-10 | design | idea | [Bun 1.3 fullstack 機能への webui 配信経路置換検討](./2026-07-10-webui-bun-fullstack-serving.md) |  |
| 2026-11-13 | request | open | [返事が要る依頼にマーカーを付け、END が無いまま受け手が止まったら送り手に知らせる](./2026-11-13-request-commission-marker-stall-watchdog.md) |  |
| 2026-11-12 | bug | open | [daemon の再起動の直後、live のセッションの transcript の読み直しで event loop が 1…](./2026-11-12-catch-up-refold-holds-event-loop.md) |  |
| 2026-11-12 | bug | open | [config dir の検出が、config dir でない .claude 始まりのディレクトリも返す](./2026-11-12-config-dir-detect-returns-non-config-dirs.md) |  |
| 2026-11-12 | bug | open | [HTTP を配る daemon は、起動直後の webui の bundle と圧縮で非同期のファイル操作を 1 秒前後…](./2026-11-12-http-daemon-webui-prepare-holds-fs-pool.md) |  |
| 2026-11-12 | bug | open | [plugin キャッシュに旧版が溜まり続けて 11 GB になっている (1 版 約 150 MB × 74 版)](./2026-11-12-plugin-cache-old-versions-accumulate.md) |  |
| 2026-11-12 | request | open | [webui から秘密の値をセッションのエージェントに渡す (daemon が預かり、CLI のパイプで取り出す)](./2026-11-12-secret-handoff-to-session.md) |  |
| 2026-11-12 | bug | open | [テストのプロセスの中で動かす daemon が、開発者の shell の CCMSG_* を継ぎうる](./2026-11-12-test-daemon-inherits-ccmsg-env.md) |  |
| 2026-11-11 | design | open | [セッションの一覧のモデルを整理する (name / workspace / repository / VCS の種類と …](./2026-11-11-peer-model-workspace-vcs-repo.md) |  |
| 2026-11-11 | bug | open | [TL で tool が 1 件だけの時に直接見せている中身が、2 件目が来ると fold に包まれて作り直される](./2026-11-11-single-tool-fold-remounts-when-second-arrives.md) |  |
| 2026-11-11 | design | open | [peers の vcs.workspace を jj の記録にある workspace 名から取る (今はディレクトリ名…](./2026-11-11-vcs-workspace-name-from-jj-record.md) |  |
| 2026-11-05 | bug | open | [older で読み切った Timeline では live tail の push ごとに重い](./2026-11-05-timeline-push-cost-after-older.md) |  |
| 2026-11-02 | bug | open | [preload の setDefaultTimeout(15_000) が最初に走るテストファイルにしか効かず、2 番目…](./2026-11-02-bun-preload-default-timeout-first-file-only.md) |  |
| 2026-10-28 | bug | open | [module の無いセッションの fs_read_external は毎回の走査で allowlist を作り直すので、…](./2026-10-28-fs-read-external-symlink-swap-without-module.md) |  |
| 2026-10-18 | design | open | [split pane の teammate を ccmsg のセッションとしてどう扱うか](./2026-10-18-split-pane-teammate-sessions.md) |  |
| 2026-10-18 | design | open | [詰まった翻訳が後続の翻訳を最大 240 s 止め、webui から取り消せない](./2026-10-18-translate-queue-cancel.md) |  |
| 2026-09-10 | task | open | [エコシステム外部レビュー (2026-09) の指摘への対応検討](./2026-09-10-ecosystem-review-2026-09.md) |  |
| 2026-09-07 | design | open | [複数ホストの ccmsg daemon を mesh で束ねる (クラスタ化)](./2026-09-07-multi-host-cluster.md) |  |
| 2026-09-06 | design | open | [セッション一覧のセクション再設計 (Paused / Disappeared / 生存統合)](./2026-09-06-session-list-sections.md) |  |
| 2026-08-20 | design | open | [Timeline のメッセージバブル hover ツールバー設計](./2026-08-20-timeline-message-hover-toolbar.md) |  |
| 2026-07-24 | design | open | [iPad webapp への音声割り込み通知 (WebRTC audio track + TTS)](./2026-07-24-ipad-voice-notify-webrtc-audio.md) |  |
| 2026-07-12 | design | open | [Passkey 署名による post のなりすまし対策強化](./2026-07-12-passkey-signed-post-antispoofing.md) |  |
| 2026-11-10 | bug | blocked | [webui の画面内検索が live Range を CSS.highlights に登録していて、WebKit で重く…](./2026-11-10-in-view-search-live-range-webkit.md) | timeline-push-cost-after-older |
