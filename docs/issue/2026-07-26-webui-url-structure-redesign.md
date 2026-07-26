---
title: "webui の URL 構造を論理的に再設計する"
status: open
category: design
created: 2026-07-26T19:08:12+09:00
last_read:
open_entered: 2026-07-26T19:08:12+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered:
discard_reason:
pending_reason:
close_reason:
blocked_by:
origin: "自リポ TODO"
---

# webui の URL 構造を論理的に再設計する

## 概要

webui の URL 構造を論理的に再設計する。

## 背景

現状の問題:

1. 機能追加のたびに個別実装された結果、URL の構造がバラバラで論理性が無い
2. Terminal タブ・Status タブに URL が無く、リロードすると Timeline に戻ってしまう(タブ状態が URL に載っていない)
3. サブエージェント系の URL に一貫性が無い — teammate(名前で参照)・workspace・素の subagent(agentId で参照)がそれぞれ別形式で、論理的な体系になっていない

## 受け入れ条件

- [ ] (a) 現状の全 URL 形式を棚卸しする(`packages/webui/src/client/locator.ts` が locator の正本、`state.view` / `applyLocatorChanged` も参照)。何がどう表現され、何が URL に載っていないかを一覧化する
- [ ] (b) 論理的な体系を設計する。観点: セッション / タブ / タブ内の状態(Files のパス・Timeline の agent ref・Rooms の room)を階層としてどう表すか、共有可能・リロード耐性のある単位は何か、agent の 3 種(teammate / workspace / subagent)をどう統一的に表すか
- [ ] (c) 移行方針を決める(既存 URL の後方互換をどこまで保つか、pinned session や favorites など locator に依存する永続データへの影響)
- [ ] 設計を kawaz 裁定に出してから実装する
- [ ] TL の位置が URL に載り Back で復元できる
- [ ] タブ状態が URL に載りリロードで維持される
- [ ] タブ切替でアンマウントせず状態を保持する(URL 設計とは別軸だが同時に解決すべき)
- [ ] agent 3 種が対称な表現になる

## 備考

同時期に FileTree の root を repo_root から cwd に戻す変更を実施しており、locator の path 表現に影響する可能性がある。

## 追加要望 (kawaz r55m100)

1. TL の URL に jsonl の行 id を含めたい。用途: TL 閲覧中に Files や他セッションへ移動する瞬間に `tl/<id>` を history に積んでおけば、Back で戻った時に TL が進んでいても最後に見ていた位置から続きを追える
2. history API を活用した SPA 強化をしたい(現状は hash のみ + `location.assign`)
3. File と TL を交互に移動すると TL タブに戻るたびにリロードされ、さっき見ていた位置がすぐ出ない

## 現状の棚卸し (2026-07-26)

全 URL 形式:

- `#rN` (room)
- `#rN-mM` (room の特定メッセージ)
- `#s<sid>` (Files タブ)
- `#s<sid>:<path>` (ファイル)
- `#s<sid>:<path>:L10-20` (行範囲)
- `#t<sid>` (Timeline タブ)
- `#t<sid>:a<id>` (素の subagent)
- `#t<sid>:wf_XXX/a<id>` (workflow 配下 agent)
- `#t<sid>:tm/<name>` (teammate)

内部表現 Locator は room / session(=Files) / timeline の 3 種のみ。

問題点:

- (a) 接頭辞が場当たり的で room だけ無印・Files が `s`・Timeline が `t`、同一セッションの別タブなのに分かれておりタブという概念が URL に無い
- (b) Terminal / Status / Rooms タブに対応する view が無くリロードで戻ってしまう
- (c) 区切り文字が多義的(`:` がタブ内状態と行範囲の両方、`/` が runId/agentId と `tm/name` で別の意味)
- (d) agent 3 種が非対称(teammate だけ `tm/` 付き、workflow は 2 セグメント、subagent は裸)
- (e) room とセッションが同じ名前空間で階層関係が不明示

## 設計の叩き台 (main 私案、未裁定)

`#<種別>/<id>/<タブ>/<タブ内状態>` の階層構造案:

