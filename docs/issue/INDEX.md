# Issue INDEX

active な issue の一覧。close 済みは `archive/` にあり、ここには載せない。

| date | category | status | slug | 概要 |
|---|---|---|---|---|
| 2026-08-12 | design | open | [timeline-crossline-incremental](./2026-08-12-timeline-crossline-incremental.md) | Timeline cross-line 処理 (pairQueuedTurns/offsets/groupTimelineLines 等) が live-tail 毎行で全行走査、store.ts lines 連結も O(N)。virtual-scroll とは独立コスト |
| 2026-08-12 | task | open | [statuspanel-fold-normalization](./2026-08-12-statuspanel-fold-normalization.md) | StatusPanel の details 4 箇所 (完了/ENV/pending/completed) を Fold コンポーネントへ統一する。ENV 箇所は onToggle 用 prop 追加が要る |
| 2026-08-02 | design | open | [attachment-file-preview-and-grouping](./2026-08-02-attachment-file-preview-and-grouping.md) | file 系 attachment のプレビュー表示 + プロジェクト外ファイルのグループ分け (Read/Edit/Write vs attachments) |
| 2026-07-31 | design | open | [session-status-two-phase](./2026-07-31-session-status-two-phase.md) | session_status の 2-phase 化検討 (同一接続内の cold scan 待ちの解消)。実測なしで着手しない (kawaz 裁定 2026-07-31) |
| 2026-07-14 | design | idea | [dr-0009-transcript-read-after-param](./2026-07-14-dr-0009-transcript-read-after-param.md) | DR-0009 transcript_read が before のみで after (差分取得) を持たず、TLR-Q1=b 実装が全 tail 再取得経路になった件。after 追加 + append merge 化の検討 |
| 2026-07-14 | task | idea | [webui-component-render-test-infrastructure](./2026-07-14-webui-component-render-test-infrastructure.md) | webui/test が pure helper + reducer 型のみで fab/panel の open-close 遷移や effect の DOM 挙動を単体テスト化できない、render テスト基盤 (testing-library/preact 等) 導入検討 |
| 2026-07-10 | design | idea | [webui-bun-fullstack-serving](./2026-07-10-webui-bun-fullstack-serving.md) | webui 配信経路を自作 Bun.build+キャッシュ構成から Bun 1.3 公式 fullstack 機能 (HTML import + Bun.serve routes) へ置換できないか検討 |
| 2026-07-10 | design | idea | [webrtc-datachannel-transport](./2026-07-10-webrtc-datachannel-transport.md) | ccmsg メッセージを WebRTC DataChannel に載せ、静的ホスティング + ICE candidate URL + passkey 認証で tailnet 非依存の transport を実現する構想 |
| 2026-07-29 | design | open | [timeline-virtual-scroll](./2026-07-29-timeline-virtual-scroll.md) | TL が全行 DOM 化しているため DOM/リスナ数が際限なく増える (実測: 1 セッション DOM 73,000 ノード / リスナ 12,000 個)。windowing 導入の設計検討 |
| 2026-07-29 | design | open | [sandbox-origin-raw-content-serving](./2026-07-29-sandbox-origin-raw-content-serving.md) | canddy sandbox origin (apps とは別 eTLD+1) を使い、MIME 制限なしの生配信 (HTML/バイナリ/長大出力) を capability トークンで提供する設計検討 |
| 2026-07-24 | design | open | [ipad-voice-notify-webrtc-audio](./2026-07-24-ipad-voice-notify-webrtc-audio.md) | iPad webapp で別アプリ使用中でも音声で気づける通知を、WebRTC audio track + server-side TTS で実現する構想。DataChannel transport 構想との統合検討含む |
| 2026-07-22 | design | open | [broadcast-room-membership-topic](./2026-07-22-broadcast-room-membership-topic.md) | broadcast room の membership を「初回 join のみ記録・leave を書かない monotone 集合」の topic 化に変更する設計検討。DR-0013 §2.2 再解釈が要るため kawaz 裁定待ち |
| 2026-07-12 | design | open | [passkey-signed-post-antispoofing](./2026-07-12-passkey-signed-post-antispoofing.md) | Passkey 署名を post に添付し daemon 検証する、なりすまし対策強化案 |
| 2026-07-12 | bug | wip | [bun-test-flaky-fullsuite-parallel](./2026-07-12-bun-test-flaky-fullsuite-parallel.md) | bun test フルスイート並列実行時に稀に 1 件 fail する flaky の追跡 (tailscale origin 系 2 モード根治、他候補調査中) |
| 2026-07-09 | design | wip | [webui-workspace-roadmap](./2026-07-09-webui-workspace-roadmap.md) | webui を workspace UI に育てる長期 roadmap (セッションリスト/ルームリスト+チャット/ファイルツリー+コードビューア、並列進行) |
