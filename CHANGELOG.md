# Changelog

claude-ccmsg の版ごとの変更点。新しい版が上。[Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) に倣い、1 版を数行の箇条書きにする。版の見出しは `## v<版> <a id="v<版>"></a>` の形で、その下の 1 行目に日付を書く。web UI の版の表示はこのアンカー (`#v<版>`) へのリンクになっている。最も下の節より前の版は載せていないので、git の履歴の `Release v<版>` の commit を見る。

## v0.255.0 <a id="v0.255.0"></a>

2026-11-12

- シークレットを貼り付けた結果を、起動の結果と同じ知らせの枠で出す (「送信成功」「送信した (未確認)」「送れなかった」)。預かり中の一覧と破棄のボタンは無くした (値は最長 5 分で消える)
- シークレットの受け口は、貼り付けを受けたら focus を外す (タッチの端末でキーボードが出たままにならない)

## v0.254.0 <a id="v0.254.0"></a>

2026-11-12

- Terminal タブを開いている間は、右下の入力欄 (FAB) を出さない。別のタブに戻ると、書きかけの文・添付・開閉・動かした位置はそのまま出る
- 起動 / 再起動などの dialog の本文が、iPad の Safari で 0 の高さに潰れて見えなくなることがあったのを直す (dialog の本文を中身の高さから始めるようにした。iPad の実機での確認はこれから)

## v0.253.0 <a id="v0.253.0"></a>

2026-11-12

- Status タブに「シークレットを渡す」を足した。受け口に貼り付けた値を daemon が 5 分メモリに預かり、そのセッションに `ccmsg secret take <ID> | <コマンド>` で取り出せることを知らせる。値は会話・ログ・ディスク・クリップボードに残らない。預かり中の物は残り時間と破棄のボタン付きで出る
- HTTP を配らない daemon (テストの daemon 等) は、webui の bundle と圧縮をしない。HTTP を配る daemon は、listener が立った時に始める

## v0.252.0 <a id="v0.252.0"></a>

2026-11-12

- daemon の再起動の直後、transcript の場所を名乗らないセッションの hello が 0.5 秒以上かかることがあったのを直した。transcript を探す時に、名乗られた config dir を先に見て、project のディレクトリを 1 つずつ待たずに同時に調べる

## v0.251.0 <a id="v0.251.0"></a>

2026-11-11

- 遅い hello の warn に、所在の導出の読み込み 1 つずつの所要と、その間の timer の遅れを足した

## v0.250.0 <a id="v0.250.0"></a>

2026-11-11

- セッションの hello の処理に 500ms 以上かかった時、daemon.log に warn で内訳 (transcript の探索、cwd、repo root、所在の導出) を出す

## v0.249.0 <a id="v0.249.0"></a>

2026-11-11

- send が相手のセッションの記録を読めなかった (壊れている、開けない) 時も、daemon.log にどのファイルがなぜ読めなかったかを出す
- macOS の CI で確率的に落ちる send のテストに、落ちた理由を CI の log に残す出力を足した (テストだけ)

## v0.248.0 <a id="v0.248.0"></a>

2026-11-11

- 🔐 のフィルタ画面の「TL に移動」を、各依頼の下の横幅いっぱいのバーから、バブルの中のボタンの行 (「既読」の左) の普通のボタンにした。押した時の動きは同じ
- Timeline の末尾に出ている worker の say (とフィルタ中の読み込み範囲の外の say / 許可依頼) が、新しい行が来ると作り直されて、開いた状態などが消えていたのを直した
- send が相手のセッションの記録を期限内に読めなかった時、daemon.log にどのディレクトリを何件まで読めたかを出す (届かなかった理由が「セッションが無い」と見分けられなかった)

## v0.247.0 <a id="v0.247.0"></a>

2026-11-11

- Timeline の 🔔 / 🔐 のフィルタを末尾で開いて「TL に戻る」を押すと、末尾でなく上の方に残ることがあったのを直した。TL の下のミニパネルが後から現れると末尾から 3〜4px ずれ、末尾を見ていたと扱われていなかった。寄せた位置は、スクロール領域の中のどれが後から伸びても保つ
- `bun test` を起こしたプロセスが先に終わる形 (バックグラウンドで起こした時など) で、daemon のテスト 5 件が落ちていたのを直した (テストだけ)