- `#s/<sid>/files/<path>`
- `#s/<sid>/timeline`
- `#s/<sid>/timeline/<uuid>` (位置)
- `#s/<sid>/timeline/agent/tm/<name>` | `agent/wf/<runId>/<agentId>` | `agent/sub/<agentId>`
- `#s/<sid>/terminal`
- `#s/<sid>/status`
- `#s/<sid>/rooms`
- `#r/<roomId>`
- `#r/<roomId>/m<mid>`

位置 id は jsonl 各行の `uuid` フィールドを使う(実データで存在確認済み。byte offset より堅く、前方の行が書き換わってもずれない)。

## 確定仕様 (kawaz 裁定 r55m102/m104-m109、2026-07-26)

### ルーティング基盤

Navigation API を採用する(2026-01 に Baseline Newly Available、Chrome/Edge/Firefox 147/Safari 26.2。ccmsg は対象ブラウザを限定できるのでフォールバック不要)。

History API は以下の弱点があり、今回の用途(位置の記録と復元、セッション離脱時の保存)に直撃するため不採用:

- popstate が pushState/replaceState で発火しない
- 履歴スタックを読めない
- hash 遷移で state が失われる
- リンククリックを全て preventDefault で拾う必要がある

Navigation API では `navigate` イベントで全遷移を一箇所で捌き、`navigation.entries()` で履歴を読み、エントリの `dispose` イベントを離脱検知に使える。

### URL 形式

hash でなく実パスを使う。`#/` でなく `/` から始まる通常のパス。

- セッション配下: `/s/<sid>` (既定タブへリダイレクト)
- `/s/<sid>/files?path=<path>&lines=10-20` (Files。パスと行範囲はクエリで機械的に組み立てる。可読性より生成の容易さを優先という kawaz 裁定)
- `/s/<sid>/timeline/head` (TL 最新位置)
- `/s/<sid>/timeline/<uuid>` (TL の特定位置。uuid は jsonl 各行の uuid フィールド、実データで存在確認済み。byte offset より堅く前方の行が書き換わってもずれない)
- `/s/<sid>/timeline/agent/tm/<name>` | `/agent/sub/<agentId>` | `/agent/wf/<runId>/<agentId>` (エージェント 3 種を種別セグメントで対称化)
- `/s/<sid>/terminal`
- `/s/<sid>/status`
- `/s/<sid>/rooms`
- room: `/r/<roomId>`、`/r/<roomId>/m<mid>`

### 既定タブとリダイレクト

初回アクセス(recent 無し)の `/s/<sid>` は `/s/<sid>/timeline/head` へリダイレクト。2 回目以降は保存済み recent へリダイレクト。これによりセッション内で特定作業中(ファイルを開いている等)に他セッションを覗いて戻ってきた際、離脱直前のビューに復帰できる。

### recent の保存

保存先は localStorage(端末ごと。daemon には保存しない = kawaz 裁定 r55m109)。保存内容は URL 文字列そのもの(タブ + タブ内状態を丸ごと)。保存タイミングはセッション外へ遷移する直前(セッション内移動ごとの保存は不要、頻繁に更新しなくてよい)。

### TL 位置の更新

基本は `/head` に居る状態。メッセージバルーンをクリックしたらその uuid に replace、最下部に到達したら `/head` に replace。他タブ・他セッションへの移動直前にも保存。履歴を汚さないため replaceState 相当(Navigation API では `navigation.navigate(url, {history: "replace"})`)を使う。

### history の積み方

タブ切替は replace、セッション/room の移動は push。

### キャッシュ (実パス化に伴い必要)

現状の webui 配信(`packages/webui/src/index.ts`)はキャッシュヘッダが一切無く、`/assets/app.js` もハッシュ無しファイル名。実パス catch-all を入れる際に SPA のベストプラクティスへ揃える:

- SPA シェル(`/` と catch-all)は `Cache-Control: no-cache` + ETag で毎回再検証(変わっていなければ 304)
- バンドルは `/assets/app.<hash>.js` のハッシュ付き名にして `public, max-age=31536000, immutable`、シェルの script src はハッシュ名を指すよう生成
- `/attachment/*` と `/fs-serve` は daemon 側で先に処理済みなので catch-all の対象外
- SPA 専用の HTTP ステータスは存在しないため未知パスは 200 + シェルで返す(SEO 無関係の tailnet 内ツールなので soft 404 問題は該当しない)

