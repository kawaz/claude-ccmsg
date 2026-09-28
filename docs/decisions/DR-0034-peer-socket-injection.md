# DR-0034: v1 daemon による room msg の peer messaging socket 直接注入

Status: Accepted / 実装済 (2026-09-28)
Date: 2026-09-28
関連: [DR-0027](./DR-0027-tl-ccmsg-canonical-lookup.md) §6 Addendum 2026-09-26 (単体 ccmsg 経由の受信封筒仕様、本 DR が同じ封筒形を daemon 自身の配送にも適用する)、[DR-0017](./DR-0017-reply-command.md) (`ccmsg reply` と `reply_via`)、`docs/journal/2026-09-26-direct-delivery-migration.md`

## 1. 背景

Claude Code の Monitor tool から `persistent` オプションが無くなり、`ccmsg subscribe` を Monitor で常駐させて受け手に配送する経路が使えなくなった。単体の ccmsg (別リポ) は Claude Code の peer messaging socket へ直接書き込む経路に切り替え済みだが (DR-0027 §6 Addendum)、v1 daemon 自身の room 配送は subscribe 配信のみに依存したままだった。subscribe 配信は受け手のプロセス常駐を要求するため、常駐が無い受け手には room の msg が届かない。

Claude Code は非公式プロトコルとして `<config home>/sessions/<pid>.json` (`sessionId` / `pid` / `messagingSocketPath` / `peerProtocol`) と、同じディレクトリの `<pid>.<hex>.key` (`peerToken`) による peer messaging を持つ。これに newline-delimited JSON で `auth` フレームと `user` フレームを送ると、受け手のプロセスが常駐していなくても transcript に直接メッセージが載る。実機は Claude Code 2.1.263 / 2.1.282 で確認済み。

## 2. 決定

daemon が room の msg イベントを配送するとき (`deliver` / `deliverNewRoom`)、room の member セッションそれぞれへ peer messaging socket 経由で注入する (`packages/daemon/src/peer-inject.ts` の `PeerInjector`)。セッションへの msg の配送経路はこの注入だけで、session role の subscribe stream には msg イベントを流さない (ライブ配信・cursor replay・recent-replay・自投稿の echo・新 room の snapshot のいずれも)。subscribe の msg イベントは user role の購読者 (webui) にのみ配信する。

- **対象**: msg イベントのみ。member のうち投稿者本人以外、かつ `to` で絞られていれば絞り込み後の宛先。`daemon.sessions` にその sid の `configDir` が無い (= セッションが一度も CLAUDE_CONFIG_DIR を名乗っていない) 場合はスキップする
- **手順**: `<configDir>/sessions/<pid>.json` を走査して `sessionId` が一致する行から `pid` / `messagingSocketPath` を取り、`peerProtocol` が本 daemon の話す世代 (`PEER_PROTOCOL = 1`) と一致することを確認する。続けて同じ `sessions/` から `<pid>.<hex>.key` を探し `peerToken` を得る。両方揃って初めてソケットへ `auth` フレーム→ `user` フレームの順に書く
- **封筒**: DR-0027 §6 Addendum と同じタグ `<cross-session-message>` を使い、属性は `from="ccmsg"` `from-name="<表示名>"` `from-mode="prompting"` `ccmsg-mid="<room.id>m<mid>"` `ccmsg-from="user"` (User 発) または `ccmsg-from="<送信元 sid>"` (session 発)。本文の下に返信行を続ける:
  - archived な room: 返信行なし (`No reply needed` と同じ扱い)
  - 1on1 room で User 発の msg: 「通常の応答で返してよい」という指示文 (`computeReplyVia` の `Reply in your normal assistant response` をそのまま文にする)
  - それ以外: `Reply with: <launcher> reply <room.id>m<mid> <text>` (`<launcher>` は `resolveLauncher()` が解決する、この daemon が動くツリーの `bin/ccmsg` 絶対パス。無ければ `ccmsg` の裸名)
- **成否の扱い**: 注入の成否は待たず、結果は `daemon.log` に `peer-inject <mid> -> <sid>: <outcome>` として記録するのみで、呼び出し元の処理やレスポンスには一切影響しない (`outcome` は `delivered` / `unavailable` / `refused`)
- **期限値**: ソケット接続とフレーム書き込みの flush 完了まで 2 秒 (`INJECT_WRITE_MS`)。受け手が拒否 (`peer_message_status` で `refused`/`denied`/`dropped`/`expired`/`held`) を返してくるかを待つ猶予は 250ms (`INJECT_STATUS_MS`)。`sessions/` ディレクトリの走査 (`readdir` + 各 JSON の読み取り) 全体に 1 秒 (`INJECT_SCAN_MS`)。いずれも超過は `unavailable` 扱いで、待たずに次の処理へ進む
- **config dir の限定**: 注入先は、daemon が `configDir` を知っている member に限る。`configDir` の出どころは、セッションが hello で自己申告した値か、そのセッションを列挙した harness の登録簿の config dir (§5) のどちらか。daemon が推測で config dir を組み立てることはしない