## v0.246.0 <a id="v0.246.0"></a>

2026-11-11

- エージェントが使う tool の `send` は宛先を `session_id` だけで受け、`peers` は `cwd_prefix` だけで絞る。`send` の `cwd` / `name` / `pid` と `peers` の `name` は、何もせずに断る。`peers` の出力の各行は `session_id` / `name` / `cwd` で、pid の表示は無くした
- Timeline の 🔐 のフィルタ画面で、各許可依頼のバブルの下に「TL に移動」を置いた。押すとフィルタを外し、その依頼が一番上に来る位置で TL に戻る。読み込み済みの範囲の外の依頼は、見つかるまで過去分を読み込んでから移る
- `ccmsg peers` (と webui が受けるセッションの一覧) の各セッションに、名前 (`name`)、VCS の種類・workspace・branch・remote の一覧 (`vcs`)、リポの host / owner / name / url (`repository`) を足した。remote の URL からは認証情報を落とす。`ws` / `repo` はそのまま
- macOS で `ccmsg agents` のテストが子プロセスの起動ごとに秒の桁で遅く、GitHub Actions の macOS で落ち続けていたのを直した (テストが子に渡す偽の HOME が autofs の下だった)

## v0.245.0 <a id="v0.245.0"></a>

2026-11-11

- Status の「再起動」「終了」と ENV の読み出しが、実行ファイルのパスに空白のある claude (デスクトップアプリから起動されたセッション) で「プロセスが無い」と断られていたのを直した
- 断られた時の文を、pid が引けない時と、その pid が claude のプロセスと確かめられなかった時で言い分ける。終了ボタンも、決まった文でなく daemon の文を出す
- Status のセッション情報に ENTRYPOINT (何から起動されたか。`cli` / `claude-desktop` / `claude-vscode`) の行を足した

## v0.244.0 <a id="v0.244.0"></a>

2026-11-11

- Timeline の 🔔 / 🔐 のフィルタ中は、最上部の「過去分を上に読み込む」「過去分を下に読み込む」を出さないようにした (フィルタは全部の say / 許可依頼を並べるので、過去分を読んでも並ぶものは変わらない)。フィルタを外すと出る

## v0.243.0 <a id="v0.243.0"></a>

2026-11-11

- 許可依頼の「! で実行」を複数行のコマンドにも出すようにした。コマンドは書き換えずに送り、全文が 1 つのコマンドとして実行される。改行が CRLF のコマンドでも「実行済み」に切り替わる
- フィルタ画面の「全て既読」は、既読にする未読がある間だけ出す (未読が無い時は出さない)

## v0.242.0 <a id="v0.242.0"></a>

2026-11-11

- フィルタ画面の「全て既読」を横幅いっぱいでなく普通のボタンにした (幅は文字の分、バブルと同じ左端)。未読が無くて押せない間は「全て既読済み」と出る
- agent の transcript と workflow の掘り下げが読む範囲の検査を直した。途中のディレクトリが symlink でセッションのディレクトリの外を指していると、外のファイルを読めていた
- Timeline の 🤖 カードの名前のリンクが、workflow を一時停止して再開すると消えていたのを直した
- agent tree で、題の無い phase があると workflow の member が別の phase に入っていたのを直した
- DR-0025 (workflow / subagent / teammate の掘り下げ) を今の実装に合わせて書き直した

## v0.241.0 <a id="v0.241.0"></a>

2026-11-11

- Timeline の 🔔 / 🔐 のフィルタ画面で、最後のバブルの下 (「TL に戻る」の上) に「全て既読」を置いた。そのフィルタに出ている未読を全部既読にする (読み込み範囲の外のものと worker の say も含む。🔐 は許可はしない)。未読が無い時は押せない
- say のバブルの「N 件すべて既読」を無くした。バブルのボタンは常に「既読」で、その 1 件だけを既読にする

## v0.240.0 <a id="v0.240.0"></a>

