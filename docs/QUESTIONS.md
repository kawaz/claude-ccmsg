# 裁定・確認待ち一覧 (ユーザ用)

## 運用規約

<details>
<summary>ゼロコンテキストエージェント向け（本セクションは消さない）</summary>

- 裁定/確認待ち項目を 1項目=1ラベル=1セクション で記載
- ラベル形式: XX-Q1（バッチやセッション内で一意な短プレフィクス、Qn単独の使い回し禁止、長期一意性は不要)
- 依頼形式: 「👺XX-Q1 の裁定お願いします」（参照用途ではラベルに👺を付けない。誤陽性がユーザのハイライト/アラームを汚す）
- チャット提示と同一ターンで本ファイルに記録 + path 指定 commit (push はリリース窓に同乗)
- 裁定が下りたら該当セクションを即削除し、内容は正規の記録先 (DR / issue / journal / close_reason) へ反映。本ファイルは常に「現在待ち」だけを持つ
- 確認系 (C) も滞留させない: チェックが揃った項目・セクションは即削除、放置が続く低リスク項目は登録ごと落とす (kawaz)
- 参照は[]()で提示（リポ内は相対、リポ外はフルパス）
- 初版質問/依頼は長文で書かない（ユーザが説明を求めらたら本ファイルに説明を追加し、チャットで👺ラベルで再依頼）
- **選択肢・確認項目は `- [ ] a: …` 形式（チェックボックス + ラベル）で書く**。Q / C で記法を分けない。回答は「チェックを付ける」でも「XX-Q1a」と言葉で返すでも通る（複数まとめてチェックし「チェックしたよ」の一言で済ませる運用を想定）

</details>

## 裁定待ち

### HP-Q1: セッションの一覧のモデルに足す欄の形

[issue peer-model-workspace-vcs-repo](./issue/2026-11-11-peer-model-workspace-vcs-repo.md) の 1 段目 (`ws` と `repo` を残したまま足す) で足す欄の形。足すこと自体と 2 段の進め方は裁定済み (kawaz 2026-11-11)。

1 段目は統括の推し (αa / βa / γa) の形で v0.246.0 に実装済み (`ccmsg peers` の出力で見られる。決まりは [DR-0003](./decisions/DR-0003-wire-protocol.md) §3)。違う形がよければ、2 段目 (`ws` / `repo` を消す) の前に直す。2 段目はこの裁定の後に着手する。

α: VCS の情報の置き方

- [ ] a: `vcs: { type, workspace?, branch?, remotes: [{ name, url }] }` に 1 つにまとめる (統括の推し。`repository: { … }` と同じ流儀で、VCS の下に居ないセッションは `vcs` ごと無い、と言える)
- [ ] b: `vcs_type` / `vcs_remotes` / `workspace` を並べる (kawaz の最初の書き方。今の `branch` / `repo_root` と同じ平らな並び)

β: `repository` に host を入れるか

- [ ] a: 入れる (`{ host, owner, name, url }`。統括の推し。forge ごとに違うもの、例えば `#123` のリンクの作り方を host で分けられる。今は GitHub 決め打ち)
- [ ] b: 入れない (`{ owner, name, url }`。host は `url` から読める)

γ: owner が多段の時 (GitLab の `group/sub/demo`) の分け方

- [ ] a: 最後の 1 段を `name`、それより前を `owner` (`owner: "group/sub"`, `name: "demo"`。統括の推し)
- [ ] b: 最初の 1 段を `owner`、残りを `name`

### HP-Q2: 「! で実行」の結果に成否を出すか

[DR-0040](./decisions/DR-0040-permit-request-tool.md) §11 は「成功か失敗かは出さない」と決めている (bash mode の行が終了コードを持たないため)。Claude Code 2.1.322 では、出力のある `!` のコマンドは、終了コードが 0 なら出力が全部 `<bash-stdout>` に、0 以外なら全部 `<bash-stderr>` に入っていた (5 例。[findings](./findings/2026-11-11-permit-bang-multiline.md))。出力が空のコマンド (`false` 等) は今も見分けられない。

