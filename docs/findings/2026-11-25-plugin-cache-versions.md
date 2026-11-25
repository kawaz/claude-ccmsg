# plugin のキャッシュに溜まる ccmsg の旧版: 誰がいつ消すのか、実際に占めている量、ccmsg の側の案 (2026-11-25)

- Date: 2026-11-25 (18:30〜19:10、JST)
- 対象: ccmsg v0.422.0 (main)、Claude Code 2.1.332、macOS (Darwin 25.5.0、APFS)、bun 1.4.4
- 動機: issue [2026-11-12-plugin-cache-old-versions-accumulate](../issue/2026-11-12-plugin-cache-old-versions-accumulate.md) の受け入れ条件 (溜まる原因が ccmsg の側か Claude Code の側かの切り分け、ccmsg の側で減らせる点の採否)。調査と案までで、実装も削除もしていない
- 方法:
  - Claude Code の公式ドキュメント (plugin の loading reference と manifest reference) を読んだ
  - Claude Code 2.1.332 の実行ファイルから文字列を取り出し、キャッシュの掃除と依存の入れ込みの処理を読んだ (minify された JS。関数名は意味を持たないので、定数と文言で書く)
  - kawaz の普段の config dir の `plugins/cache/ccmsg-v1/ccmsg-v1/` の全版を、読み取りだけで調べた: 印のファイル、作られた時刻、`.in_use` の中の pid と動いているプロセスの突き合わせ、全ファイルの物理的な置き場所
  - 別の config dir 2 つは、版の数と `.orphaned_at` の数と最古の値だけを見た
  - 実際に占めている量は、各ファイルの先頭の extent の物理位置を `fcntl(F_LOG2PHYS_EXT)` で取り、同じ位置を指す別のファイル (別の版、bun の global cache、marketplace の clone) があるかで見た

## 結論

- **旧版を消すのは Claude Code の役目で、決まりどおりに動いている。** 使われなくなった版には `.orphaned_at` が書かれ、その mtime から 14 日を過ぎ、生きている claude のプロセスが使っていなければ、claude の起動ごとの掃除で消される。今キャッシュにある版はどれも `.orphaned_at` から 14 日に達していない (最古は 13.9 日)
- **溜まって見えるのは、ccmsg のリリースが 14 日の猶予に比べて速いから。** 直近 5 日でおよそ 1 日 25 版を出しており、このままなら 1 つの config dir に 14 日ぶんの約 350 版が常に残る
- **`du` の 45 GiB は実体の量ではない。** `node_modules` (1 版 145〜365 MiB) は全部 bun の global cache の APFS clone で、版を消しても空かない。版ごとに実際に占めているのは `node_modules` の外の 12.4〜18.5 MiB (中央値 17.1 MiB) で、141 版の合計は約 2.3 GiB。2026-11-20 に 332 版を消して `du` が 17.7 GB 減ったのに空きが約 5 GB しか増えなかったのも、1 版あたり約 15 MiB の計算で合う
- ccmsg が自分でキャッシュの旧版を消すことは、案にしない。キャッシュは Claude Code の持ち物で、その掃除は ccmsg の責務の外

## Claude Code が旧版をどう扱うか

### 一次資料 (公式ドキュメント)

plugin の loading reference の「Cleanup of previous versions」の節:

> When you update or uninstall a plugin, Claude Code writes an `.orphaned_at` marker into the previous version directory. It removes that directory in a background cleanup 14 days later, so a session that already loaded the old version keeps running.
>
> The sweep runs only while `installed_plugins.json` records at least one install. After you uninstall your last plugin, orphaned directories stay until you install another.

同じページの「Node.js package dependencies」の節は、Claude Code がキャッシュに版を作る時に、plugin の root に `package.json` と対応する lockfile (`bun.lock` 等) があれば、その版のディレクトリに依存を入れると書いている。入れ込みは止められない (`You can't turn the automatic install off.`)。workspace や linked の依存を持つ plugin には入れない、とも書いている。manifest reference は `${CLAUDE_PLUGIN_DATA}` を、版をまたいで残る置き場で `node_modules` 等の依存を置く所として挙げている。

### 実行ファイルから読めたこと (2.1.332)

- 掃除は claude の起動ごとに、plugin の読み込みの後に走る。日に 1 回等の間引きは無い
- `installed_plugins.json` の記録に無い版のディレクトリに `.orphaned_at` が無ければ書く (中身は書いた時刻の epoch ms)。記録にある版からは `.orphaned_at` を消す
- `.orphaned_at` の mtime (中身ではなく) から 14 日 (`1209600000` ms) を過ぎた版について、`.in_use/` の印を調べ、生きている印が 1 つでもあれば `Skipping orphan cleanup, in use by live session` で残す。無ければ版のディレクトリを消す
- `.in_use/<pid>` は、その版を読み込んだ claude のプロセスが書く (`{"pid":…,"procStart":"…"}`)。プロセスの終わりに消す。生死の判定は pid と起動時刻の両方を見る。死んだプロセスの印は、上の確認の時と、24 時間に 1 回の `.last_inuse_sweep` の掃除で消える

