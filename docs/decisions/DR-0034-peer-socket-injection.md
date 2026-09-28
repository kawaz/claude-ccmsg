# DR-0034: v1 daemon による room msg の peer messaging socket 直接注入

Status: Accepted / 実装済 (2026-09-28)
Date: 2026-09-28
関連: [DR-0027](./DR-0027-tl-ccmsg-canonical-lookup.md) §6 Addendum 2026-09-26 (単体 ccmsg 経由の受信封筒仕様、本 DR が同じ封筒形を daemon 自身の配送にも適用する)、[DR-0017](./DR-0017-reply-command.md) (`ccmsg reply` と `reply_via`)、`docs/journal/2026-09-26-direct-delivery-migration.md`

## 1. 背景

Claude Code の Monitor tool から `persistent` オプションが無くなり、`ccmsg subscribe` を Monitor で常駐させて受け手に配送する経路が使えなくなった。単体の ccmsg (別リポ) は Claude Code の peer messaging socket へ直接書き込む経路に切り替え済みだが (DR-0027 §6 Addendum)、v1 daemon 自身の room 配送は subscribe 配信のみに依存したままだった。subscribe 配信は受け手のプロセス常駐を要求するため、常駐が無い受け手には room の msg が届かない。

Claude Code は非公式プロトコルとして `<config home>/sessions/<pid>.json` (`sessionId` / `pid` / `messagingSocketPath` / `peerProtocol`) と、同じディレクトリの `<pid>.<hex>.key` (`peerToken`) による peer messaging を持つ。これに newline-delimited JSON で `auth` フレームと `user` フレームを送ると、受け手のプロセスが常駐していなくても transcript に直接メッセージが載る。実機は Claude Code 2.1.263 / 2.1.282 で確認済み。

## 2. 決定

daemon が room の msg イベントを配送するとき (`deliver` / `deliverNewRoom`)、既存の subscribe 配信に加えて、room の member セッションそれぞれへ peer messaging socket 経由の注入を試みる (`packages/daemon/src/peer-inject.ts` の `PeerInjector`)。

- **対象**: msg イベントのみ。member のうち投稿者本人以外、かつ `to` で絞られていれば絞り込み後の宛先。`daemon.sessions` にその sid の `configDir` が無い (= セッションが一度も CLAUDE_CONFIG_DIR を名乗っていない) 場合はスキップする
- **手順**: `<configDir>/sessions/<pid>.json` を走査して `sessionId` が一致する行から `pid` / `messagingSocketPath` を取り、`peerProtocol` が本 daemon の話す世代 (`PEER_PROTOCOL = 1`) と一致することを確認する。続けて同じ `sessions/` から `<pid>.<hex>.key` を探し `peerToken` を得る。両方揃って初めてソケットへ `auth` フレーム→ `user` フレームの順に書く
- **封筒**: DR-0027 §6 Addendum と同じタグ `<cross-session-message>` を使い、属性は `from="ccmsg"` `from-name="<表示名>"` `from-mode="prompting"` `ccmsg-mid="<room.id>m<mid>"` `ccmsg-from="user"` (User 発) または `ccmsg-from="<送信元 sid>"` (session 発)。本文の下に返信行を続ける:
  - archived な room: 返信行なし (`No reply needed` と同じ扱い)
  - 1on1 room で User 発の msg: 「通常の応答で返してよい」という指示文 (`computeReplyVia` の `Reply in your normal assistant response` をそのまま文にする)
  - それ以外: `Reply with: <launcher> reply <room.id>m<mid> <text>` (`<launcher>` は `resolveLauncher()` が解決する、この daemon が動くツリーの `bin/ccmsg` 絶対パス。無ければ `ccmsg` の裸名)
- **成否の扱い**: 注入と subscribe 配信は完全に独立した経路として並行に走らせる。注入の成否は待たず、結果は `daemon.log` に `peer-inject <mid> -> <sid>: <outcome>` として記録するのみで、呼び出し元の処理やレスポンスには一切影響しない (`outcome` は `delivered` / `unavailable` / `refused`)
- **期限値**: ソケット接続とフレーム書き込みの flush 完了まで 2 秒 (`INJECT_WRITE_MS`)。受け手が拒否 (`peer_message_status` で `refused`/`denied`/`dropped`/`expired`/`held`) を返してくるかを待つ猶予は 250ms (`INJECT_STATUS_MS`)。`sessions/` ディレクトリの走査 (`readdir` + 各 JSON の読み取り) 全体に 1 秒 (`INJECT_SCAN_MS`)。いずれも超過は `unavailable` 扱いで、待たずに次の処理へ進む
- **config dir の限定**: 注入先は、そのセッションが hello 等で daemon に自己申告した `configDir` を持つ member に限る。daemon が推測で config dir を組み立てることはしない

## 3. Alternatives Considered

- 案 a: subscribe を Monitor の別モードで常駐させ続ける
  - 不採用理由: Monitor tool から `persistent` が無くなった前提条件そのものが崩れている。受け手側で常駐させる仕組みを daemon 外に作る余地もあるが、それは受け手ごとの追加セットアップを要求し「常駐を要求しない配送」という目的に反する
- 案 b: 単体 ccmsg (別リポ) の CLI を daemon から子プロセスとして呼び出す
  - 不採用理由: 単体 ccmsg の mid 体系・封筒生成ロジックは別リポの内部実装であり、daemon 側の room / msg モデル (`room.id` + `ev.mid`、`computeReplyVia` の分岐) と食い違うと返信が繋がらない。daemon が持つ room 文脈をそのまま封筒に落とせる自前実装のほうが、返信経路 (`ccmsg reply`) との整合を機械的に保証できる

## 4. Consequences

- 受け手が一度も CLAUDE_CONFIG_DIR を daemon に申告していない場合 (= `sessions/*.json` の手掛かりが daemon に無い場合) は、従来どおり subscribe 配信のみに頼ることになる
- 注入と subscribe 配信は独立した経路なので、両方が同じ msg を届ける (受け手が両方の口を持つ場合) ことがあり得る。順序の保証もない
- 注入の成否は log にしか残らないため、届かなかったことを daemon 側から利用者に能動的に知らせる仕組みは無い (受け手からの明示的な拒否のみ 250ms 以内に拾える)
- webui 側の表示は本 DR の対象外。DR-0027 §6 の封筒表示ロジックがそのまま使われる
