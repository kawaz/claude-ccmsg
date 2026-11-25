# DR-0057: webui のユーザスクリプト (人が書く TS / JS を daemon が build して保存し、有効にしたブラウザの webui がページの起動時に読み込む)

- Status: Accepted (2026-11-19、kawaz の依頼と指示を元に統括が決定) — ✅ 実装済み (protocol の `userscript.ts` と ErrorCode `userscript_invalid`、`Paths.userscript` / `Paths.userscriptBuilt`、daemon の `userscript.ts` の `checkUserscript` / `createUserscriptStore` と `server.ts` の 4 つの op、webui の `userscript.ts` の `startUserscript` / `runUserscript` / `importUserscript` / `createUserscriptUtil` / `setDeviceEnabled`、`components/UserscriptGlobals.tsx` の GLOBALS の行・編集の dialog・失敗の知らせ)
- Date: 2026-11-19

## Context

kawaz の依頼 (2026-11-19) の要点:

> TS でユーザスクリプトを足せる機能が欲しい。自分用の webui に、完全にユーザ責任で書くスクリプトを webui 上で保存し、全端末 (PC・スマホ) で同じ動きにしたい (Tampermonkey だと端末ごとに揃えにくい)。daemon が永続化するユーザ設定として持つ。

> GLOBALS に 1 行足す: `userscript: none | enabled (緑) | disabled (赤) [edit]`。edit で開く画面は大きな textarea と保存ボタン。既定の中身は `export async function userscript(util) {}`。

> util は「sid からセッションの情報を JSON で取る」くらいがあればよい。何を書いてもユーザ責任。

> 保存時に daemon でチェックし、エラーなら出力を表示して保存しない。OK なら保存。適用はユーザが自分でリロードする。チェックの目的は最低限「import しただけでエラーが出ない」こと (SyntaxError 等で webui が動かなくなるのを防ぐ)。

続く指示 (同日):

> やらかしたときの救済策として、ccmsg の URL を userscript=off|false で開いたら userscript を disabled (on/off は localStorage) にする経路を置いておく

> サーバ側で enable/disable は不要。デフォルト disable で enable は端末ごとに行うで。

> ユーザは ts/js で書けるが、ブラウザに実行用として import するのは bun で js に build した js。それとは別に edit 開いたときは元コード

## 目的

人が自分の webui の振る舞いを、自分で書いたコードで変えられる。書いたコードは daemon の 1 か所に保存され、どの端末からでも同じものを編集でき、走らせるかどうかはブラウザごとに決められる。書いたコードが壊れていても、webui は動き続け、止める・直す手段が残る。

増やしたくないもの:

- webui の中のスクリプト向けの API の面。`util` は依頼の範囲 (sid からセッションの情報) だけにし、将来の仮定で増やさない
- daemon がスクリプトを実行する経路。daemon はソースを読んで変換するだけで、import も実行もしない
- スクリプトが壊れた時にページが動かなくなる経路。読み込みと実行の失敗はページの外へ出さない
- 有効 / 無効を持つ場所。ブラウザの localStorage の 1 か所だけにし、daemon には持たせない

## Decision

### 1. 保存時の確認と build (daemon)

保存の依頼 (`userscript_write`) を受けた daemon は、ソースを `Bun.Transpiler` (`loader: "ts"`, `target: "browser"`) の `scan()` で読み、コードを実行せずに次を確かめる。1 つでも当たれば保存せず、何が悪いかを返す。`loader: "ts"` は JavaScript もそのまま読むので、TS でも JS でも同じ確認 1 本で済む。

| 断るもの | 出力 |
|---|---|
| 構文エラー | `userscript.ts:<行>:<列>: <パーサの文>`、その行、列の下の `^`。パーサが複数の誤りを返せば全部 (行・列は 1 始まり) |
| `userscript` の export が無い | 書く形 (`export async function userscript(util) { … }`) を添える。`export default` だけ・型だけの export も無いとみなす |
| ブラウザで解決できない import | `https://` / `http://` で始まらない import (静的、文字列の動的 import、`export … from`) をそれぞれ名指しする。`blob:` URL から読まれるモジュールには import map も階層のある基底 URL も無いので、bare な名前・相対・ルートからのパスは解決できない |