2026-11-11

- Timeline の「過去分を読み込む」を左右 2 つのボタンにした。「↑過去分を上に読み込む↑」は今どおり先頭の項目の画面上の位置を保ち、「↓過去分を下に読み込む↓」は読み込んだ過去分がボタンのすぐ下から始まるよう、最上部へスクロールする

## v0.239.0 <a id="v0.239.0"></a>

2026-11-11

- Status の「新セッションを起動」「再起動」の dialog のフォームを FAB (composer) と同じ部品で作り直した。入力欄のすぐ下の行に [デフォルトに保存]、model / effort の選択 (FAB と同じ部品)、送信を置く。FAB と取り違えないよう、枠と送信ボタンを緑系にした
- 再起動でも model / effort を選べるようにした。初期値は元のセッションと同じ値。`session_restart` に任意の `model` / `effort` を足した
- model / effort の選択の「default」のグループを「in effect」(いま効いている値) に改名した
- FAB の「入力先」の文字ラベルを消した (読み上げ用の名前は残す)

## v0.238.0 <a id="v0.238.0"></a>

2026-11-11

- Timeline の jsonl 表示で、行の位置を常に raw / pretty のタブの横に `L<行番号> @<byte offset>-<bytes> byte` で出すようにした。tool の呼び出しと結果の 2 行を持つ項目は 2 つ並べる。行番号が分からない時 (ファイルの先頭まで読み込んでいない時) は `L?`

## v0.237.0 <a id="v0.237.0"></a>

2026-11-11

- Timeline の jsonl ボタンで、fold の見出し (`▼ mode` 等) を残したまま中身だけ元の行に替えるようにした。戻すと開いていた fold は開いたまま。吹き出しは丸ごと元の行に替わる

## v0.236.0 <a id="v0.236.0"></a>

2026-11-11

- Timeline の「N items」の中は項目どうしを詰め、開いた項目の下にだけ空きを取るようにした。開け閉めで押した行が上下に動かない
- Timeline の jsonl 表示の左の欄を外し、行の位置を `L<行番号> @<byte offset> · <N> bytes` で raw / pretty のタブの横に出す (tool の呼び出しと結果の 2 行を持つ項目は各行の上)。行番号はファイルの先頭まで読み込んでいて分かる時だけ出す

## v0.235.0 <a id="v0.235.0"></a>

2026-11-11

- Timeline の「N items」の fold を開いた中で、閉じた行どうしの間隔を詰めた。開いた項目と fold でない項目の上下の間隔は今までどおり
- Timeline の閉じた項目には jsonl ボタンを出さないようにした (右端を触った時に押してしまうため)。項目を開くと出る

## v0.234.0 <a id="v0.234.0"></a>

2026-11-11

- Status タブの計器の箱で、CONTEXT のバーを LIVE / MODEL / EFFORT の下に移した
- セッション情報の表を CWD / REPOSITORY / NAME の順にした。REPOSITORY はリポジトリのページの URL をそのまま出し、そこへのリンクにする (GitHub / GitLab / Bitbucket 等を問わない。URL の認証情報は出さない)。daemon がセッションの cwd の remote から求め、peers の `repo_url` に載せる

## v0.233.0 <a id="v0.233.0"></a>

2026-11-11

- `send` の `agent_id` 付きの送信が、相手の agent が待機中でも終わっていても届く (待機中の teammate は起き、終わった subagent は再開する)。届け方を `$.session.append` から `$.session.send` に替えた。受け手にはその agent の親からの文に見え、本文の頭の `ccmsg:<送り主> から:` が本当の送り主を示す。protocol 2.4
- subagent が呼んだ `launch` の結果の知らせも同じ届け方になった (結果が出る前に turn を終えた subagent は、再開して読む)
- 届かなかった理由 `not_running` を `no_agent` (そのセッションにその agent_id の agent が居ない) に替えた
- webui から走行中の subagent への入力は `append` のまま (待機中の agent には届かない)

## v0.232.8 <a id="v0.232.8"></a>

2026-11-10