### 実物の印 (kawaz の普段の config dir)

| 項目 | 値 |
|---|---|
| 版のディレクトリ | 141 (0.240.0〜0.422.0) |
| `.orphaned_at` のある版 | 140 (無いのは install 中の 0.422.0 だけ) |
| `.orphaned_at` の中身と mtime | 140 版すべてで一致 (差 2 秒以内) |
| `.orphaned_at` の最古 | 0.240.0 の 2026-11-11 19:12。生きていない印を持たない最古は 0.244.0 の 2026-11-11 21:06 (13.9 日前) |
| 生きている claude の印がある版 | 20 版 (印 25 個)。全部 `comm` が `claude` で、印の `procStart` は ps の起動時刻と 9 時間ずれる (UTC と JST の表記の差) だけで一致した |
| 死んだプロセスの印 | 0.240.0 の 2 個だけ |
| `plugins/.last_inuse_sweep` | 2026-11-25 13:30 JST |

作られた日の分布は 11-11: 3、11-12: 3、11-15〜11-19: 10、11-20: 5、11-21: 7、11-22: 20、11-23: 31、11-24: 41、11-25 (18:21 まで): 21。11-20 の手での削除の時に install 中だった 0.298.0 より後の版が 123、0.298.0 以前の 18 版はその削除の時に残した版 (使用中と install 中)。

別の config dir 2 つは、版が 132 と 124、`.orphaned_at` が 131 と 123 で、最古の `.orphaned_at` は 2026-11-11 19:11 と 2026-11-20 18:49。どちらも 14 日に達していない。

動いているプロセスの引数に現れる版は、普段の config dir で 15 版 (サイドカー 18 本と daemon 1 本)、別の config dir で 11 版。サイドカーはどれも、同じセッションの claude と同じ秒に起動していた。

## 実際に占めている量

### 観測したこと

- 3 つの版と bun の global cache の同じファイル (`@typescript/typescript-darwin-arm64` の `lib/tsc` 23 MB、`mermaid` の `dist/mermaid.js.map` 19 MB) は、inode が別々で link 数が 1、先頭の extent の物理位置が同じだった。hardlink でなく APFS の clone で、bun の global cache と実体を共有している
- 141 版の全 2,359,911 ファイルについて先頭の extent の物理位置を取ると:

| 量 | 値 |
|---|---|
| ファイルごとの割り当ての合計 (`du` に近い値) | 45.42 GiB |
| 物理位置が重ならない分だけを数えた合計 | 2.62 GiB |
| そのうち bun の global cache にも marketplace の clone にも無い分 | 2.26 GiB |
| `node_modules` の中で、その版にしか無い分 | 0 (全版で) |
| `node_modules` の外で、その版にしか無い分 | 1 版 12.4〜18.5 MiB、中央値 17.1 MiB、141 版で 2.26 GiB |
| `node_modules` の外で、別の版と実体を共有している分 | 0 (内容の同じファイルも複製されている) |

- 1 版を消して空くのは、その版の `node_modules` の外の大きさ (今の版で約 18.5 MiB) と、約 19,000 ファイルぶんのメタデータ。`node_modules` は bun の global cache が同じ実体を持ち続けるので空かない
- 最新の 0.422.0 の `node_modules` の外の 18.5 MiB の内訳は、`packages/webui/test` 3.6、`packages/webui/src` 3.5、`packages/daemon/test` 2.2、`docs/findings` 1.8、`docs/decisions` 1.7、`packages/daemon/src` 1.5、`docs/issue` 1.1 MiB 等。test・e2e・docs が約 12 MiB で、動かすのに要る分は約 6.5 MiB
- 1 版の `node_modules` には devDependencies (playwright、typescript、oxlint、happy-dom 等) も入っている

### 見積り

- 直近 5 日 (11-21〜11-25) に作られた版は 120 で、1 日およそ 25 版。このまま続くと、1 つの config dir には 14 日ぶんの約 350 版が残り、実際に占めるのは約 350 × 18 MiB ≈ 6 GiB、`du` では約 130 GiB と出る。config dir の数だけ掛かる (別の config dir どうしが実体を共有しているかは確かめていない)
- 版の数はリリースの頻度で決まる。リリースの頻度は kawaz の運用で、案にしない

## 未確認

