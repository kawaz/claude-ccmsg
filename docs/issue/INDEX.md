# Issue INDEX

active な issue の一覧。close 済みは `archive/` にあり、ここには載せない。

| date | category | status | slug | 概要 |
|---|---|---|---|---|
| 2026-10-10 | design | open | [pinned-sessions-storage-shape](./2026-10-10-pinned-sessions-storage-shape.md) | webui のピン留めセッションが protocol の SessionSearchHit をそのまま保存しており、必須 field が増えるたびに保存済みピンが全消えする。保存形を webui 内スキーマに分離 |
| 2026-10-10 | bug | open | [json-value-schema-deep-recursion-throws](./2026-10-10-json-value-schema-deep-recursion-throws.md) | JsonValueSchema の再帰が 20,000 階層で RangeError を parseWith の外へ throw し、DR-0038 §1・§3 に反する。優先度低 |
| 2026-10-10 | bug | open | [verify-isolated-daemon-receives-live-sessions](./2026-10-10-verify-isolated-daemon-receives-live-sessions.md) | verify の隔離 daemon に実行中の実セッションが繋がる。socket パス解決が state dir 外にある可能性、原因特定と隔離の完成 |
| 2026-10-10 | bug | open | [transcript-schema-parse-cost-on-image-heavy-sessions](./2026-10-10-transcript-schema-parse-cost-on-image-heavy-sessions.md) | transcript の行を valibot のスキーマで読む (DR-0038 §3、段 A・B) ようにした結果、13MB の transcript で JSON.parse 13ms に対し…… |
| 2026-10-10 | design | open | [truncated-ccmsg-message-partial-parse-vs-dr0038](./2026-10-10-truncated-ccmsg-message-partial-parse-vs-dr0038.md) | tryParseTruncatedCcmsgMessage の部分読み直しは DR-0038 §6 とぶつかる。救わず落とすか切り詰めを無くすか決める |
| 2026-10-10 | bug | open | [just-test-one-timeout-unidentified](./2026-10-10-just-test-one-timeout-unidentified.md) | just test で 1 件が 5 秒 timeout した (1 回のみ、test 名未特定)。2026-10-10 02:xx、段 A (transcript スキーマ) の worker が…… |
| 2026-10-09 | bug | open | [test-daemon-leak-subscribe-duplicate](./2026-10-09-test-daemon-leak-subscribe-duplicate.md) | テストが起こした daemon (subscribe-duplicate の ccmsg-dup-* ほか) がテスト終了後も残り続ける |
| 2026-10-09 | task | open | [sidecar-socket-relative-bind](./2026-10-09-sidecar-socket-relative-bind.md) | サイドカー socket を cwd 相対パスで bind / connect し、sun_path 長超過時の退避先 (別置き場) をなくせるか調査 |
| 2026-10-08 | bug | open | [plugin-name-reserved-by-validate](./2026-10-08-plugin-name-reserved-by-validate.md) | claude plugin validate が plugin 名 claude-ccmsg を reserved として error にする。名前変更要否と移行の調査 |
| 2026-10-02 | bug | open | [host-translation-mixed-text-counterexamples](./2026-10-02-host-translation-mixed-text-counterexamples.md) | host 翻訳が findings の「日英混在の日本語保持」「改行保持」と食い違う観測 (敬体化・インラインコード翻訳・空行挿入) |
| 2026-09-28 | task | open | [msgvisibleto-dead-user-only-subscribe](./2026-09-28-msgvisibleto-dead-user-only-subscribe.md) | msgVisibleTo が subscribe stream 上で死んだ判定になっている (user role only 化の帰結) |
| 2026-09-28 | bug | open | [peer-inject](./2026-09-28-peer-inject.md) | peer-inject の同一セッション宛て連続 post の到着順が非保証。sid ごとの直列化を検討 |
| 2026-09-18 | bug | open | [markdown-code-span-url-becomes-link](./2026-09-18-markdown-code-span-url-becomes-link.md) | markdown code span 内の URL がリンクにならない (v2 webui にも同issue起票済み) |
| 2026-09-16 | bug | open | [webui-terminal-tab-config-parse-error](./2026-09-16-webui-terminal-tab-config-parse-error.md) | webui の Terminal タブが出ない: 本番 config.ts の構文エラーで daemon の設定が空になっている |
| 2026-09-10 | task | open | [ecosystem-review-2026-09](./2026-09-10-ecosystem-review-2026-09.md) | エコシステム外部レビュー (2026-09) の指摘への対応検討 |
| 2026-09-08 | bug | open | [launcher-version-regex-after-rename](./2026-09-08-launcher-version-regex-after-rename.md) | `__ccmsg_extract_version` が改名後の cache パスに一致せず self-update/self-exec が無効化。DR-0032 §2.2-4 の意図的停止か regex 修正かの判断含む |
| 2026-09-08 | idea | open | [messaging-socket-direct-write](./2026-09-08-messaging-socket-direct-write.md) | messaging socket へ直接書けば subscribe / Monitor 経路なしで idle セッションを即座に起こせる (実測 2026-09-08) |
| 2026-09-07 | design | open | [multi-host-cluster](./2026-09-07-multi-host-cluster.md) | 複数ホストの ccmsg daemon を mesh で束ねる (クラスタ化)。room はクラスタ横断、持ち主 daemon が mid/seq 発行 |
| 2026-09-06 | design | open | [session-list-sections](./2026-09-06-session-list-sections.md) | セッション一覧のセクション再設計 (Paused/Disappeared/生存統合)。r278 裁定済、実装待ち |
| 2026-09-06 | design | open | [session-status-from-sessions-json](./2026-09-06-session-status-from-sessions-json.md) | セッション状態の取得元を `claude agents --json` から `sessions/<pid>.json` 直読みに変え、活動判定を transcript の turn 状態に寄せる |
| 2026-09-06 | task | open | [webui-connection-log-id](./2026-09-06-webui-connection-log-id.md) | webui 接続ログに接続 ID / User-Agent を付けて、古い bundle のまま残った端末を特定できるようにする |
| 2026-09-05 | request | open | [keepalive-pause-button](./2026-09-05-keepalive-pause-button.md) | webui からセッション単位で llm-gateway の keepalive を止める。daemon が gateway HTTP API を叩く方式 |
| 2026-08-20 | design | open | [timeline-message-hover-toolbar](./2026-08-20-timeline-message-hover-toolbar.md) | Timeline のメッセージバブル hover ツールバー設計 (kawaz r135m48-57 議論まとめ)。応答バブルの翻訳タブ・md/source 切替・重い操作の格下げを決定、実装未着手 |
| 2026-09-19 | idea | idea | [replace-chat-refs-with-quotes](./2026-09-19-replace-chat-refs-with-quotes.md) | ccmsg room/メッセージ参照 (mid=) を引用形式に置き換える。docs lint PoC で 168 件検出、v1 廃止で room log が消える前に |
| 2026-07-14 | design | idea | [dr-0009-transcript-read-after-param](./2026-07-14-dr-0009-transcript-read-after-param.md) | DR-0009 transcript_read が before のみで after (差分取得) を持たず、TLR-Q1=b 実装が全 tail 再取得経路になった件。after 追加 + append merge 化の検討 |
| 2026-07-14 | task | idea | [webui-component-render-test-infrastructure](./2026-07-14-webui-component-render-test-infrastructure.md) | webui/test が pure helper + reducer 型のみで fab/panel の open-close 遷移や effect の DOM 挙動を単体テスト化できない、render テスト基盤 (testing-library/preact 等) 導入検討 |
| 2026-07-10 | design | idea | [webui-bun-fullstack-serving](./2026-07-10-webui-bun-fullstack-serving.md) | webui 配信経路を自作 Bun.build+キャッシュ構成から Bun 1.3 公式 fullstack 機能 (HTML import + Bun.serve routes) へ置換できないか検討 |
| 2026-07-10 | design | idea | [webrtc-datachannel-transport](./2026-07-10-webrtc-datachannel-transport.md) | ccmsg メッセージを WebRTC DataChannel に載せ、静的ホスティング + ICE candidate URL + passkey 認証で tailnet 非依存の transport を実現する構想 |
| 2026-07-29 | design | open | [sandbox-origin-raw-content-serving](./2026-07-29-sandbox-origin-raw-content-serving.md) | canddy sandbox origin (apps とは別 eTLD+1) を使い、MIME 制限なしの生配信 (HTML/バイナリ/長大出力) を capability トークンで提供する設計検討 |
| 2026-07-24 | design | open | [ipad-voice-notify-webrtc-audio](./2026-07-24-ipad-voice-notify-webrtc-audio.md) | iPad webapp で別アプリ使用中でも音声で気づける通知を、WebRTC audio track + server-side TTS で実現する構想。DataChannel transport 構想との統合検討含む |
| 2026-07-22 | design | open | [broadcast-room-membership-topic](./2026-07-22-broadcast-room-membership-topic.md) | broadcast room の membership を「初回 join のみ記録・leave を書かない monotone 集合」の topic 化に変更する設計検討。DR-0013 §2.2 再解釈が要るため kawaz 裁定待ち |
| 2026-07-12 | design | open | [passkey-signed-post-antispoofing](./2026-07-12-passkey-signed-post-antispoofing.md) | Passkey 署名を post に添付し daemon 検証する、なりすまし対策強化案 |
| 2026-07-12 | bug | wip | [bun-test-flaky-fullsuite-parallel](./2026-07-12-bun-test-flaky-fullsuite-parallel.md) | bun test フルスイート並列実行時に稀に 1 件 fail する flaky の追跡 (tailscale origin 系 2 モード根治、他候補調査中) |