- markdown のリンク `[x](docs/q.md#3344-Q3)` の `#3344-Q3` がリンク先の URL に残る (これまで行の範囲 `#L10` 以外は捨てていた)。Files のプレビューは、描いた後に URL の `#…` の場所へ移る
- Status タブ: 行の右端のボタン (起動 / 再起動 / 終了) を同じ幅にし、文言の末尾の「…」を無くした
- Status タブ: ENV の見出しの行 (「名前」「値」) を無くした。件数は検索で絞れている間だけ「N 件中 M 件」と出し、pid は出さない。PID を SESSION_ID の下に移した

## v0.232.7 <a id="v0.232.7"></a>

2026-11-10

- Files の markdown プレビュー: `<a id="…"></a>` / `<a name="…"></a>` をタグの文字として出さず、その id を持つ場所にした (`…#<id>` で飛べる。見出しに書いても目次には出ない)

## v0.232.6 <a id="v0.232.6"></a>

2026-11-10

- Status タブ: NAME から ENV までを「セッション情報」の区画にした (セッション操作・危険ゾーンと同じ見出し)。ENV の上の横線を無くした
- Status タブ: `TITLE` を `NAME` にして表の先頭に置いた
- Status タブ: ENV を開いた中身を、見出し「ENV」の頭の字の位置から始まるように字下げした。ENV の各行の名前・コピー・値を行の高さの中央に揃えた。見出し「値」をコピーボタンの上から始めた (ボタンが見出しの無い別の列に見えていた)

## v0.232.5 <a id="v0.232.5"></a>

2026-11-10

- Status タブ: CONTEXT の目盛りの右の model / effort の文字を無くした (すぐ下の MODEL / EFFORT と同じ内容だった)
- Status タブ: LIVE / MODEL / EFFORT の名前と値の高さを揃えた (EFFORT だけ上にずれていた)

## v0.232.4 <a id="v0.232.4"></a>

2026-11-10

- Timeline の「過去分を読み込む」を、フィルタ中の「TL に戻る」と同じ見た目 (横幅いっぱいの控えめなボタン) にした

## v0.232.3 <a id="v0.232.3"></a>

2026-11-10

- Timeline 下の状態行の model / effort を Status タブの MODEL / EFFORT と同じ表示にした (上書き中は `📌low` / `⏱️high`)。状態行だけの `⁺`・黄色・hover の説明を無くした
- Status タブの MODEL を、起動時の別名 (`fable[1m]`) でなく応答した model の ID (`fable-5-2[1m]`) で出す。状態行の model と同じ文字
- サイドバーの GLOBALS の開閉を窓ごとに覚える (sessionStorage)

## v0.232.2 <a id="v0.232.2"></a>

2026-11-10

- Status タブ: 「新セッションを起動」「再起動」は行のどこを押しても開く (「セッションを終了」はボタンだけ)
- Status タブ: 「再起動しました」は 5 秒で消える。resume しなかった結果は残る

## v0.232.1 <a id="v0.232.1"></a>

2026-11-10

- Status タブ: TITLE / CWD の表と識別子の表を 1 つの表にした (表の境目の隙間が無くなる)。並びは CWD / HYOUI_SESSION_ID / SESSION_ID / TITLE / CCMSG / KIND / STARTED / UPTIME / PID

## v0.232.0 <a id="v0.232.0"></a>

2026-11-10

- Status タブ: 計器のボックスを一番上に置き、中は CONTEXT を先頭にした (CONTEXT / LIVE / MODEL / EFFORT)
- Status タブ: CCMSG / KIND / STARTED / UPTIME にもコピーボタンを付けた。ENV は各行の値の左にコピーボタン (伏せ字の行も実値をコピー)、名前の列は最長の名前の幅に合わせて上限 30%
- タブの並びを Files / Timeline / Status / Terminal にした

## v0.231.1 <a id="v0.231.1"></a>

2026-11-10

- Timeline: `/compact` (と自動 compact) が残す要約の行 (`isCompactSummary`) をユーザの発話として出さず、`compact-summary` の fold にした

## v0.231.0 <a id="v0.231.0"></a>

2026-11-10

