# DR-0049: 翻訳比較タブに ja(plamo) を足し、ブラウザが PLaMo 翻訳サーバへ直接段落を送る

- Status: Accepted (2026-11-06、kawaz 裁定) — ✅ 実装済み (daemon の config `translate_plamo_url` と hello の `translate_plamo_url`、webui の `plamo-translate.ts` と翻訳タブ)
- Date: 2026-11-06

## Context

thinking / assistant 応答の翻訳比較タブ ([DR-0023](./DR-0023-daemon-local-translation.md)) は `ja(host)` (macOS Translation.framework を daemon の helper 経由で) と `ja(browser)` (Chrome の Translator API) を、使える経路だけ並べている。host は helper が直列で、1 段落 1.4〜9 s かかり、長い thinking では待ちが積もる。

ローカルの PLaMo 翻訳サーバ (PLaMo 3 Translate 0.8B を llama-server で動かす translate-server、caddy-app-proxy が最初のアクセスで起動する) を、実 transcript の英文 15 段落で評価した ([findings 2026-11-06-plamo-translate-eval](../findings/2026-11-06-plamo-translate-eval.md))。速度は全項目で host の約 10 倍 (1 段落 0.1〜1.1 s、15 段落を 4 並列で約 2.5 s)、意味の誤りがある段落は 15 中 6 (host は 9)。ただし段落ごとには host が勝つものもあり、サンプル 15 で host を外す根拠にはならない。

## Decision

### 1. 目的

速くて読みやすい翻訳経路を、既存の経路を残したまま比較タブの 1 つとして使えるようにし、実運用で経路どうしを見比べられるようにする。増やしたくないものは、daemon が中継する経路 (op・待ちキュー・期限の設計) と、使えない時にも出るタブ。

### 2. 経路: ブラウザが翻訳サーバへ直接 fetch する

- webui が翻訳サーバの OpenAI 互換 API (`<url>/v1/chat/completions`) へ直接 POST する。daemon は fetch も中継もしない
- CORS は翻訳サーバの前段 (caddy) が ccmsg の origin に対して返す (GET / POST / OPTIONS、`Content-Type`)。設定は翻訳サーバ側の責務で、ccmsg は持たない
- daemon を経由しないので、host の helper の直列キューや期限の設計とは無関係に、段落ごとの並列が効く

### 3. endpoint の出どころ: daemon の config と hello

- daemon の config のトップレベルキー `translate_plamo_url` (http / https の URL、既存の `*_url` キーと同じ検査) に base URL を書く。例: `translate_plamo_url: "https://translate.kawaz-mbp.kawaz.jp"`
- daemon は user role の hello にだけ `translate_plamo_url` を URL のまま返す (`terminal_gateway_url` と同じ姿勢)。`llm_*_available` と違い URL そのものを渡すのは、fetch するのがブラウザだから
- 未設定なら hello に field が無く、webui はタブを出さない

### 4. 可用性の判定

- webui は hello で URL を受けたら `GET <url>/health` を期限 5 s で投げ、200 なら使える。失敗したら 1 秒置いてもう 1 回だけ確かめる (cold start の 302 と起動待ちを 1 回で見限らない)
- 確かめている間も handshake は先へ進む。判定は接続ごとにやり直し、接続のたびに「使えない」へ戻してから確かめる (再接続先の daemon の config に URL が無ければタブは消える)
- 使えない時はタブを出さない (`ja(browser)` が Translator API の無い環境で出ないのと同じ)

### 5. 翻訳の単位と request

