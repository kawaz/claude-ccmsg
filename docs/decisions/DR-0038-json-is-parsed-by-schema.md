# DR-0038: データの形はスキーマで定義して型を導き、外から来る JSON は境界でスキーマに通す (valibot)。`as` と `any` は使わない

- Status: Accepted (2026-10-09、kawaz 裁定) — 🟡 部分実装 (wire の依頼・応答・イベント、サイドカー、hooks module、session_launch の params は済み。Claude Code の transcript の行・外部コマンド・ファイル・localStorage・room の jsonl が残り)
- Date: 2026-10-09

## Context

本番コードの `JSON.parse` は 65 か所あり、パースした値の扱いがばらばらだった (2026-10-09 の棚卸し):

- 直後に `as` でドメインの型を名乗る (中身を確かめない): 14 件。daemon の依頼の入口 (`JSON.parse(line) as Request`、58 の op の信頼境界)、CLI の応答 (`as T`)、room の jsonl (`as StorageEvent`)、`claude agents --json` (`as AgentInfo`) など
- 暗黙の any: webui の WebSocket の受信
- `unknown` で受けて手書きの型ガードで部分的に読む: 48 件。そのうち約 14 件は `unknown` / `Record<string, unknown>` のまま関数の境界を越えて内側へ流れる (transcript の行を辿る daemon の fold 群、webui の transcript-model)
- `isRecord` 相当のヘルパが 11 か所に重複し、失敗の表し方も 7 通りある

型の付いていない値が内側まで流れると、使う場所ごとに検査が継ぎ足され、検査の漏れが実害になる (例: hooks module の `String(request.v)` が throw し、それを try/catch で包み、さらにフォールバックを重ねた)。

kawaz 2026-10-09: 「全てちゃんと型ガードすれば良いだけ、なんで unknown とか使いたがるんだよ。型のない JSON なんてそもそも扱う経路ゼロにしてください」「validate するな parse しろ、ってのは JSON.parse じゃなく Validator で parse しろって意味。valibot とか色々バリデーションライブラリあるでしょ。モダンでいい感じのを選択してそれを使って基本的に全てスキーマ定義するべき」。

## Decision

### 1. 外から来る JSON は、境界でスキーマに通して型を付ける

- プロセスの外から来る JSON (socket の 1 行、HTTP / WebSocket、外部コマンドの出力、ファイル、transcript の jsonl、localStorage、hook の stdin) は、受け取ったその場でスキーマに通し、**型の付いた値か、型の付いた失敗**にする。境界より内側に `unknown` / `any` / `Record<string, unknown>` / 検証なしの `as` を持ち込まない
- 型はスキーマから導く (`v.InferOutput<typeof Schema>`)。型とスキーマを別々に書かない
- 失敗は throw せず値で返す (`v.safeParse`)。失敗の扱い (拒否して理由を返す、その行だけ捨てて続ける、表示を劣化させる) は境界ごとに決めるが、失敗を表す型は 1 つにそろえる
- `catch` で受ける値は TypeScript の仕様で `unknown` になる。ここは `Error` かどうかで分けるだけにし、任意の値を文字列にしない

### 2. スキーマのライブラリは valibot

- valibot (1.x) を使う。スキーマから型を導け、`safeParse` で失敗を値として返せる
- 選んだ理由: 部品を関数として import する作りで、使った部品だけが bundle に入る (webui のバンドルに効く)。依存を持たない。Standard Schema に対応している
- 比べた候補: zod 4 (広く使われ機能も多いが、同じ用途では bundle が大きくなりやすい)、arktype (型の書き味は良いが、実行時のサイズと文字列 DSL の読みやすさで valibot を取った)

### 3. スキーマの置き場

- プロセスをまたいで共有する形 (wire の Request / Response / StreamEvent、サイドカーの依頼と返事、Claude Code の transcript の行、`claude agents --json`、Claude の `sessions/<pid>.json`、agent の meta.json) は `packages/protocol` に置き、daemon・CLI・webui が同じスキーマを使う
- 1 つのパッケージだけが読む形 (設定ファイル、webui の localStorage 等) は、そのパッケージに置く
- Claude Code の transcript は外部仕様で形が変わっていくので、スキーマは使う field だけを定義し、知らない field は通す (strict にしない)。行が読めない時はその行だけ失敗として扱い、全体は止めない
  - 行・ブロック・attachment・道具は種類 (`type` / `name`) の variant で読む。Claude Code が増やす種類は、判別値を「既知の名前以外の string」に絞った Other として受け、失敗にしない (既知の種類で形が壊れた値は失敗にし、Other に吸わせない)。Other の残りの field は JsonValue で持つ
  - 必須にする field は、その種類の行が実機で必ず持つものだけにする (queue-operation に uuid は無く、metadata 系の行に timestamp は無い)
  - 行の一部だけを見る走査 (uuid・cwd・timestamp 等) は、行と同じ field のスキーマから組んだ投影で読む。投影は読む field 以外の不正で落ちない
  - 中身が別の所で決まる値 (`toolUseResult` は呼んだ道具で、tool_use の input は道具ごとに) は、行では JsonValue として持ち、道具と突き合わせる所で道具ごとのスキーマに通す。モデルが書いた input の不正でその行全体を失敗にしないため

