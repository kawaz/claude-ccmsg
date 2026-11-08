# Changelog

claude-ccmsg の版ごとの変更点。新しい版が上。[Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) に倣い、1 版を数行の箇条書きにする。版の見出しは `## v<版> <a id="v<版>"></a>` の形で、その下の 1 行目に日付を書く。web UI の版の表示はこのアンカー (`#v<版>`) へのリンクになっている。最も下の節より前の版は載せていないので、git の履歴の `Release v<版>` の commit を見る。

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
