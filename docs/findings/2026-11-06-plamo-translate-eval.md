# PLaMo 翻訳サーバ (translate-server) を webui の翻訳に使えるかの評価

- Date: 2026-11-06
- 対象: ccmsg v0.215.2 (実 daemon、ja(host) = Translation.framework の helper)、translate-server (PLaMo 3 Translate 0.8B Q4_K_M、llama-server `--parallel 4 -c 16384`、caddy-app-proxy のオンデマンド起動)
- 動機: ja(host) / ja(browser) の翻訳を、ローカルの PLaMo 翻訳サーバで置き換えられるか (DR-0023 の後継の判断材料)
- 方法:
  - 素材: kawaz の個人面の transcript から英文の段落を 15 個選んだ (thinking 12 / assistant text 3。短い thinking、600〜1,000 字の推論、バッククォート・コマンド・式を含む文、箇条書きと番号付きリスト、日本語の語が混ざる英文、`Bash` / `jj` を含む文)
  - PLaMo: `https://translate.kawaz-mbp.kawaz.jp/v1/chat/completions` に 1 段落 1 リクエスト、`temperature: 0`、`source_lang: en`。`form: plain` / `form: polite` / `plain` + glossary + context の 3 通り
  - host: 実 daemon の `daemon.sock` に user role の hello を送り、op `translate` を 1 段落 1 op で送った (webui と同じ形)。実 daemon の helper は kawaz の webui と共有なので、計測中に webui の翻訳が混ざった可能性は排除していない
  - 品質の判定は本調べの書き手 1 人による。「意味が変わる」は原文と突き合わせた判断、「自然さ」は主観

## 1. 品質

### 1.1 客観的に言える差

| 観点 | PLaMo (plain / polite) | host |
|---|---|---|
| バッククォート内の保持 (15 段落の全 span) | 全部保持 | 全部保持 |
| 段落内の改行数 (リスト 2 段落を含む) | 原文と一致 (15/15) | 原文と一致 (15/15) |
| Markdown の構造 | 崩れなし | 番号付きリストの 1 項目で `3.「…` と番号の後の空白が消え、リスト項目でなくなった (P13) |
| 余計な空白 | なし (plain / polite)。glossary + context を付けると英数字と和文の間に半角空白が入る段落が出た | `。 ` (句点の後に半角空白) が 4 か所 |
| 誤字 | なし | 「クロックスキア」(clock skew) |
| 文体の揺れ | plain で 2/15 段落が口語に崩れた (P03「〜するよ」、P14「確認してるんだけど…信用するかな」)。polite は 0/15 | 全段落が敬体 (0/15) |
| 決定性 | 同じ入力 2 回、直列と 4 並列で 15/15 一致 | 同じ入力 2 回で 15/15 一致 |
| 長文 1 リクエスト (8,584 字、21 段落) | 21 段落を保持 | 21 段落を保持 |
| 長文 1 リクエスト (12,931 字、29 段落、prompt 2,566 tokens) | **HTTP 200 のまま途中で切れる** (`finish_reason: "length"`、`total_tokens: 4096`、29 段落中 18 段落で終わる) | 未計測 |

長文が切れるのは、llama-server が `-c 16384 --parallel 4` で 1 slot あたり 4,096 tokens (`server.log` の `n_ctx_slot = 4096`) だから。入力と出力の合計が 4,096 tokens を超える段落は切れる。英文はおよそ 4〜5 字/token、訳文は入力と同程度の tokens なので、1 段落 7,000〜8,000 字前後が目安になる (この目安は 2 点の観測からの見積もりで、境界は計っていない)。

### 1.2 意味の誤り (原文との突き合わせ、書き手の判断)