### 後方互換

不要(kawaz 裁定 r55m102「どうでも良い」)。既存の `#s...`/`#t...`/`#rN` 形式のリダイレクト受けは実装しない。

### タブ状態の保持

URL 設計とは別軸だが同時に解決する: File と TL を交互に移動すると TL タブに戻るたびリロードされ直前の位置が出ない問題があるため、タブ切替でアンマウントせず状態を保持する実装に変える。

### 状態保持の階層 (kawaz 裁定 r55m110/m111)

TL 等の巨大ステートを可能な限り捨てず、タブやセッションを往復しても再描画・再フェッチが発生しない体験を目指す。実装は 3 階層に分かれるが、採用するのは 1 と 2 のみ。

1. タブ切替でアンマウントしない = 非表示にするだけで DOM を保持する。再描画も再フェッチもゼロ。必須。
2. セッション切替でも捨てない = 別セッションを覗いて戻った時も再描画しない。セッションごとに TL 状態を保持するためメモリを食う(長い TL × 複数セッション)ので、LRU 等で保持数に上限を設ける。採用。
3. リロード(ページ再読込)を跨いだ永続化(IndexedDB 等) = **不採用**。kawaz 裁定「リロードしたいのっていろんな意味でスッキリしたいときだと思うので」— リロードはユーザの「状態をリセットしたい」という意思表示であり、永続化でそれを無効化するのは逆効果。リロード時は意図的に全て捨てる。

### standalone webapp で詰まない設計 (kawaz 裁定 r55m115)

iPad のホーム画面 webapp は standalone 表示でアドレスバーも戻るボタンも無いため、不正な URL に遷移して 404 等のフルスクリーンエラーが出ると戻る手段が無くアプリ終了しか復帰路が無い(= 詰む)。予防と救済の 2 層で対処する。

予防:

1. 不正 URL でもサーバは常に SPA シェルを返し HTTP 404 ページを出さない(実パス catch-all の既定動作。SEO 無関係なので soft 404 問題は該当しない)
2. 存在しないセッション / room への遷移は Navigation API の `navigate` イベントで intercept し、対象の存在を確認してから遷移する。存在しなければ遷移自体を中止して URL を変えず、その場で通知する
3. replace での移動は履歴に戻り先が残らないため特に危険。recent へのリダイレクトが該当するので、保存された recent が現在も有効か(セッションが存在するか、ファイルが存在するか等)を検証してから replace し、無効なら `/s/<sid>/timeline/head` にフォールバックする

救済:

4. SPA 内のエラー表示は必ずコンテンツ領域内に出し、サイドバー(Sessions / Rooms)を潰さない。サイドバーが残れば実質そこから復帰できる。フルスクリーンのエラー画面は作らない
5. エラー表示には「セッション一覧へ」等の復帰ボタンを必ず置く(最後の砦)
6. `navigation.canGoBack` を見て、戻れる場合のみ「戻る」ボタンも併せて出す

### グローバルヘッダの back / forward ボタン (kawaz 要望 r55m128)

グローバルヘッダ右端のリロードボタンの左横あたりに back / forward ボタンを常設する。用途は 2 つ:

1. 迷子リンクからの回復(standalone webapp はアドレスバーも戻るボタンも無いため、アプリ内に戻る手段が無いと詰む)
2. TL と Files を行ったり来たりする日常操作の利便性

実装は Navigation API の `navigation.canGoBack` / `canGoForward` で活性判定し、`navigation.back()` / `forward()` を呼ぶだけで済む。

ただし実装順序は URL 再設計(Phase 1)の後とする — 現状の hash ベース URL はタブ状態を持たないため、先に back/forward を付けても「Terminal タブから戻ったら Timeline に飛ぶ」等の期待外れな挙動になり、機能として成立しない。

## 解決時の記録先

- 設計判断を伴う: `decisions/DR-NNNN-...md`