## 3. Alternatives Considered

- 案 a: subscribe を Monitor の別モードで常駐させ続ける
  - 不採用理由: Monitor tool から `persistent` が無くなった前提条件そのものが崩れている。受け手側で常駐させる仕組みを daemon 外に作る余地もあるが、それは受け手ごとの追加セットアップを要求し「常駐を要求しない配送」という目的に反する
- 案 b: 単体 ccmsg (別リポ) の CLI を daemon から子プロセスとして呼び出す
  - 不採用理由: 単体 ccmsg の mid 体系・封筒生成ロジックは別リポの内部実装であり、daemon 側の room / msg モデル (`room.id` + `ev.mid`、`computeReplyVia` の分岐) と食い違うと返信が繋がらない。daemon が持つ room 文脈をそのまま封筒に落とせる自前実装のほうが、返信経路 (`ccmsg reply`) との整合を機械的に保証できる

## 4. Consequences

- daemon が受け手の config dir を知らない場合 (hello で申告しておらず、harness の登録簿にも載っていない場合) は、msg がそのセッションに届かない
- `reply_via` / `msg_via` / `echo` といった subscribe の msg フレーム専用の付加情報は無い。返信方法は封筒の返信行が伝える
- 注入の成否は log にしか残らないため、届かなかったことを daemon 側から利用者に能動的に知らせる仕組みは無い (受け手からの明示的な拒否のみ 250ms 以内に拾える)
- webui 側の表示は本 DR の対象外。DR-0027 §6 の封筒表示ロジックがそのまま使われる

## 5. セッションの登録は harness の登録簿から導出する

注入の宛先は daemon の session registry (`daemon.sessions`) にあるセッションである。この registry を、セッションが v1 CLI で hello したかどうかではなく、harness 自身の登録簿から導出する。既に起動しているセッションは、ccmsg を一度も実行していなくても生きているものとして扱う。

- **登録簿**: 検出した全 config dir (`$HOME/.claude*` のディレクトリ) それぞれで `claude agents --json` を実行した結果を合わせたもの (`packages/daemon/src/agents.ts`)。間隔は 5 秒で、daemon の起動から停止まで常時回す
- **登録**: 登録簿に載っていて registry に無い sid を登録する。cwd は realpath に正規化し、repo/ws は cwd から導出する (`repo-derive.ts`。cwd だけを名乗った hello と同じ扱い)。transcript は、その行を返した config dir の `projects/` から `<sid>.jsonl` を引けた時だけ持たせる。`configDir` はその行を返した config dir とする。登録時に transcript が無かったセッション (まだ何も入力されていない等) は、以後のポーリングのたびに同じ引き方で再解決し、見つかった時点で transcript を持たせて peers を push する。broadcast room への自動 join (DR-0013 §2.2) は hello による登録と同じく行う。`state` が `done` の行は終わったセッションなので登録しない
- **hello との関係**: 既に registry にある sid は登録簿の値で上書きしない。hello はセッション自身が名乗るもので、行よりも詳しい (branch、repo_root、申告された transcript)。登録簿で登録した後に届いた hello は、通常どおり registry を更新する
- **忘却**: 登録簿に載ったことのある sid が、その sid を列挙した config dir の回答から消えたら、セッションは終わったとみなして registry から外す (`forgetSession`。broadcast room に leave が書かれる)。その回の `claude agents --json` が失敗した config dir は何も言っていないので、その config dir のセッションは外さない。登録簿に一度も載ったことのない sid (codex などの harness 外の peer、テスト用クライアント) は、登録簿の変化では外さない
- **常時ポーリングにする理由**: room member への注入 (§2) と 1on1 room の作成は、registry にセッションが居ることを前提にする。これは webui の有無に関係なく成り立つ必要がある。webui が居る間だけ回すと、webui が居ない間に起動したセッションには webui を開くまで msg が届かない。`claude agents --json` の実行費用 (config dir の数 × 5 秒ごと) は、配送が成り立つことに比べて小さい
- **テスト**: テストが起こす daemon は `CCMSG_AGENTS_POLL=off` でポーリングを止める (`bunfig.toml` の preload がテストプロセス全体に既定値として入れる)。止めないと開発機で実際に動いているセッションがテストの registry に登録される。ポーリング自体を検証するテストは、偽の `$HOME` と偽の `claude` を用意して `on` に戻す

この導出により、daemon が再起動しても、生きているセッションは次のポーリングで registry に戻る。再起動前に稼働していたセッションを daemon 側で別に記録して見せる必要は無い。