- [ ] a: 今のまま出さない (統括の推し。出力が空の失敗を見分けられないので、出せるのは「出力があった時だけ」の半端な印になる。観測も 5 例で、Claude Code の決まりとして書かれたものではない)
- [ ] b: 出力がある時だけ成否の印を出す

### HP-Q3: テストの期限をどちらに揃えるか

[issue bun-preload-default-timeout-first-file-only](./issue/2026-11-02-bun-preload-default-timeout-first-file-only.md): テスト共通の初期化 (bunfig.toml の preload) が期限を 15 秒にしているが、効くのは最初に走るテストファイルだけで、2 番目以降は bun の既定の 5 秒で走っている。

- [ ] a: 全ファイルに 15 秒を効かせる (統括の推し。初期化のコメント「全テストで同じ期限」に合わせる。今 5 秒で走っているテストの期限が緩む)
- [ ] b: 5 秒を正として、初期化の期限の指定とコメントを消す

### TR-Q1: module の無いセッションの外部ファイルの読み出しをどう守るか (セキュリティ)

[issue fs-read-external-symlink-swap-without-module](./issue/2026-10-28-fs-read-external-symlink-swap-without-module.md): module の無いセッション (閉じたセッション等) では、`fs_read_external` が要求のたびに transcript を走査して許可リストを作り直す。許可されたパスの先祖が後から symlink に差し替わると、差し替え先が読める。live のセッションは最初に固めた許可リストを使うので起きない。実際に攻撃が再現するかは未検証。

- [ ] a: 走査で得た許可リストを、最初に実パスへ直した時の形でセッションごとに覚える (統括の推し。閉じたセッションの履歴から外部ファイルを開く機能を保てる。ただし「最初」は daemon がその transcript を初めて読んだ時で、それより前の差し替えは防げない)
- [ ] b: module の無いセッションでは `fs_read_external` を断る (単純で穴が残らない。閉じたセッションの履歴から外部ファイルを開けなくなる)

### TR-Q2: 🔔🔐 の赤い数の 99+ をどうするか

99+ の枠 (約 23px) は絵文字の絵の幅 (Chromium 15.5px、WebKit 19.5px) より広い。v0.260.0 で枠の右端を絵に合わせたので、Sessions の行では 99+ が絵をほぼ覆い、隣のバッジに約 3px かかる ([findings](./findings/2026-11-12-count-badge-counter-inside-emoji.md))。[DR-0050](./decisions/DR-0050-timeline-notification-badges.md) §9 の U14 は「100 以上は 99+」。

- [ ] a: 今のまま (未読が 100 以上の時だけの見た目として受け入れる)
- [ ] b: 上限を 9+ にする (統括の推し。2 文字なので 12 と同じ幅で絵に収まる。10〜99 の区別が消える。U14 を変える)
- [ ] c: 3 桁の時だけ字を詰める (99+ のまま。3〜7px 削るので読みにくくなるおそれ)

### TR-Q3: tool が 1 件だけの時に直接見せた中身を、2 件目が来た時にどうするか

[issue single-tool-fold-remounts-when-second-arrives](./issue/2026-11-11-single-tool-fold-remounts-when-second-arrives.md): 1 件の時は直接見せ、2 件目が来ると fold に包み直すので、要素が作り直されて一時状態 (開いた details、スクロール位置) が消え、読んでいる最中に畳まれる。閉じた fold は中身を描かないので、「要素を保つ」と「2 件目で畳む」は両立しない。

- [ ] a: 1 件目が見えていた group は、2 件目が来ても開いたままにする (統括の推し。一時状態が残り、読んでいる最中に畳まれない。長い turn で TL が縦に長くなる)
- [ ] b: 今どおり畳む (一時状態は失われる。決まりとして明記して close)
- [ ] c: 1 件の時も最初から fold にする (「1 件なら直接見せる」をやめる)