全部通ったら JavaScript に build する (`transformSync()`)。build が失敗すれば同じく保存せず、出力を返す。

- サーバでコードを import・実行はしない。トップレベルで `document` / `window` に触る正しいスクリプトまで弾くため。daemon で人のページ用のコードを走らせる理由も無い
- 型の誤りは見ない (`Bun.Transpiler` は型を消すだけで型検査をしない)。実行時の誤り (トップレベルの例外、存在しない関数の呼び出し、`require` の呼び出し) も見ない。それらは §4 でページが受け止める
- ソースの長さは 512 KiB (`USERSCRIPT_MAX_LENGTH`、ファイルの読み出しの上限 `FS_READ_MAX_BYTES` と同じ) まで。超えたものは op の入力の段で断る

build に `Bun.build` でなく `Bun.Transpiler` を使う理由: 確認がフル URL 以外の import を全部断るので、bundler が取り込むものが何も無い。`Bun.Transpiler` は 1 つのモジュールをメモリの上で変換し、`https://` の import はそのまま残す。`Bun.build` は入口をディスク上のファイルとして要し (一時ファイルを作ることになる)、出力の先頭にそのファイルのパスのコメントを入れる (Bun 1.4.4 で実測。`https://` の import は `external` の指定の有無にかかわらずそのまま残った)。得るものが無く、一時ファイルとパスの露出が増える。

### 2. 保存の置き場と配信

保存の時に、ソースと build した JavaScript の両方を書く。edit の dialog が開くのはソース (`userscript_read`)、ブラウザが実行用に import するのは build (`userscript_load`)。配る時に毎回は変換しない。

| ファイル | 中身 |
|---|---|
| `<configDir>/userscript.ts` | 人が書いたソース (保存した時のまま。JS で書いたものも同じ名前に置く) |
| `<stateDir>/userscript.js` | そのソースを build した JavaScript |

- ソースは config dir (`${CCMSG_CONFIG_DIR:-${XDG_CONFIG_HOME:-~/.config}/ccmsg}`) に置く。判断軸は「誰が書き換える前提か」(reference の app-file-placement) で、これは人が自分で書いてアプリの振る舞いを変えるコードであり、`config.ts` と同じ性質を持つ。daemon が書くのは人が webui から保存した時だけで、手で編集してもよい
- build は state dir に置く。ソースから作り直せるもので、失っても build 1 回分の手間しか失わない。ccmsg には cache dir が無く、cache のために置き場を 1 つ増やすほどのものでもないので、「失っても不便なだけ」の state に置く
- build が無いか、ソースより古い時 (ソースを手で書き換えた、state dir を消した) は、`userscript_load` がソースから作り直して書く (§1 と同じ確認を通す)。通らなければ `userscript_invalid` で断り、ページは §4 の失敗として扱う
- 書き込みは隣の一時ファイルに書いて rename する (途中で落ちても古いか新しいかのどちらかが残る)。ソースは [DR-0063](./DR-0063-project-auto-mode.md) §2 の `project-auto-mode.json` と同じ書き方で書く: `userscript.ts` が symlink (dotfiles から張る等) の時は実体 (realpath) の隣に一時ファイルを作って実体を置き換え、symlink は残す。mode は元のファイルのものを保ち (無ければ 0644)、一時ファイルは rename の前に fsync する。保存はソース、build の順に書く: 間で落ちても build がソースより古く残り、次の読み込みで作り直される。保存と作り直しは daemon の中で順に処理する
- 削除 (`userscript_delete`) はソース、build の順に消す。ソースが無ければ保存は無い扱いで、`userscript_load` は残った build を配らない。保存が無い時の削除は `not_found`