- Files の編集モードでも閲覧と同じ Shiki の色が付く (CSS Custom Highlight API、DR-0051)。太字 / 斜体だけは編集中に出ない
- 編集中の Tab は `\t` を入れる (フォーカスは移らない)。CRLF のファイルは CRLF のまま保存される

## v0.230.0 <a id="v0.230.0"></a>

2026-11-09

- Status タブを作り直した。上から TITLE / CWD、計器 (LIVE / MODEL / EFFORT / CONTEXT の meter)、識別子、ENV、セッション操作、危険ゾーン。Background / TODO の一覧は無くした (Timeline の agent tree とサイドバーのバッジが担う)
- 表の値は折り返さず横スクロール (行の高さが値の長さで変わらない)。ENV も同じ。コロン改行と値自身の改行は残る
- 起動 / 再起動は操作の一覧の行から modal dialog で開く。成功なら閉じて結果を一覧の下に残し、失敗なら開いたまま理由を出す。狭い幅では全画面

## v0.229.1 <a id="v0.229.1"></a>

2026-11-09

- Files の「触ったファイル」「お気に入り」の行から選んだ時 (URL に `?section=touched|favorites`) は、ワークスペースのツリーを展開・スクロールせず、選んだ節の行だけが選択状態になる

## v0.229.0 <a id="v0.229.0"></a>

2026-11-09

- Timeline の `older` ボタンをツールバーから外し、TL の最上部の左右中央に「過去分を読み込む」を置いた。押しても直下の行の画面内の位置が動かない
- 🔔 / 🔐 のフィルタ中は、最後のバブルの下に横幅いっぱいの「TL に戻る」が出る

## v0.228.1 <a id="v0.228.1"></a>

2026-11-09

- composer の宛先 select の選択肢は agent の名前だけ (引けなければ id)。type・説明・経過時間・「走っていない」の飾りを消した

## v0.228.0 <a id="v0.228.0"></a>

2026-11-09

- Files タブの「プロジェクト外」を「触ったファイル」にし、カレントプロジェクトのグループを先頭に足した (そのグループだけ Read 由来を除く)。グループの見出し行はワークスペースの folder 行と同じ部品・インデント (フォルダアイコン付き)
- session_status の `external_files` は `touched_files` になり、root 内のファイル (root 相対) も含む。`origin` は `read` / `edit` / `attachment`

## v0.227.1 <a id="v0.227.1"></a>

2026-11-09

- Status タブの TITLE は送信が成功した後も打った値を残す (旧名に一瞬戻らない)。セッションの名前が追従したらそれに合わせる

## v0.227.0 <a id="v0.227.0"></a>

2026-11-09

- Sessions 一覧からセッション名の編集 (✎ / Shift+クリック) と sid のコピーを削除
- Status タブの TITLE は最初から input。Enter で名前を変え、Escape で戻す。送信中は input が脈動し、失敗は危険色 (文は出さない)
- Status タブのコピーボタンを値の左に置いた。`CTX` を `CONTEXT` にし「上限は推定」を消した。`OVERRIDE` 行を `MODEL` / `EFFORT` の 2 行にした (押すと選べる)
- Status タブの subagent への入力を削除し、composer (FAB) のヘッダに宛先 select (main / 走行中の subagent) を置いた。Timeline が subagent を表示中はそれが既定

## v0.226.2 <a id="v0.226.2"></a>

2026-11-09

- Files タブのツリーはどのフォルダも閉じて始まる (cwd のフォルダの自動展開とルート一覧の先読みを無くした)。リンクで開いたファイルの祖先を開く reveal はそのまま
- フォルダを開くたびに一覧を取り直す (閉じて開き直しても古い一覧が残り、新しいファイルが見えなかった)

## v0.226.1 <a id="v0.226.1"></a>

2026-11-09

- ユーザー自身の prompt のバブルは、英語の段落があっても既定を ja(plamo) にしない (翻訳タブは出す。人が選んだ時だけ訳す)
- skill: `send` の `agent_id` を使う場面に「別のセッションから、引き継いだ worker に話しかける時」を追記

## v0.226.0 <a id="v0.226.0"></a>