- テキストを空行 (`\n\n`) で段落に分け、段落 1 つ = 1 リクエスト。空の段落以外は日本語の段落も一律に送る。PLaMo はほぼ日本語の段落を壊さないので (評価 §1、reference の local-translate)、browser / host のような「日本語を含む段落は送らない」前処理を持たない (kawaz 裁定)
- 同時に送るのは 4 本まで (llama-server の slot 数)。超える分は webui の中で待ち、届いた段落から逐次表示する
- body: `{"model":"plamo-3-translate","messages":[{"role":"user","content":<段落>}],"chat_template_kwargs":{"target_lang":"ja","form":"plain","glossary":[...],"context":"..."},"temperature":0,"max_tokens":<段落長に応じて>}`
- `glossary` は英語のまま残す技術語 (`Bash`、`jj`、`commit`、`push`、`daemon`、`session`、`transcript`、`hook`、`tool`、`worker`、`subagent` など ccmsg と Claude Code の文脈で頻出する語、`source` = `target`)。`context` は「Claude Code (AI coding agent) のセッションの thinking / 応答。技術文書。」。どちらも webui の `plamo-translate.ts` の固定の定数で、既定で付ける (評価 §1.4 で識別子の保持と係り受けが良くなった)
- `form` は `plain`。切り替えの UI は持たない
- `max_tokens` は `段落の字数 / 2 + 128` (下限 256、上限 4,096)。1 slot の入出力合計が 4,096 tokens で、訳文は入力と同程度の tokens なので、余裕を持たせつつ上限を超えない

### 6. 失敗と切れた訳

- HTTP エラー・ネットワークエラー・応答の形の不一致 (応答は境界でスキーマに通す)・cold start の 302 は、1 秒待って同じ POST を 1 回だけ送り直す。302 は `redirect: "manual"` で受けて失敗として扱う (辿ると fetch が POST を GET に変えて 404 になる、評価 §3)。待っている間は同時数の枠を返す
- それでも駄目な段落は、原文に「翻訳できなかった」の印を付けて出す
- `finish_reason: "length"` (HTTP 200 のまま slot の上限で切れた) の段落は、文の終わりか改行で真ん中に近い所から 2 つに分けて送り直し、2 つの訳をつなぐ (分けた所が改行なら改行を戻し、空白なら詰める)。分けても切れた、分けられる所が無い、分けた片方が失敗した段落は、切れた訳をそのまま出して「途中で切れた」の印を付ける
- 1 リクエストの期限は 60 s。詰まった request が枠を持ったままにならないようにする

### 7. キャッシュ

- temperature 0 で決定的なので、キー = (model, form, glossary と context のハッシュ, 段落の原文) で端末内のメモリにキャッシュする。browser / host の段落キャッシュと同じく上限 512 件、古い書き込みから捨てる。永続化はしない (訳し直しは 1 段落 0.1〜1 s)
- 同じ段落の並行要求は 1 リクエストにまとめる
- 失敗した段落は載せない (サーバが戻れば次に開いた時に訳し直す)。切れた訳は決定的なので載せる
- 訳は TL 検索の訳のレジストリにも段落単位で載せる (他の経路と同じ)

### 8. UI