### 3. 有効 / 無効はブラウザごと (localStorage)、GLOBALS の行

daemon が持つのはソース (と、あるか無いか) だけで、走らせるかどうかはブラウザごとに localStorage (`ccmsg.userscript`、値 `on`) に持つ。既定は無効 (記録が無ければ読み込まない)。

| GLOBALS の表示 | 意味 |
|---|---|
| `userscript: none [edit]` (文字) | daemon に保存されたスクリプトが無い |
| `userscript: [enabled ▾] [edit]` (緑) | 保存があり、このブラウザで有効 |
| `userscript: [disabled ▾] [edit]` (赤) | 保存があり、このブラウザで無効 |

- 行の select がこのブラウザの切り替え。daemon には何も送らない。GLOBALS の endpoint の行と同じ「選ぶ部品が行の中にある」形で、文字と枠の色で状態を分ける。切り替えは保存と同じく、次に読み込んだページから効く
- URL の `?userscript=on` / `?userscript=true` はこのブラウザを有効に、`?userscript=off` / `?userscript=false` は無効にする (大文字小文字を問わない。他の値は何もしない)。ページの起動時、navigation が URL を書き直す前に読み、読み込むかを決めるより先に localStorage に書く。なので `off` はそのページから読み込まず、`on` はそのページから読み込む (書いてから決めるのが素直な順で、`on` を付けて開いた人はそのページで走るのを見たい)。以後はクエリ無しで開いても記録のとおりになる
- 壊れたスクリプトでページが使えなくなっても、そのブラウザで `?userscript=off` を付けて開けば止まり、GLOBALS の edit で直せる
- localStorage は origin ごとなので、同じブラウザでも別の endpoint (origin) から開けば別に切り替える
- 編集は `[edit]` で開く dialog (`ModalDialog`、狭い幅では全画面) で行う。webui-structure の「操作は dialog に分離」に従い、行に置くのはこのブラウザの切り替えだけにする
- dialog の中身: 説明の 1 文、大きな textarea (保存された元のソース、無ければ既定の `export async function userscript(util) {\n}\n`)、保存ボタン、保存がある時だけ削除ボタン、保存・削除の結果、`util` の型 (`<details>`)
- 削除は確認を挟む (`window.confirm`、セッションの kill と同じ流儀。「どの端末でも読み込まれなくなる、元に戻せない」と言う)。通れば行は `none` になり dialog を閉じる。別の端末で先に消されていた (`not_found`) 時も、頼んだとおりの状態なので同じに扱う。各ブラウザの localStorage の切り替えは残るが、保存が無ければ読み込まない
- 保存の結果: 断られたら確認の出力をそのまま整形済みで出す。通ったら「保存した。ページを読み込み直すと効く」。保存しても今開いているページには適用せず、このブラウザの切り替えも変えない
- 保存があるかは接続のたびに `userscript_read` で読み直す。別の端末で保存したものは、このページが再接続するか読み込み直した時に揃う

### 4. 読み込み (webui)

- ページの起動時、§3 の切り替えが有効なら、最初の接続の hello が通って保存があると分かった時に 1 回だけ、`userscript_load` で build を受け取り、`URL.createObjectURL(new Blob([js], { type: "text/javascript" }))` と動的 `import()` で読み、`userscript(util)` を await する。再接続では走らせない
- 読み込み・import・実行の失敗 (daemon の断り、トップレベルの例外、`userscript` が関数でない、`userscript` の中の例外・reject) は全部受け止め、webui 本体は動き続ける。失敗は `console.error` (`ccmsg userscript: <名前>: <文>`) と、画面の上に浮かぶ知らせ (失敗の文、「URL に ?userscript=off を付けて開くとこのブラウザで止められる」、閉じるボタン) で伝える。webui には toast の仕組みが無いので、この知らせを新しく置く。本文の配置を動かさないよう `position: fixed` で浮かせ、閉じるか読み込み直すまで出す
- スクリプトの読み込みは描画を待たせない。ページは先に描かれ、スクリプトは接続の後に走る
- webui のページに CSP は無い (daemon の応答にも `index.html` にも無いことを確かめた)。`blob:` の module の import は今のままで通る。ページに CSP を足す時は `script-src` に `blob:` を入れる