2026-11-09

- Status タブの危険ゾーンの上に「新セッションを起動」と「再起動」の折りたたみを置いた。危険ゾーンは「セッションを終了」だけ
- 新セッションの起動はこのセッションと同じ cwd で、`--model` / `--effort` (初期値は今動いている値) と最初の prompt だけを送る
- 両フォームに「デフォルトに保存」を付けた。保存先はブラウザの localStorage、キーは cwd (次に開く時の初期値になる)

## v0.225.1 <a id="v0.225.1"></a>

2026-11-08

- permit の `voice` (読み上げる 1 文、日本語) を必須にした。依頼ごとに内容の分かる文を読ませ、既定の「許可を求めています」の連続を避ける
- `project_permissions` の rule が `Edit(~/…` / `Read(~/…` / `Write(~/…` なら断る (`~/` は permissions.allow では効かない。絶対パスで書く)。protocol 2.3

## v0.225.0 <a id="v0.225.0"></a>

2026-11-08

- 許可依頼のバブル: 依頼全体の「許可する」を右端に移し、その左に「既読」(許可せず 🔐 の対象から外す)。「許可する」は 未操作 / 既読 / 許可済み で見た目が変わる (許可済みは枠だけ、reload 後も残る)
- 「`!` で実行」は押すと「実行中…」になり、コマンドの行が届くと「実行済み」。成功 / エラーの表示は無し (bash mode の行に終了コードが載らない)。「実行済み」を押すと「`!` で実行」に戻せる
- `.claude/settings.local.json` の差分の知らせは固定の英文 1 文 + diff
- say / 許可依頼の既読・適用済みの状態はセッションごとに持ち、daemon の起動時に live でないセッションの分を捨てる。旧形式の状態と旧設計の `permit-requests.json` は捨てる

## v0.224.0 <a id="v0.224.0"></a>

2026-11-08

- 許可依頼の正本を transcript の permit の行にした (DR-0040)。daemon が持つのは既読と `project_permissions` の適用済みの状態 (`permit-state.json`) だけで、依頼の中身の永続化 (`permit-requests.json`) は無くした。過去の依頼も transcript にあるぶん全部出て、daemon の再起動と無関係。subagent の断られた呼び出しは出ない。`say_list` は `notification_list` (say と許可依頼を 1 回の読みで) に
- 設定ファイル (`.claude/settings.local.json`) の場所は依頼の行の cwd から決める
- 新しいセッションの peers の repo / ws / cwd が空になっていたのを直した (サイドカーが state file より先に名乗っていた。名乗るたびに読み直す)
- protocol 2.2

## v0.223.1 <a id="v0.223.1"></a>

2026-11-08

- fold の中の吹き出し (ccmsg の知らせなど) の code ブロックが Timeline の幅を突き破ってページが横スクロールしていたのを直した (`.tl-guided` の子に `min-width: 0`、長いパスの地の文は折り返す)
- `.claude/settings.local.json` の差分の知らせは、パスをプロジェクトからの相対にして前書きを短くした

## v0.223.0 <a id="v0.223.0"></a>

2026-11-08

- 🔔 のフィルタは、Timeline に読み込んである窓の外の say と subagent / teammate の say も含む、そのセッションの全 say (既読含む) を時刻順に出す。daemon は初めて聞かれた時に本体と worker の transcript を全部読み (op `say_list`)、以後は push の差分で持つ。未読数もこの全件で数える。older の自動読みは無くした

## v0.222.0 <a id="v0.222.0"></a>

2026-11-08

- Timeline のツールバーの 🔔 🔐 は常に出す (数字は未読数)。Sessions の行は未読がある時だけ出す
- 許可依頼の記録を `<state dir>/permit-requests.json` に永続化し、daemon を再起動しても残る (セッションごと 200 件、全体 2,000 件、transcript の無いセッションの記録は起動時に落とす)
- module が繋がっていないセッションでも、Timeline を開いた時の一回読みで say の未読を数える

## v0.221.1 <a id="v0.221.1"></a>

2026-11-08

