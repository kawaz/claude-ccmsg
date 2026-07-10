# kawaz 発言記録: WebRTC DataChannel ベースの将来構想 (2026-07-10)

webui の HTTPS 化 issue (`docs/issue/2026-07-10-webui-https.md`) への裁定と同時に表明された、
transport 層の長期的な別案。一次資料としてここに逐語で残す。

## 逐語 (verbatim)

> tailscale serveで解決したから良い。ただまぁ最終的には他の案としては通信はwebrtcdatachannelにメッセージ載せる形のプロトコルにしといて、ghpagesとかcloudeflare辺りに静的アセットデプロイしといて、candidate付きのURLで開いてpeer出来たらpasskey認証を経て、あとはそのチャンネル通じてメッセージ送受信する。みたいな構成だとどこでも繋げられるし良いかなとか思ってた。

## 読み取れる構成要素 (エージェント解釈、[提案] 扱い)

1. **transport**: ccmsg メッセージを WebRTC DataChannel に載せるプロトコル (現行は WS)
2. **静的アセット配信**: GitHub Pages / Cloudflare (Pages 等) に webui の静的アセットをデプロイ
   (= daemon がアセットをサーブする現行 DR-0004/0005 構成とは別系統)
3. **シグナリング**: ICE candidate 情報を URL に埋め込み、その URL を開くだけで peer 接続を試みる
4. **認証**: peer 確立後に passkey (WebAuthn) 認証を挟み、通過後にメッセージ送受信を許可
5. **狙い**: tailnet に依存せず「どこでも繋げられる」

## ステータス

- HTTPS 化の当面の解は **tailscale serve で解決済み** [kawaz 裁定 2026-07-10]
- 本構想は将来の別案 (「良いかなとか思ってた」の温度感)。issue:
  `docs/issue/2026-07-10-webrtc-datachannel-transport.md` で idea として追跡