### 5. util

`userscript(util)` に渡す `util` は 1 つの関数だけを持つ。

```ts
interface Util {
  /** The session's rows as the webui holds them: its peer row (connected
   * sessions; PeerInfo) and its process row (AgentInfo), each null when the
   * webui has none. null when it has neither. Waits for the first lists. */
  session(sid: string): Promise<{ sid: string; peer: PeerInfo | null; agent: AgentInfo | null } | null>;
}
export async function userscript(util: Util): Promise<void>
```

- 中身は webui が既に持つ 2 つの行 (サイドバーの SESSIONS が使う `peers` の行と `agents` の行)。形は protocol の `PeerInfoSchema` / `AgentInfoSchema` のまま (どちらも JSON)
- スクリプトはページの起動時に走り、その時点ではまだ一覧が届いていないので、最初の `peers` と `agents` が届くまで待ってから答える
- 返すのは写し (`structuredClone`)。スクリプトが書き換えてもページの state に響かない
- 型の説明は編集の dialog の「util の型」と本節に置く
- 他は足さない。スクリプトはページと同じ origin で走るので、DOM も `fetch` も `/ws` も自分で使える

### 6. 権限

4 つの op (`userscript_read` / `userscript_write` / `userscript_load` / `userscript_delete`) は user role だけ。session role の接続と hello 前の接続は断る (既存の user role の op と同じ流儀)。

- user role は既にセッションへの入力・セッションの起動と停止・ファイルの書き込みなどの全権を持ち、webui の画面そのものも人の手にある。スクリプトの保存はその人のページに人のコードを足すだけで、権限の拡大にならない
- session role (セッションのエージェント) には読み書きさせない。エージェントが人のページにコードを入れる口を作らないため
- ホストのファイルに手が届くもの (エージェントのシェルを含む) は `userscript.ts` を直接書き換えられる。これは `config.ts` (daemon が評価する) や daemon のコードそのものを書き換えられるのと同じで、新しい経路ではない。加えて、走るのは人が有効にしたブラウザだけ

### 7. 保存時のブラウザ側の試し読みは入れない

保存の前にブラウザで試しに import してトップレベルの実行時エラーを先に見る、は入れない。依頼の範囲は「import しただけでエラーが出ない」構文の確認で、実行時の誤りは §4 がページの側で受け止める。入れるなら別の issue にする。

### 8. protocol の版

op を 4 つ足し、ErrorCode に `userscript_invalid` を足した。どれも webui だけが使い、hooks module の bundle (`hooks/register.bundle.js`) は変わらない (`bun hooks/bundle.ts --check` で確かめた) ので、`PROTOCOL_VERSION` は動かさない (protocol-version.ts の決まり: webui だけが読む変更は版を動かさない)。

## 未決

- 別の端末で保存したものは、push が無いので、そのページが再接続するか読み込み直すまで GLOBALS に出ない
- 2 つの端末で同時に編集すると、後に保存した方が残る (衝突の検知は無い)
- `util.session` の形は protocol の wire の形のままで、ccmsg の版が上がると予告なく変わりうる。スクリプト向けの安定した形を別に定めるかは決めていない
- スクリプトを走らせる時点は「最初の接続の後」だけ。描画の前に走らせる口は無い

## Alternatives Considered