- 翻訳タブと既定のタブの判定を持つのは thinking / assistant 応答 / user の prompt (別セッションからのメッセージを含む) / 許可依頼 / エージェント間メッセージ (`<cross-session-message>` / `<teammate-message>` / `<agent-message>` の relay、SendMessage、spawn の prompt) のバブルで、どれも同じタブの並びと判定を使う。許可依頼で訳すのは止められた行動・intent・コマンドの説明で、コマンド本文・添付のパス・「許可する」が写す許可の文は原文のまま。エージェント間メッセージで訳すのは本文だけで、ヘッダ (名前、summary、channel のラベル) と idle 通知の行は原文のまま。既定の判定には訳す対象を全部つないだ本文を渡す
- タブ列はどれも吹き出しの足元の行の部品 `BubbleFooter` に置く。全吹き出し (応答・user・許可依頼・エージェント間メッセージ・ccmsg・thinking) がこの部品を使い、並びは左から 時刻 → 翻訳タブ → 吹き出しごとの付随ボタン (応答の md / source / ☰)。タブとボタンは hover ツールバー (`tl-msg-toolbar`、通常は不可視で、足元の行を直接持つ要素の hover / focus で出る) に入り、時刻は常に見える。右寄せの吹き出し (user) だけは時刻を右端に置く。`ja(*)` のタブが選ばれている間は選択色を青でなく琥珀 (注意系のトークン) にし、本文が訳文だとタブの色で分かるようにする (本文側には印を付けない)。thinking は fold の本文の枠の外、枠のすぐ下に足元の行を持ち、thinking ごとに 1 列 (thinking は応答とは別の行に書かれ、応答のバブルの中には来ない)。時刻は fold の summary 行が持つので thinking の足元には出さない。fold が閉じている間は summary 行に翻訳の状態を出さない
- タブ名 `ja(plamo)`。並びは `original / ja(plamo) / ja(browser) / ja(host)`。速くて品質の良い経路を先に、将来削る候補の host を末尾に置く
- **既定のタブ** (thinking は fold を開いた時、応答・user・許可依頼・エージェント間メッセージのバブルは描画した時に、同じ判定で自動で選ぶもの): `ja(plamo)` が使えて本文に英語の段落が 1 つでもあれば `ja(plamo)`、それ以外は `original`。host / browser は比較のために選べるタブで、既定にはしない
  - 英語の段落の判定: 本文から fenced code block (閉じの無い fence は本文の終わりまで) とインラインコードを除き、空行で段落に分ける。添付のリンク (webui が本文に入れる `[FILE<N>:<名前>](<添付の置き場のパス>)`) と、空白を含まない token のうち `/` を 2 つ以上含むもの (パス) と `://` を含むもの (URL) も除く (人の書いた文ではなく英数字だけで比率を英語側へ倒すため)。20 文字以上ある段落のうち、日本語文字 (ひらがな / カタカナ / 漢字、browser / host の段落判定と同じ文字クラス) の比率が 2 割未満のものを英語の段落とする。文字数と比率の分母は「日本語文字 + 英数字」で、記号と空白は数えない。バブルの本文は中の text segment をつないだもの
  - 根拠: PLaMo はほぼ日本語の段落を壊さないので、`ja(plamo)` に倒すコストは低い。逆に全文英語の段落が 1 つでも原文のままだと読めない。日英が半々あたりの段落では日本語部分の単語をごくたまに入れ替えるが、それは訳タブの中で起きることで、原文タブは常に残る (kawaz 裁定)。20 文字の下限は、「OK」「Done.」やコードを除くと数文字しか残らない段落だけで本文全体が `ja(plamo)` に倒れないため
  - 自動の選択は 1 度だけ、可視範囲の近くに来た時に行う。人がタブを選んだら、その後に `ja(plamo)` が使えるようになっても (health の確認は hello の後に届く) 自動では切り替えない
- 訳タブの間は本文の訳文を包む要素 (`tl-translated`) に CSS の `text-autospace: normal` を当て、PLaMo の訳文で詰まる英数字と和文の間に空きを入れる。原文には当てない。未対応のブラウザは詰まったまま許容し、JS で空白を差し込む後処理は採らない ([findings 2026-11-06-translation-text-autospace](../findings/2026-11-06-translation-text-autospace.md))
- 選んでいたタブの経路が再接続で無くなったら `original` に戻す (host と同じ扱いを全経路に)

## Alternatives Considered

- **daemon の op `translate` に経路の指定を足して daemon が中継する** (評価 §4 の推し): 端末をまたいだキャッシュや、tailnet に直接届かない端末からの利用ができるが、daemon の op と待ちの設計が増える。増やしたくない「daemon が中継する経路」を足さずに済むブラウザ直接を採った (kawaz 裁定)。翻訳サーバに届かない端末では §4 の判定でタブが出ないだけになる
- **host を PLaMo に差し替える**: 比較ができなくなる。撤去は実運用の比較の結果で決める
- **翻訳サーバの URL を webui の設定 (localStorage) に置く**: 端末ごとに設定が要り、daemon の config に他の endpoint と並べて置けない

## Consequences

- 翻訳サーバと tailnet と caddy の CORS 設定が無い環境では、タブが出ないだけで他は変わらない
- 翻訳サーバの CORS が許す origin は ccmsg の origin だけなので、隔離 daemon (loopback の別 port) の webui からは届かない。検証では origin を足す中継を挟む
- glossary は全件には効かない (評価 §1.4: 訳語になる語、引用句を訳さず残す等の悪化もある)。効き方は実運用で見る

## 関連

- [DR-0023](./DR-0023-daemon-local-translation.md) — 翻訳比較タブと host 経路
- [findings 2026-11-06-plamo-translate-eval](../findings/2026-11-06-plamo-translate-eval.md) — 速度・品質・302・4,096 tokens の評価
