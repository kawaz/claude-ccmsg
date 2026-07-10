# Issue INDEX

active な issue の一覧。close 済みは `archive/` にあり、ここには載せない。

| date | category | status | slug | 概要 |
|---|---|---|---|---|
| 2026-07-04 | design | idea | [daemon-side-subscribe-detection](./2026-07-04-daemon-side-subscribe-detection.md) | UserPromptSubmit hook の subscribe 稼働検出を ps 走査から daemon 問い合わせへ置き換える案 |
| 2026-07-09 | design | idea | [webui-workspace-roadmap](./2026-07-09-webui-workspace-roadmap.md) | webui を workspace UI に育てる長期 roadmap (セッション一覧/jsonl ビューア/ファイルツリー等) |
| 2026-07-10 | design | idea | [webrtc-datachannel-transport](./2026-07-10-webrtc-datachannel-transport.md) | ccmsg メッセージを WebRTC DataChannel に載せ、静的ホスティング + ICE candidate URL + passkey 認証で tailnet 非依存の transport を実現する構想 |
| 2026-07-10 | design | idea | [webui-bun-fullstack-serving](./2026-07-10-webui-bun-fullstack-serving.md) | webui 配信経路を自作 Bun.build+キャッシュ構成から Bun 1.3 公式 fullstack 機能 (HTML import + Bun.serve routes) へ置換できないか検討 |
| 2026-07-10 | design | open | [webui-transport-trust-model-security-critical](./2026-07-10-webui-transport-trust-model-security-critical.md) | **Critical**: HTTP/WS trust model 見直し (Origin 検証 + 127.0.0.1 bind 回帰 + tailnet allow 削除)、悪意 Web ページからの DoS/情報漏洩/偽メッセージ注入を防ぐ |