| 案 | 採らない理由 |
|---|---|
| 保存時に daemon (Bun) でソースを import して試す | トップレベルで `document` / `window` に触る正しいスクリプトまで弾く。daemon のプロセスで人のページ用のコードを走らせることになり、無限ループなら daemon が止まる |
| 有効 / 無効を daemon に持つ (全端末で同じ) | 壊れたスクリプトが全端末で同時に走り、直す端末まで巻き込む。試すブラウザだけで有効にできる方が扱いやすい (kawaz 2026-11-19「サーバ側で enable/disable は不要」) |
| daemon の有効 / 無効と、ブラウザの止める記録の 2 層 | 走らない理由が 2 か所に分かれ、GLOBALS に 2 つの状態を並べて見せることになる。ブラウザの 1 層で目的 (端末ごとに試せる、壊れたら止められる) が足りる |
| 配る時に毎回 build する | 依頼は保存の時に build したものを配る形。保存の時に build すれば build の失敗をその場で人に見せられ、配る時は読むだけで済む |
| `Bun.build` で build する | §1 の理由 (取り込むものが無く、一時ファイルとパスの露出が増える) |
| Tampermonkey などブラウザの拡張に任せる | 端末ごとに入れて同じ中身に揃える手間が依頼の動機そのもの。iOS の Safari (ホーム画面の PWA) では使えない |
| iframe や Worker のサンドボックスで実行する | スクリプトの用途はページそのもの (DOM、画面の振る舞い) を変えることで、隔てると何もできない。書くのは人本人で、守る相手がいない |
| `config.json` の 1 項目にソースを文字列で入れる | 複数行のコードを JSON の文字列で持つと手で編集できない。`config.json` は人が手で書く宣言的な設定で、daemon が書き戻す前提が無い |
| `util` にセッションの一覧・入力・購読などを足す | 依頼の範囲は sid からセッションの情報を取ることだけ。スクリプトは同じ origin で動くので、要るものは自分で書ける |

## Consequences

- 人が書いたコードが、有効にしたブラウザのページと同じ権限で走る。壊れたスクリプトは `?userscript=off` で開いて止めるか直す。読み込み・実行の失敗は知らせに出るが、スクリプトが例外を投げずに画面を壊す・止める (無限ループ) ことは防げない
- 新しい端末・新しい endpoint では、有効にするまで走らない (既定は無効)。「保存したのに走らない」時は GLOBALS の行が disabled と言う
- v1 の daemon が持つ永続のファイルが増える ([DR-0036](./DR-0036-retire-rooms-for-p2p.md) §3 は v1 だけの永続状態を増やさない方針だが、これは kawaz が明示的に求めた、人が書くユーザ設定)
- 実測 (Bun 1.4.4): `scan()` は構文エラーで `BuildMessage` 1 つか、複数なら `AggregateError` を投げ、`position` に 1 始まりの `line` / `column` と `lineText` を持つ。`export type` だけの名前は `exports` に出ない。`require()` の呼び出しは `imports` に出ない。JavaScript だけのソースは `transformSync()` で同じ文字列のまま出てくる
- webui の bundle (`Bun.build`, `minify`, `splitting`) は変数を渡す `import(url)` をそのまま残す (bundle の出力で確かめた)
- 隔離した daemon と headless の Chromium (headless shell 1255) / WebKit (2391) の 1280px・390px で、保存の断りの表示、保存後の読み込み直しでスクリプトが走ること、`?userscript=off` で止まり以後もクエリ無しで走らないこと、`?userscript=on` でそのページから走ること、実行時の例外とトップレベルの例外の後もページが動くことを確かめた。`blob:` URL の module の import は両エンジンで通った。実機の iOS / macOS Safari では試していない

## 関連

- [DR-0043](./DR-0043-sidebar-folds-and-globals.md) §5 — GLOBALS に置くもの (本 DR が 1 行足す)
- [DR-0052](./DR-0052-secret-handoff-to-session.md) — webui からの user role だけの op の前例
- [DR-0002](./DR-0002-daemon-supervision.md) §1 — state / config / data の置き場