### 4. hooks module

- `hooks/composer-fill.ts` は Claude Code の module loader に読まれ、実行時の import ができない。valibot と protocol のスキーマを使うために、module を 1 ファイルに bundle する手順を用意する (bundle の作り方と、配布物に含める方法は実装時に決める)

### 5. 型の付け方の水準: `as` と `any` は使わない

kawaz 2026-10-09: 「あらゆる箇所でまずスキーマとそこから型を作って signature も全て型付きで扱うべきで。as や any は禁止など。そのレベルを当たり前にしてください」。

- データの形はまずスキーマで定義し、型はそこから導く。関数の引数と戻り値は、すべて具体的な型で書く (`unknown` を受けて中で調べる関数を作らない)
- `as` による型の主張と `any` は使わない。`as const` だけは型を広げない用途なので使ってよい。型が合わない時は、主張で黙らせず、スキーマに通すか、型の設計を直す
- 非 null の主張 (`!`) も使わない。値が無い場合を型で表し、分岐で扱う
- `unknown` が現れてよいのは `catch` の束縛と、スキーマに通す直前の 1 か所 (境界) だけ
- これらは lint で機械的に検査する (oxlint の `typescript/no-explicit-any`、型の主張を禁じる規則、非 null の主張を禁じる規則。使える規則と設定は実装時に確かめる)。既存のコードの違反は、置き換えの段ごとに減らし、最後に lint を error にする

### 6. パースした値は加工せず、不変のデータとして扱う

kawaz 2026-10-09: 「immutable なデータオブジェクトであるべきでは?」 (外から来た値をふつうの object に入れて `params[name]` で引き、宣言の無い名前で prototype から継承した `constructor` を拾った不具合への指摘)。

kawaz 2026-10-09: 「validator は外部データを JSON.parse したら何もせずそのまま渡すもんだろう。あと fallback? デフォルト値が必要ならスキーマで定義すべき」。

- `JSON.parse` の出力は、何も加工せずにそのままスキーマに渡す。スキーマに通す前に形を変えない (entries に分解する、object を組み立て直す等をしない)
- スキーマの出力の型は不変にする。出力の型は `v.InferOutput` を深く readonly にしたもの (parse.ts の `Output<S>`) で書く。valibot の `v.readonly()` は pipe した 1 段しか readonly にせず、variant の option には pipe を付けられないので使わない。受け取った側は値を書き換えない
- 値を名前で引かない (`params[name]` のような、外から来た object を任意の名前で引く書き方をしない)。kawaz 2026-10-09:「そもそも params[name] なんてものが存在することがおかしい。params を validator にかけて型付きオブジェクトにして扱うべき」
- どの名前が来うるかが設定で決まる値 (例: session launcher のテンプレートが宣言する params) は、その宣言からスキーマを組み立てる (宣言された名前ごとの field を持つ `v.strictObject`。既定値は `v.optional(schema, default)`)。依頼はそのスキーマに通し、出力の型付きの値をそのまま使う。宣言に無い名前は strict で失敗になる
- 設定で宣言させる名前は、`__proto__` / `constructor` / `prototype` を名前の規則で禁じる (valibot の object 系のスキーマはこれらのキーを扱わないので、宣言できないようにしておく)。キーを落とさないための特別なスキーマは作らない
- 型に合わない値は、エラーで弾いて終わりにする。別の値に読み替えない (`v.fallback` で不正な値を `null` 等にしない)、失敗した入力を部分ごとに読み直して細かく分類しない、どんな入力でも何とか扱おうとする処理を足さない。kawaz 2026-10-09:「不整値はくだらないケアとかする以前にエラーで弾いて終わりで良い。クソみたいな万能ケアをしようとするな」
- 値が無い時の既定値が要るなら、スキーマで定義する (`v.optional(schema, default)`)

## Alternatives Considered

- 案 A: 手書きのパース関数 (`(raw: unknown) => Result<T>`) に統一する
  - 不採用理由: 型とパースの中身を別々に書くので、ずれる余地が残る。11 か所の `isRecord` の重複のように、書き手ごとの作法の差も消えない
- 案 B: `as` で型を付け、境界の検査を省く
  - 不採用理由: 型が嘘をつく。daemon の依頼の入口で、型の上は検証済みに見えて op ごとに typeof が継ぎ足される現状そのもの

## Consequences

- 依存に valibot が加わる
- 置き換えは入口の大きい順に進める: daemon の依頼の入口 → webui の WebSocket → CLI の応答 → Claude Code の transcript の行 → 外部コマンド・ファイル → localStorage → hooks module。room の jsonl は DR-0036 で書き込みが無くなるので、読み取り専用の閲覧に要る分だけ扱う
- lint で検査なしの `as` と `JSON.parse` の直接の利用を見張れるか (oxlint の規則) は実装時に確かめる

## 関連

- [DR-0035](./DR-0035-user-input-via-composer-fill.md) — hooks module とサイドカーの依頼・返事
- [DR-0036](./DR-0036-retire-rooms-for-p2p.md) — room の廃止 (room の jsonl の扱い)
