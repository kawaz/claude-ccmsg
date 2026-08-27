# Claude Code ネイティブのクロスセッションメッセージングと ccmsg の比較

## 判明した事実

- Claude Code には ListAgents / SendMessage によるセッション間メッセージングがネイティブ実装されている (同一マシンの peer セッション一覧 + 名前指定送信)。2026-08-27 実機確認 (使い捨て probe セッションとの双方向往復)
- 受信側には本文が**そのまま inline で届く** (`<cross-session-message from="uds:/tmp/cc-socks/<pid>.sock" from-name="<名前>" from-mode="prompting">` ラッパー付きの user-turn として transcript に残る)。ccmsg のような「通知 → `ccmsg read rNmN` で本文取得」のワンクッションが無い
- 返信は SendMessage 1 呼び出し (to に from-name を指定)。宛先はセッション名で解決、曖昧時のみ [ref] を付ける
- `notify_when_idle: true` で相手セッションの idle を一回限り購読できる (ポーリング不要)。ccmsg に相当機能なし
- 配送はネイティブに受信側を起こす。ccmsg のような subscribe ストリーム (Monitor 常駐) が不要で、/clear 後の張り直しも不要
- busy 中の相手にはキューされ、次の tool round で配送される
- ユーザ (kawaz) からはやり取りが見えない: room / webui / 履歴閲覧に相当するものが無く、記録は各セッションの transcript のみ
- 1:1 のみ (room / broadcast / グループ無し)。基本は同一マシン内
- msg_id は返るが既読・到達の可観測性は無い (ccmsg は room log + seq/last_mid で追える)
- **長文も全文 inline で届く**: 約 4500 字の送信・数千字の返信とも切り詰め・read 指示化なしに双方向とも全文が inline 配送された (2026-08-27 実測)。ccmsg の inline は `CCMSG_WIRE_MSG_SAFE_BYTES` (既定 **400 バイト**、Monitor `<event>` の経験的切り詰め ~500 文字への安全率) を超えると `msg_via` の read 指示に置換される — 「短文は inline」の閾値がネイティブは実質無制限、ccmsg は 400B と大差がある
- `notify_when_idle` の通知は実際に着信することを確認済み (相手がターンを終えた時点で `[Cross-session idle notice]` が一回だけ注入される。別途モニタプロセスは不要)
- **同名衝突は送信時に拒否される**: 同名セッションが複数 (2 つ・3 つで実測) ある時、bare name 送信は失敗し全候補が `[ref]` (ListAgents が行ごとに振る短縮 16 進ハンドル) 付きで列挙される。`name [ref]` 指定で 1 つにだけ届く (受信側の実確認済み)。ref は直前の listing / エラーに出たものだけ解決可能な揮発ハンドルで、sessionId とは別物。安定した機械可読アドレスが無いのはネイティブ側の弱点 (ccmsg は sid が正)
- **CLAUDE_CONFIG_DIR 面を跨ぐと通じない**: emrd 面に立てたセッションは personal 面の ListAgents に出ず、送信も `No agent named ... is reachable` で拒否 (2026-08-27 実測、kawaz が emrd 側に検証セッションを用意)。面分離運用では面越え通信は ccmsg のみ可能 = ccmsg の差別化点

## 実用的な示唆

- 「read のワンクッション不要」「subscribe 常駐不要」はネイティブ側の明確な優位。セッション間の軽い調整はネイティブに流れる可能性が高い
- ccmsg の固有価値は「ユーザが会話に参加・観測できる」(room、webui Timeline、履歴、通知) + メッセージング以外のプラットフォーム機能 (dump / fs / todos / rename / launcher)。純粋なセッション間 1:1 通信は競合、ユーザ可視性とプラットフォームは非競合
- 統合方針 (kawaz 裁定 r151m27): ネイティブメッセージを ccmsg Timeline のエージェント間通信バブルとして表示する (transcript の `<cross-session-message>` タグをマッチパターンで拾う)。issue `docs/issue/2026-08-27-timeline-native-cross-session-message-bubbles.md` に起票済み

## 検証の詳細

- 手順: `/tmp/native-msg-verify` cwd で `hyoui run --detached -- claude --model haiku --effort low --name native-msg-probe "<待機指示>"` により probe セッションを起動 → ListAgents で `native-msg-probe [d37208] · interactive · busy · started 1s ago` と即座に一覧に出現 → SendMessage (notify_when_idle: true 付き) で送信 → probe から `<cross-session-message>` ラップの返信が自動着信 (probe 側の報告: 受信は system-reminder 通知 + ラッパー付き本文、返信は SendMessage 1 ステップ) → probe を hyoui kill で個別停止
- 送信結果には msg_id (uuid) と「Subscribed — idle 時に一回通知」の応答が返る
- 検証は短文 1 往復 + 長文 1 往復 + 一覧確認 (busy キューイングは本セッションの worker 運用で日常的に観測済みの挙動)
- 長文検証: 2 台目 probe (native-msg-probe2) に約 4500 字を送信 → 送信は拒否・切り詰めなしで成功 (msg_id 返却) → probe2 から数千字の長文返信が全文 inline で着信。ccmsg 側の閾値は `packages/daemon/src/server.ts` の `readWireMsgSafeBytesEnv()` (既定 400、`CCMSG_WIRE_MSG_SAFE_BYTES` で変更可) がソース

## 関連

- issue: `docs/issue/2026-08-27-timeline-native-cross-session-message-bubbles.md`
