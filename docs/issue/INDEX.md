# Issue INDEX

active な issue の一覧。close 済みは `archive/` にあり、ここには載せない。

| date | category | status | slug | 概要 |
|---|---|---|---|---|
| 2026-07-04 | design | idea | [daemon-side-subscribe-detection](./2026-07-04-daemon-side-subscribe-detection.md) | UserPromptSubmit hook の subscribe 稼働検出を ps 走査から daemon 問い合わせへ置き換える案 |
| 2026-07-09 | design | wip | [webui-workspace-roadmap](./2026-07-09-webui-workspace-roadmap.md) | webui を workspace UI に育てる長期 roadmap (セッションリスト/ルームリスト+チャット/ファイルツリー+コードビューア、並列進行) |
| 2026-07-10 | design | idea | [webrtc-datachannel-transport](./2026-07-10-webrtc-datachannel-transport.md) | ccmsg メッセージを WebRTC DataChannel に載せ、静的ホスティング + ICE candidate URL + passkey 認証で tailnet 非依存の transport を実現する構想 |
| 2026-07-10 | design | idea | [webui-bun-fullstack-serving](./2026-07-10-webui-bun-fullstack-serving.md) | webui 配信経路を自作 Bun.build+キャッシュ構成から Bun 1.3 公式 fullstack 機能 (HTML import + Bun.serve routes) へ置換できないか検討 |
| 2026-07-11 | design | idea | [origin-isolated-app-reverse-proxy](./2026-07-11-origin-isolated-app-reverse-proxy.md) | 自己所有ドメイン + wildcard ACME の app リバースプロキシ構想 (docroot ごとの origin 分離で JS 実行可能な file serving) |
| 2026-07-12 | task | open | [caddy-origin-allow-persistence](./2026-07-12-caddy-origin-allow-persistence.md) | caddy-app-proxy (Caddy) 経由の webui オリジン許可を daemon respawn 越しに永続化したい |
| 2026-07-12 | bug | open | [prevent-u1-masquerade-on-missing-sid](./2026-07-12-prevent-u1-masquerade-on-missing-sid.md) | CCMSG_SID 未設定投稿が u1 (ユーザ) 名義に化け、送信元判定を狂わせる |
| 2026-07-12 | design | open | [post-release-daemon-upgrade-lag](./2026-07-12-post-release-daemon-upgrade-lag.md) | リリース後、新 client が daemon に接触するまで旧 daemon が配信され続けるギャップの改善案 (push 直後 1 回接触/webui バナー/daemon self-upgrade) |