### TR-Q4: daemon の再起動直後の transcript の読み直しで、どの刻みで譲るか

[issue catch-up-refold-holds-event-loop](./issue/2026-11-12-catch-up-refold-holds-event-loop.md): 読み直しは 4MB ごとに 1 回だけ event loop に譲るので、その間 100ms 以上ほかの op が待つ。

- [ ] a: 譲る刻みを時間にする (例: 8ms ごと。統括の推し。塞がりの上限が刻みで決まる。読み直しの総時間は少し伸びる。[DR-0029](./decisions/DR-0029-async-io-principle.md) の「長い走査は譲る」の基準をバイトから時間に書き換える)
- [ ] b: 同時に走る読み直しの数を絞る (1 本あたりの塞がりは変わらない。live になるのが遅れるセッションが出る)
- [ ] c: 両方

### TR-Q5: HTTP を配る daemon の起動直後の webui の準備をどうするか

[issue http-daemon-webui-prepare-holds-fs-pool](./issue/2026-11-12-http-daemon-webui-prepare-holds-fs-pool.md): 本番の daemon は起動直後に webui の bundle と圧縮 (brotli の最高品質で約 1.7 秒) を始め、その間は非同期のファイル操作が 1 秒前後待つ。

- [ ] a: brotli を後回しにする (統括の推し。最初は gzip だけで配り、brotli は出来たら切り替える。最小の変更で待ちの大半を消せる見込み)
- [ ] b: 準備を最初の HTTP の要求まで遅らせる (起動は軽くなる。最初のページの読み込みが数秒待つ)
- [ ] c: 準備を別の process に出す (待ちは消える。成果物の受け渡しと process の管理が増える)
- [ ] d: bundle と圧縮をリリースの時に済ませて配布物に入れる (実行時に build しない。配布の形を変える大きな変更。TR-Q6 の配布物の大きさとも関わる)

### TR-Q6: plugin キャッシュに溜まった旧版をどうするか

[issue plugin-cache-old-versions-accumulate](./issue/2026-11-12-plugin-cache-old-versions-accumulate.md): `plugins/cache/ccmsg-v1` に 83 版・13.3GB (personal)。旧版 82 個には Claude Code の印 `.orphaned_at` が付いているが、13 日経っても消えていない。他の plugin は 1〜2 版しか残っていない。なぜ ccmsg-v1 だけ消えないかは未特定。

- [ ] a: 使用中でない旧版を今 kawaz の判断で手動で消し、消えない理由の切り分け (使用中でない orphaned の版がいつ消えるかの観測) を続ける (統括の推し)
- [ ] b: 消さずに切り分けだけ続ける
- [ ] c: ccmsg の側で配布物を小さくする検討を先にする (1 版 約 150MB のうち node_modules が 145MB。TR-Q5 の d と一緒に)

## 確認待ち

### TR-C1: iPhone / iPad の実機の Safari での見え方と動き

headless の WebKit では確かめたが、実機では未確認のもの。

- [ ] a: TL のツールバーが 1 段に収まり、⤒ ⤓ が右端にある (v0.261.0)
- [ ] b: 🔔🔐 の赤い数が絵の内側の右下にある (v0.260.0)
- [ ] c: 起動 / 再起動の dialog が崩れない (v0.254.0。手元で再現しなかった修正)
- [ ] d: シークレットの受け口で、打鍵を受けない状態でも貼り付けのメニューが出て貼れる、貼った後にキーボードが閉じる、伏せ字になる、IME の確定の Enter で送信されない (v0.256.0。[issue secret-handoff-to-session](./issue/2026-11-12-secret-handoff-to-session.md) はこの確認だけが残り)
- [ ] e: Terminal タブで FAB が出ない (v0.254.0)