- 🔔🔐 のバッジをセッションのタブ列から Timeline のツールバーの左端へ移した。カウンターは絵文字の内側の右下に重ね、絵文字の大きさや行の高さを変えない

## v0.221.0 <a id="v0.221.0"></a>

2026-11-08

- permit に `project_permissions` を足した (DR-0040 §12)。`[{ add } | { remove }]` で `<cwd>/.claude/settings.local.json` の `permissions.allow` の変更を依頼でき、webui の許可依頼バブルに「`.claude/settings.local.json` の修正許可」区画 (今の中身、`+` / `-` の行、1 件ごとの「許可する」) が出る。押すと daemon が書き込み (他のキーは保持、`allow` はソート + 2 スペース)、5 秒でまとめた unified diff をそのセッションに知らせる。起動中の claude は変更を再起動なしで拾う (findings)。完全一致形を推奨 (classifier を通らない)
- protocol 2.1 (permit の tool の schema が変わった)。起動中のセッションは Status / 状態行の `ccmsg v…` が黄色になり、起動し直すと直る

## v0.220.1 <a id="v0.220.1"></a>

2026-11-08

- protocol の minor を 2.0 に戻した (v0.220.0 の変更は daemon → webui だけで module の契約は変わっていない)。`check-protocol-bumped` は「protocol の src を変えて、かつ module の bundle が変わる」時だけ bump を求める
- 古い client の印: Sessions の行には major 違い (hello を断られた) の ⚠ だけを赤で出し、minor 違いの △ は出さない。Status と状態行は major 違いが赤、minor 違いが黄色

## v0.220.0 <a id="v0.220.0"></a>

2026-11-08

- Timeline のタブ列の左端と Sessions の行に未読の 🔔 (say) / 🔐 (許可依頼) のバッジを置いた (DR-0050)。数は右上の赤いカウンター、押すとその種類だけを出すフィルタ (`?filter=say|permit`)、もう一度押すと解除して選択中のバブルの画面内の位置を保つ
- subagent / teammate (worker) の say も親セッションの未読に数え、親の Timeline に `🤖 名前 (model/effort)` の送り手付きで出す (protocol 2.1: `say_unread` の `agent_id`、新しい `agent_says`)
- 古い ccmsg client のセッションは Status の本文を印と版だけにして説明は title に移し、Timeline 下の状態行の `ccmsg v…` も黄色にした

## v0.219.0 <a id="v0.219.0"></a>

2026-11-08

- protocol の版を `major.minor` にした (この版で major 2)。major 違いの client (起動中の旧 module / sidecar を含む) は daemon が断り、Sessions に ⚠ が出る。**plugin を更新したら起動中のセッションを起動し直す**。minor 違い (tool / op の追加削除・schema 変更) は繋がるが、そのセッションの `ccmsg v…` (状態行 / Status / Sessions の △) が黄色になり、起動し直すと直る
- webui の bundle と daemon の protocol の major が違う時はリロードの案内を赤で出す (版だけの違いは青のまま)
- `just push` に `check-protocol-bumped` を足した: `packages/protocol/src/` を変えたら `PROTOCOL_VERSION` を上げないと止まる
- 新しい CLI が旧 daemon に hello を断られた時は、ping で daemon の版を見て入れ替える

## v0.218.0 <a id="v0.218.0"></a>

2026-11-08

- 吹き出しの足元の行 (時刻 → 翻訳タブ → 付随ボタン、hover で出る) を部品 1 つにまとめ、thinking / 応答 / user / 許可依頼 / エージェント間の全バブルで同じ見た目にした。thinking のタブは fold の枠の外に出る
- 訳タブ (`ja(*)`) を選んでいる間はそのタブを琥珀色にして、訳文を見ていることに気づけるようにした
- 翻訳タブの既定判定から、添付のリンクとパス / URL を除いた (日本語の本文がパスのせいで英語扱いにならない)
- 訳文の要素に CSS `text-autospace: normal` を当て、英数字と和文の間に空きを入れる (Chromium / WebKit で効く)
- AGENTS パネルの行を `名前 (model/effort) 最終活動からの経過時間` にし、行末の状態語を消した。idle の区画は既定で開く
- Files のお気に入りをツリーと同じ並び (同階層はディレクトリが先) にし、未展開のディレクトリも先に並ぶよう種別を記録する
- launch フォームの PROMPT 欄でも ⌘+Enter で起動できるようにした
- 「`!` で実行」の bash mode の待ちを composer の行に絞った (旧 module のセッションでは素の prompt になるので、plugin 更新後はセッションを起動し直す)