| 段落 | 種類 | PLaMo plain | host |
|---|---|---|---|
| P02 | 短い thinking | workers →「作業員」、filing →「届け出」 | workers →「労働者」、filing →「提出」 |
| P05 | バッククォート多数 | なし | checks out →「チェックアウトしています」、dedupe →「デデュプレイング」 |
| P07 | `jj` を含む text | held (止められた) →「保持される」 | なし |
| P09 | `Bash` を含む thinking | なし | 時制 (shouldn't →「すべきではありませんでした」) |
| P10 | 長い推論 | なし | partial then recovers →「部分的に回復してから」、a write deadline being hit with a slow client →「書き込み期限が遅いクライアントで満たされた」 |
| P11 | 長い推論 | does not work out where auto-compact fires →「自動圧縮のトリガー箇所で動作しない」、decision-record →「判定レコード」 | clutter →「混乱」 |
| P12 | 箇条書き | no exclusion (排他制御) →「除外がなく」 | 同じく「除外はありません」。says "confirm …" →「確認できます」 |
| P13 | 番号付きリスト | consuming `jti` and challenge only after … の係り受けを誤る、cannot be replicated →「再現不可能」 | 係り受けを誤る (PLaMo と同じ)、burns the URL →「破損します」 |
| P14 | 日本語の語を含む英文 | なし (文体の崩れのみ) | inclined to trust →「信頼する傾向があります」 |
| P15 | 日本語の語を含む英文 | claim →「請求項」、contract →「契約書」、stray を落とす | stray →「散逸した」 |

意味の誤りがある段落は PLaMo plain 6、host 9。P01 / P03 / P04 / P06 / P08 は両方とも誤りなし。

例 (P10 の一部):

- 原文: `… which has a different symptom shape (partial then recovers) and could have an entirely separate cause like a write deadline being hit with a slow client`
- PLaMo plain: あちらは症状の現れ方が異なり（一部が書き込まれた後に復旧する）、低速なクライアントによる書き込み期限切れのような、全く別の原因が考えられる。
- host: 異なる症状パターン（部分的に回復してから）を持ち、書き込み期限が遅いクライアントで満たされたなどのまったく別の原因がある可能性のある画像/Chromeケース

例 (P07):

- 原文: `The edit itself is done; it's the commit that's held.`
- PLaMo plain: 編集自体は行われ、保持されるのはコミットだ。
- host: 編集そのものは完了しています。保留されているのはコミットです。

### 1.3 主観 (自然さ)

- PLaMo は語順を日本語に組み替え、長い推論 (P10 / P11 / P13) でも一文ずつ読める。host は英語の語順を残した直訳調で、長い段落ほど読みにくい (P10 の例)
- PLaMo plain は thinking の独白に合う常体だが、短い段落で口語 (「〜するよ」「〜かな」) に崩れることがある (1.1)。polite はその崩れが無い
- host はカタカナ語が多い (「サブスクリバー」「ステーブル」「デデュプレイング」)。PLaMo は識別子らしい語 (`stable`、`subscriber-0`) を英字のまま残す

### 1.4 glossary + context (1 パターン)

`glossary` に `Bash` `jj` `commit` `push` `daemon` `DR` `issue` `classifier` `workspace` `config` を同形で、`context` に「coding agent がリポジトリで作業するときのメモ (jj、シェル、DR)」を付けた (glossary と context を同時に付けたので、どちらの効果かは分けていない)。

| 語 (原文に出る段落) | plain で英字のまま / 訳語 | glossary + context で英字のまま / 訳語 |
|---|---|---|
| commit | 1 / 2 | 2 / 1 |
| push | 1 / 5 | 5 / 1 |
| classifier | 0 / 2 | 2 / 0 |
| config | 1 / 6 | 6 / 2 |

(plain の「英字のまま」はバッククォート内のコマンドに含まれる分)

- 効いた: P02 (「メンバー」「記録しておく」)、P11 の冒頭 (「auto-compact がどこで発火するか分からない」)、P13 の係り受け (「検証成功後にのみ `jti` とチャレンジを消費する」)、P15 (「帯域幅に関する主張」)
- 全件には効かない: P07 は「コミット」のまま、P08 は「プッシュ」と「push」が混在
- 悪化した: P11 で原文の引用句 (`"nothing is migrated or overwritten"` 等) を訳さず英語のまま残し、後半 2 節を 1 節に結合して意味が変わった。半角空白の入れ方が段落ごとに変わる

### 1.5 その他の観測

- 長文 1 リクエストの中では、同じ段落でも人名 `kawaz` を「カワズ」と書き換えた (12,931 字の 1 リクエストで 4 か所)。1 段落 1 リクエストでは `kawaz` を含む 8 段落すべてで英字のまま残った
- 原文に代名詞が無い所 (`… came from kawaz, who may be planning …`) に「彼は」を補った (長文 1 リクエストで 1 件)

## 2. 速度

| 計測 | PLaMo | host |
|---|---|---|
| 1 段落、110〜290 字 (P01〜P09、P14、P15) | 0.12〜0.36 s | 1.37〜4.40 s |
| 1 段落、640〜980 字 (P10〜P13) | 0.62〜1.13 s | 5.88〜9.21 s |
| 15 段落 (計 5,000 字) を直列 | 5.55 s (Python)、5.07 s (Bun) | 52.4 s、51.3 s |
| 15 段落を 4 並列 | 2.43〜2.63 s (Python 3 回)、2.48 / 2.57 s (Bun 2 回) | 並列にならない (helper は直列) |
| 15 段落を一斉に送る (webui と同じ形) | 2.34 / 2.80 s (Bun、最初の訳は 0.13 s) | 51.9 s (最初の訳は 1.24 s、以後 1 段落ずつ) |
| 長文 8,584 字 1 リクエスト (prompt 1,768 / 出力 1,912 tokens) | 8.5 s | 81.3 s |
| cold start | 未計測 (サーバを止めない制約)。`server.log` 上、モデルの読み込みは 1.6〜1.7 s (2 回分)。translate-server の DR-0003 は cold start 約 7 s | helper の起動と prepare 約 1.4 s (DR-0023) |

- 一斉に 15 本送っても 4 並列と合計はほぼ同じ (llama-server が 4 slot を超える分を待たせる)。呼び出し側が同時数を 4 に絞る必要は、合計時間の上では無い
- host の数字は実 daemon の helper を webui と共有した状態での値。OS の on-device モデルの混雑 (DR-0023 §7) の影響があったかは見ていない

## 3. 到達性と失敗時の振る舞い

### 観測した事実

- `translate.kawaz-mbp.kawaz.jp` は tailnet の IPv4 で、daemon が動くこのホスト自身。daemon から到達できる。iPhone / iPad の webui は daemon の WS を経由するので、端末から translate-server へ直接届く必要は無い
- **cold start の 302 を POST のまま辿れない**: caddy-app-proxy は 502 のとき `redir {uri} 302` を返す (Caddyfile)。302 を辿ると curl `-L` も Bun の `fetch` (既定の `redirect: "follow"`) も GET に変えて送り直す (手元の 302 を返す試験サーバで両方確認)。`/v1/chat/completions` への GET は llama-server が `404 {"error":{"message":"File Not Found"…}}` を返す (実サーバで確認)。したがって cold start の最初の翻訳は「302 → GET → 404」で失敗する。呼び出し側は `redirect: "manual"` で 302 を受けて同じ POST を送り直す必要がある (この経路を実サーバの cold start で通しては見ていない)
- 長い段落は HTTP 200 のまま切れる (1.1)。成功判定に `finish_reason` を見る必要がある
- 同じホストの FQDN に curl で繋ぐと、IPv6 (tailnet の ULA) が繋がらず、毎回約 205 ms 待ってから IPv4 に落ちる (`curl -6` は 5 s で timeout)。Bun の `fetch` は 2 回目以降 1〜2 ms で、この待ちは出なかった。IPv6 で繋がらない理由は見ていない
- caddy-app-proxy の README に idle で止める仕組みは無い。llama-server は一度起動すると手動で止めるか再起動するまで残る (計測時点で 16 時間稼働、RSS 900 MB)

### 未観測

- translate-server の起動に失敗した時 (ensure の 30 s timeout) に caddy が返すもの
- tailscale が落ちている時の fetch のエラーの形と所要時間
- 処理中のリクエストを呼び出し側が abort した時に llama-server が slot を解放するか

## 4. 置き換えの形 (論点)

### 推し: daemon の op `translate` に経路の指定を足し、ja(plamo) タブを並べてから host の撤去を決める

理由:

- 速度は全項目で約 10 倍。直列キューの問題 (translate-queue-cancel issue) の大半は PLaMo 経路では起きない (長文 8.5 s、4 slot で並列)
- 品質は 15 段落で PLaMo の誤りが少なく読みやすいが、段落ごとに見ると host が勝つ段落もある (P07、P11 の冒頭、P15)。サンプル 15 で「全面的に上」とは言えない
- DR-0023 の翻訳比較タブは「使える経路を全部並べて見比べる」思想で、ja(plamo) を足す形はそのまま乗る。撤去は比較の結果で決められる

判断を左右する軸:

| 軸 | ja(plamo) を足す | host を差し替える |
|---|---|---|
| 実運用での品質比較 | できる | できない (host が消える) |
| 維持するコード | 両経路 (Swift helper、watchdog、sendChain と HTTP client) | HTTP client だけ |
| tailnet / translate-server が無い時 | host が残る | 翻訳タブが無くなる |
| op の形 | 経路を選ぶ引数か別 op が要る | 現行の形のまま |

### 個別の論点

- **op の形**: webui のタブが経路ごとなので、request で経路を名指す必要がある (`translate` に経路の引数を足すか、経路ごとに op を分ける)。capability probe (空の `texts`) も経路ごとに要る
- **直列キューとの関係**: PLaMo 経路は sendChain も helper の kill も要らない。期限は fetch の `AbortSignal` で切れ、詰まった 1 本が他を止めない (llama-server の 4 slot が埋まっている間は待つ)。webui からの取り消しが無い問題は残る (送った op を止める手段が無い)。abort で slot が解放されるかは未観測
- **段落の扱い**: PLaMo は段落内の改行を保つので、host のための「段落ごとに batch に分けて連続改行を畳む」処理は PLaMo 経路では要らない。一方で 1 段落が 4,096 tokens を超えると切れるので、長すぎる段落の扱い (分ける / 切れたら原文に倒す) が要る
- **キャッシュ**: temperature 0 で決定的なので、キーは (経路、form、glossary、context、モデル) + 段落。webui は今も段落単位のメモリキャッシュ (512 件) を持つ。daemon 側に置けば端末 (Mac / iPhone / iPad) をまたいで共有できる。訳し直しは 1 段落 0.1〜1 s なので、永続化の要否は再訪の頻度次第
- **`form` の既定**: thinking の独白は常体が合うが、plain は 2/15 段落で口語に崩れた。polite は崩れなし。どちらを既定にするかは kawaz の好みで決める論点
- **glossary / context**: 識別子や 1 段落の文脈には効くが、引用句を英語のまま残す・節を結合するなど悪化もある。既定で付けるかは追加の比較が要る
- **消えるもの (差し替えた場合)**: Swift の helper (`packages/translate-helper`)、swiftc / Xcode CLT への依存、watchdog の期限設計、sendChain、連続改行の畳み込み、「macOS でのみ使える」制約
- **増えるもの**: translate-server と caddy-app-proxy と tailnet への依存、URL の設定の置き場、302 を POST のまま送り直す処理、`finish_reason` の確認、llama-server の常駐分のメモリ (起動後は残る、900 MB)

## 5. 未検証

- cold start の時間と 302 を送り直す経路 (実サーバを止めないため)
- translate-server の起動失敗時、tailscale 停止時の振る舞い
- abort で llama-server の slot が解放されるか
- 1 段落が切れ始める長さの境界
- glossary と context のどちらが効いたか (同時に付けた)
- 品質の判定は 1 人・15 段落。ja(browser) とは比べていない