- 各版の `node_modules` を置いたのが Claude Code の入れ込みか launcher (`bin/ccmsg`) の入れ込みか。全 141 版で `packages/*/node_modules` が root の `node_modules` と同じ秒にできており、その場の `bun install` の形に見える (実行ファイルの Claude Code の入れ込みは別のフォルダで走らせて root の `node_modules` だけを移す)。launcher は 2026-08-17 から `node_modules` が無ければ入れており、成功の印 `.ccmsg-deps-installed` は 0.417.0 以降にしか無いので、それより前の版では切り分けられなかった。DR-0032 §2.2-4 の 2026-11-25 の決定は「`claude plugin install/update` は依存を入れない」を前提にしているが、公式ドキュメントと実行ファイルは Claude Code が `bun.lock` を見て入れる仕組みを持つと読める。ccmsg の root の `package.json` が `workspaces` を持つ時に Claude Code が入れるのか入れないのかは読み切れていない。前提の裏取りが要る
- 別の config dir どうしで同じ版のファイルが実体を共有しているか (中身を読まない約束なので見ていない)
- APFS の clone の判定は先頭の extent だけで見た。ファイルの途中から先が別の実体になっている場合は数え漏れる
- 版のディレクトリのメタデータ (約 19,000 ファイル) が占める量
- 14 日を過ぎた版が実際に消えるところ。0.244.0 は 2026-11-25 21:06 に 14 日に達し、その後の最初の claude の起動で消えるはず

## 案

ccmsg がキャッシュの旧版を消す案は、上のとおり責務の外なので入れていない。

### 推し: 案 A (ccmsg の側では何もしない)

旧版の掃除は Claude Code が決まりどおりにやっており、溜まる上限は「14 日 × リリースの頻度」で決まる。ccmsg の側で減らせる実体は 1 版あたり十数 MiB で、それを減らすには配布の形を変える必要がある。今の起動ディスクの使用率は 58 % (issue の時は 98 %) で、6 GiB 程度の常駐を理由に配布の形を変える根拠は弱い。issue は「原因は Claude Code の 14 日の猶予とリリースの頻度の組み合わせで、ccmsg の不具合ではない」として閉じる。

### 判断の軸と案ごとの評価

| 軸 | 案 A: 何もしない | 案 B: 配布物を動かすのに要る分だけにする | 案 C: 依存を持たない bundle で配布する |
|---|---|---|---|
| 1 版の実体 | 約 18.5 MiB のまま | 約 6.5 MiB (test・e2e・docs を外す) | 案 B と同じ程度 (`node_modules` は元から実体ゼロ) |
| 350 版での実体 | 約 6 GiB | 約 2.2 GiB | 約 2.2 GiB |
| `du` の見かけ | 約 130 GiB | 約 128 GiB (`node_modules` が残る) | 大きく減る |
| 前提 | なし | marketplace の `source` が、test と docs を含まない木を指せること (今は `"./"` でリポの root をそのまま配っている)。配布用の branch か subdir を作るリリースの手順が要る。Claude Code がどの形の source をどう写すかは未確認 | webui の client を配布の前に build しておけること (今は daemon が起動後に `Bun.build` する)。CLI・daemon・hooks を 1 つずつの bundle にできること。root に `package.json` と `bun.lock` を置かないこと |
| 壊れうる所 | なし | skill や hook が `docs/` 等を参照していれば切れる。リリースの手順が 1 段増え、配布の木とリポの木がずれうる | DR-0032 の launcher の依存の入れ込みと印の仕組みを作り直す。daemon の webui の build の仕組み (DR-0005) を変える。版ごとの差分の調べやすさが落ちる |

- 案 C は、実体の量では案 B と変わらず、変える範囲がずっと大きい。得られるのは `du` の見かけと 1 版あたりのファイルの数で、APFS の上では空きはほぼ増えない。ディスクの量を理由に選ぶ案ではない
- 案 B と案 C を足した案は出さない: 実体の減りは案 B だけで取れ、案 C の前提 (webui の事前 build) は案 B の得を増やさない
- `node_modules` を版の外 (`${CLAUDE_PLUGIN_DATA}` 等) に置く案は、APFS の上では空く量が無いので入れていない。root に `package.json` と `bun.lock` がある限り Claude Code の入れ込みが版のディレクトリに入れる可能性もある (上の未確認)

## 検証の詳細

### 物理位置の取り方

`fcntl(fd, F_LOG2PHYS_EXT /* 65 */, struct log2phys { l2p_flags=0, l2p_contigbytes=<ファイルの大きさ>, l2p_devoffset=0 })` を読み取り専用の fd で呼び、返った `l2p_devoffset` (先頭の extent のデバイス上の位置) をファイルの物理位置とした。大きさ 0 のファイル (2,262 個) は除いた。照らし合わせ先は bun の global cache (7.7 GiB) と、plugins の下の marketplace の clone (`marketplaces/ccmsg-v1`)。

### 使ったコマンド (抜粋)

- 版の数: `ls <config dir>/plugins/cache/ccmsg-v1/ccmsg-v1 | wc -l`
- `.in_use` の突き合わせ: 各版の `.in_use/<pid>` について `ps -p <pid>` で生死を見て、生きていれば `ps -o lstart=,comm=` と印の `procStart` を比べた
- プロセスの引数の版: `ps -axo args=` から `plugins/cache/ccmsg-v1/ccmsg-v1/<版>` の形だけを抜き出した (環境変数は読んでいない)