## v0.217.1 <a id="v0.217.1"></a>

2026-11-06

- Status の「再起動」を面 (config dir) で絞らなくなった。daemon の環境の `CLAUDE_CONFIG_DIR` と一致するセッションにしか出なかったのを、起動できてプロセスが居るセッション全部に出す (resume する面は起動コマンドの責務)。hello の `launch_config_dir` は無くした
- thinking の翻訳タブを fold 内上部から、他のバブルと同じ足元の hover ツールバーに移した

## v0.217.0 <a id="v0.217.0"></a>

2026-11-06

- 許可依頼 (permit) の 1 行のコマンドに「`!` で実行」ボタンを付けた。押すとそのセッションで Claude Code の bash mode (`! <command>`) として実行され、出力が TL に入る。module は `!` の打鍵で bash mode に入れてからコマンドを入れて Enter する (`prompt.send` / `user_prompt` に `mode: "bash"`)
- user の prompt (別セッションからのメッセージを含む)、エージェント間メッセージ (`<cross-session-message>` / teammate の relay、🤖→ / 🤖← のバブル) にも翻訳タブと既定タブの判定を付けた
- 🤖 バブルの名前の右に、その agent が実際に動いている model / effort を `(fable-5-1/low)` の形で出す (agent の transcript から読む。`agent_tree` のノードに `name` / `running_model` / `effort`)
- verify skill: 試験用セッションは `bypassPermissions` を使わず `--allowedTools` で要るツールだけ許す
- findings: bash mode を module から起こす経路の実機確認

## v0.216.1 <a id="v0.216.1"></a>

2026-11-06

- 許可依頼 (permit) のバブルにも翻訳タブと既定タブの判定を付けた (止められた行動・intents・コマンドの説明を訳す。コマンド本文と添付のパスは原文のまま)
- `say` の `text` と `permit` の `voice` の入力 schema に `description: "日本語"` を付け、skill にも「日本語で書く」と書いた (読み上げと 🔔 に出る文は応答言語に依らず日本語)

## v0.216.0 <a id="v0.216.0"></a>

2026-11-06

- 翻訳比較タブに `ja(plamo)` を足した (DR-0049)。ブラウザがローカルの PLaMo 翻訳サーバ (config `translate_plamo_url`) に段落ごとに直接 fetch し、4 並列で逐次表示。glossary と context を既定で付ける。到達できない環境ではタブを出さない
- 英語主体の段落 (コードを除いて 20 文字以上、日本語比率 2 割未満) が 1 つでもある thinking / 応答は、既定で `ja(plamo)` を開く
- タブの順を `original / ja(plamo) / ja(browser) / ja(host)` にした
- findings: PLaMo と macOS host 翻訳の品質・速度の比較

## v0.215.2 <a id="v0.215.2"></a>

2026-11-06

- Status タブの再起動フォームの textarea でも ⌘+Enter (Ctrl+Enter) で送信できるようにした

## v0.215.1 <a id="v0.215.1"></a>

2026-11-06

- CHANGELOG の版のアンカーを `#v0.215.1` のように区切り付きにした (見出し行に明示アンカー)。web UI の `ccmsg v…` のリンクもそれを指す

## v0.215.0 <a id="v0.215.0"></a>

2026-11-06

- 版ごとの変更点をリポ直下の `CHANGELOG.md` に書く運用を始めた (この版から)。`just bump-version` と `just push` は新版の節が無いと止まる
- web UI の版の表示 (Timeline 下の状態行の `ccmsg v…` / `claude v…`、GLOBALS の daemon と Claude Code の版) が、それぞれの CHANGELOG の版の見出しを新しいタブで開くリンクになった
