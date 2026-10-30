# DR-0041: webui から走行中のセッションの model / effort を request 単位で上書きする

- Status: Accepted (2026-10-26、kawaz 裁定) — ✅ 実装済み (protocol の `RequestOverrideSchema`・op `request_override`・`user_prompt` の `model` / `effort`・サイドカーの `request.override` と `prompt.send` の `override`・facts の `request_override`・push `request_overrides` / `request_override`、daemon の通しの保持と名乗り直しでの再送と変更の配送、module の関心 `request-override`、§6 の select: サイドカーの `request.override` の `clear_once`、webui の FAB の effort の select・Status タブと状態行の通しの select と [適用])。実機の確認は [findings 2026-10-26-request-override-verify](../findings/2026-10-26-request-override-verify.md) と [findings 2026-10-28-dr-0041-ui-verify](../findings/2026-10-28-dr-0041-ui-verify.md)
- Date: 2026-10-26

## Context

走行中のセッションの effort や model を、人が webui から変えたい場面がある。例: 何気ない一言を高い effort で投げてしまい、tool の連鎖が走り出した時に、咄嗟に low に落として次の request から軽くしたい。

Claude Code の組み込みの `/model` / `/effort` は使えない。[findings 2026-10-26-mods-command-run-builtin](../findings/2026-10-26-mods-command-run-builtin.md) の実測 (2.1.310):

- `$.command.run({ command: 'model' | 'effort', args })` で組み込みの切替は走るが、人が引数付きで打った時と同じく**既定として settings.json に保存される**。そのセッションだけの一時的な変更にならず、以後に起動する全セッションの既定が変わる
- `config.set` を deny して保存だけを止める形は、切替ごと取り消される
- `turn.step` の hook で `next({ ...e, model, effort })` と差し替えると、その request の `model` と `output_config.effort` が変わり、settings にも `/model` の状態にも影響しない。ただし `$.session.model()`、`/model` の picker、`turn.step` の `e.model` / `e.effort` は差し替える前の元の値のまま

kawaz 2026-10-26 の裁定 (下の「裁定」の節にまとめた) で、上書きを 2 つ持つ。

- **通しの上書き** (session override): セッション単位で持ち、リアルタイムに変更・解除できる。effort と model はそれぞれ任意
- **単発の上書き** (one-shot override): プロンプト送信 1 回分。送信に乗って一緒に届き、その turn の終わりまで効く。単発が通しに勝つ

主役は effort で、気軽に変えるもの。model の切替も置くが、prompt cache が効かなくなって高くつくので滅多に使わない (Consequences)。

## Decision

### 1. 差し替えは module の main thread の `turn.step` で行う

- hooks module の関心 `request-override` が、通しの上書き (人が設定した field) と単発の上書きを持つ
- 通しの設定されていない field は、セッション自身の値 (model は `$.session.model()`、effort は `turn.step` の差し替える前の `e.effort`) に従う。通しはセッションの元の値から始まり、端末で打った `/model` / `/effort` もそのまま効く。単発は空から始まる
- main thread の `turn.step` の hook で、field ごとに `単発 ?? 通し ?? 元の値` の順に `model` / `effort` を決め、上書きのある field だけを差し替えて `next` に渡す。上書きの無い request は受け取ったまま渡す
- subagent / teammate の request (`e.agentId` がある `turn.step`) は受け取ったまま渡す。subagent は model / effort を明記して起動するもので、main とは独立に決まる
- `$.command.run` で組み込みの `/model` / `/effort` を呼ぶ形は使わない (Context のとおり既定として保存される)

### 2. 値の語彙

- effort は `low` / `medium` / `high` / `xhigh` / `max`、model は `fable` / `opus` / `sonnet` / `haiku`。launch の picklist (`LaunchEffortSchema` / `LaunchModelSchema`、[DR-0018](./DR-0018-session-launcher.md) §3) と同じ語彙で、protocol の `RequestOverrideSchema` が持つ
- model は family の別名のまま engine に渡し、その request の `e.model` が `[1m]` で終わる時だけ `[1m]` を付ける (例: `e.model` が `claude-opus-5-5[1m]` の request を sonnet にすると `sonnet[1m]`)。別名から具体的な model id への解決は engine に任せる (`sonnet[1m]` は request の `model: claude-sonnet-5-5` と `anthropic-beta` の `context-1m-…` になった。2.1.310、代役の API で確認)。module が `claude-sonnet-5-5` のような id を表で持つと、新しい版が出るたびに古くなり、環境変数で別名の行き先を変えている環境 (`ANTHROPIC_DEFAULT_*_MODEL`) とも食い違う
- 合わない値は daemon が `invalid_args` で断る (wire の request のスキーマで読む)

### 3. 通しの上書きの経路

webui (user role) → daemon の op `request_override` → daemon が保持 → そのセッションの生きている全 run の module にサイドカーの依頼 `request.override` → module。

- op は通しだけを変える `request_override { session_id, model?, effort? }`。各 field は、無ければ今のまま、`null` なら解除、値ならその値にする (JSON Merge Patch と同じ読み)。user role だけが送れる (人の操作であり、セッションが自分や他のセッションの model を変える口にしない)
- daemon は通し (人が設定した field) を session id ごとにメモリに持ち、変えた後の全体を `request.override` で送る。module は通しを置き換え、単発のうち通しで変わった field も更新する (単発からその field を外し、通しの値が効くようにする)。通しの変更は単発も更新するので、単発が効いている最中でも次の request から反映される
- 応答は module に届いたか (`delivery`): `applied` (1 つ以上の run の module が適用した)、`unconfirmed` (書いたが答えが無い)、`no_module` (生きている run が無い)。prompt と違って二重に入る害が無いので、run は全部に同時に送る
- run のサイドカーが名乗った時 (`sidecar_hello`) に、daemon はそのセッションの通しを持っていればその run に送り直す。restart で上がり直した module や、daemon より後に起動した run にも意図が残る。daemon が持つのは人が設定した field で、変更のイベント (§5) が運ぶ実効値は持たない。実効値にはセッション自身の値 (`claude-opus-5-5[1m]` 等) が混ざるので、それを設定として送り直すと、送り直した先で未設定の field が元の値に従わなくなり (端末の `/model` / `/effort` が効かなくなる)、launch の語彙に無い model id はサイドカーのスキーマで断られる。設定した field だけを送れば、module は元の値を重ねて同じ実効値を作り直す
- daemon が通しを消すのは、明示の解除 (両 field を `null`) か daemon の再起動だけ。セッションの終了では消さない (restart はセッションを一度終わらせてから同じ id で再開する)
- module は session id が変わった時 (`/clear` / `/resume`) に通しと単発を捨てる。daemon は session id ごとに持つので、新しい id では上書きが無い状態に揃う

### 4. 単発の上書きの経路と寿命

webui → daemon の op `user_prompt` (`model?` / `effort?`) → サイドカーの依頼 `prompt.send` (`override?`) → module。単発は常にプロンプトと一緒に届き、プロンプトが入った時だけ効く。

- module は `prompt.send` の上書きを、fill した文の受け付けを待つ間 (`awaiting`) に一緒に持つ
- composer から来たその文の `prompt.submit` の**前** (`next` を呼ぶ前) に単発を有効にする。`prompt.submit` の `next` は turn が始まった時点で resolve するので (reference `claude-mods/events`)、resolve の後では最初の request に間に合わないことがある。`prompt.submit` が `drop` で終わった時は、まだ request に載っていなければ取り消す
- 有効になった単発は、その後の main thread の最初の `turn.start` か `turn.step` でその turn に結び付き、その turn の main thread の `turn.complete` で消える
  - idle で送った時: 送った文の turn の最初の request から、その turn の終わりまで
  - turn の実行中に送った時: queue された prompt は別の turn にならず、実行中の turn の次の request に入る (2.1.299 実測、reference `claude-mods/events`)。単発もその次の request から、実行中の turn の終わりまで効く
  - 実行中の turn が、送った後に request をせずに終わった時は、その turn には結び付かず、queue された prompt で始まる次の turn に結び付く
- 同じ field では単発が通しに勝つ。field が違えば両方が効く (単発で effort、通しで model 等)
- 単発が効いている間に、上書きを付けた次の送信が受け付けられると、新しい方に置き換わる

### 5. 変更のイベントと表示

engine 側の表示 (`/model` の picker、`$.session.model()`) は変わらないので、ccmsg が実効値を出す。

- module は facts ([DR-0035](./DR-0035-user-input-via-composer-fill.md) §3) に、上書きが main thread の request に載せる値 (`request_override: { session, once }`、各 `{ model, effort }`) を付けて送る。`session` は通しの field をセッション自身の値に重ねたもの (model はセッションの綴りのまま `[1m]` 付き、人が設定すると family)、`once` は単発の値で、無い field は `null`。上書きでこの値が変わらない時は送らない。facts の `model` / `effort` はセッション自身の値のまま
- daemon は facts を受けるたびに、前に受けた値と比べ、変わった上書きごとに `ev: "request_override" { session_id, target, model, effort }` を全 user role の購読者 (webui のタブ) に配る。変わらない時は配らない。値が変わる契機は、通しの op、module の起動 (セッションの元の値で通しが決まった時)、端末で打った `/model` / `/effort` (元の値が変わった時)、単発の始まり (送信に付いた単発が有効になった時)、単発が `turn.complete` で消えた時 (`target: "once"`、値は `null`)
- 購読した時に全セッションの値を `ev: "request_overrides"` で送る (空でも送る。再起動した daemon に繋ぎ直したタブが古い値を捨てられるように。say / 許可依頼と同じ流儀)。webui はこの 2 つの push だけで状態を持つので、複数のタブ・デバイスで同じ表示になる
- webui の TL 下の状態行 ([DR-0020](./DR-0020-session-status-tab.md) の Addendum 2026-07-18 の `<率>[<window>] / <model> / <effort> / …`) は model / effort を `once ?? session` の実効値で出し、セッションの元の値と違う field には印 (`⁺` と色) を付ける (上書きが元の値と同じなら印は付けない)。上書きが効いていない field は、request が実際に走った値 (status snapshot の context の `model` / `effort`。`model` は transcript の応答した model の実 ID で、上書きで走った応答ならその model) を出す。hover の説明に元の値と、どちらの上書きかを書く。model / effort の部分を押すと、その値の位置がその field の通しの選択 (§6.4) の select になる。状態行の枠は FAB と重なる位置での誤クリックを避けるために押せなくしてあり、押せるのはこの 2 つの値と、そこに出る select・[適用] だけにする
- 印と §6 の 🏛️・default の比べる相手の「セッションの元の値」は、module の facts の値 (model は `$.session.model()`、effort は差し替える前の `turn.step` の `e.effort`) で、daemon が status snapshot の context に `engine: { model?, effort? }` として載せる。transcript の行は上書きで走った実効値を持つので、元の値には使わない。module の facts が無い間 (module が無い、読み直した直後) は `engine` が無く、比べる相手が分からないので、上書きの値は元の値と違うとして扱い、§6 の 🏛️ は出さない
- FAB のプロンプトフォーム、Status タブと状態行の選択は §6

### 6. FAB、Status タブと状態行の選択

FAB、Status タブ、状態行 (§5) は、どれも 1 つの field を 1 つのネイティブ `<select>` (`<optgroup>` で群に分ける) で選ぶ。

- 静止している間は select を見せず、畳んだ表示の値 (§6.1、`low` / `⏱️high` / `📌high`) を押せると分かる見た目のテキスト (点線の下線) で出す。押すとその場で select を描いて focus し、`showPicker()` で一覧を開く (`showPicker` が無い・断られたブラウザでは focus した select が残る)。option を選ぶ、focus が外れる、Esc のどれかでテキストに戻る (選んだ時と Esc の時はテキストに focus を戻す)
- 未送信・未適用の選択がある間は、テキストが選んだ option の値を出す (Status タブと状態行は、その横に [適用])

#### 6.1 印と選択

選択肢と畳んだ表示は、値の前に印を付ける。印はその値が何であるかのラベルで、選んだ時の意味は選択肢ごとに決まる。

| 印 | 印が表すもの | その選択肢を選んだ時の意味 |
|---|---|---|
| (無印) | 今の実効値 | 何もしない。ラベルは今の実効値 (`単発 ?? 通し ?? 元` の値に、効いている層の印を付けたもの) |
| ⏱️ | 単発 (once) の値 | これから送る turn の間だけ、その値にする (§4) |
| 📌 | 通し (session) の値 | turn が終わっても残る値にする (§3) |
| 🏛️ | その値がセッション自身の値 (engine の値) であること | その field の単発と通しを両方リセットする |

- 🏛️ は操作の種類を表す印ではない。🏛️ の付いた選択肢を選ぶ操作が「両方のリセット」で、その結果 field はセッション自身の値に戻る

- 畳んだ表示は今効いている層と値を出す。上書きが無ければ `low` のように値だけ、単発が効いていれば `⏱️high`、通しが効いていれば `📌high`。通しの値がセッション自身の値と同じ時は上書きが無い時と同じく値だけにする (§5 の印と同じ判定)。この表示は default の群の option のラベルで、default 以外の option を選んで適用する前の間は、畳んだ表示はネイティブ `<select>` のとおり選んだ option になる
- 🏛️ は通しの群の中で、セッション自身の値の位置に 📌 の代わりに出る。セッション自身の値と同じ値を 📌 で選ぶ席は無い
- セッション自身の値 (§5 の `engine`) が分からない時 (module の facts が無い、effort をまだ知らない) と、語彙 (§2) に無い時 (model の family が別名の外) は 🏛️ を出さず、全部の値を 📌 で出す
- 上書きが効いていない時の default のラベルはセッション自身の値 (`engine`、model は `claude-` を落とした綴り)。`engine` が無い間は request が実際に走った値 (context の `model` / `effort`)

#### 6.2 select の中身

群は先頭から default (無印 1 つ)、turn (⏱️)、session (📌 と 🏛️) の順で、各群の中は launch の語彙の順 (§2)。fable / low のセッションで上書きが無い時の effort の例:

```
-- default --
low
-- turn --
⏱️low ⏱️medium ⏱️high ⏱️xhigh ⏱️max
-- session --
🏛️low 📌medium 📌high 📌xhigh 📌max
```

- turn 群はセッション自身の値も ⏱️ で並べる (通しが効いている時に、この turn だけ元の値で送るため)
- model の select も同じ構成で、値は model の語彙 (`fable` / `opus` / `sonnet` / `haiku`)。🏛️ の位置は、セッション自身の model (§5 の `engine.model`、`claude-fable-5-1` や `fable[1m]`) から family を切り出して語彙と照合して決める。model の上書きで走った応答の後も、🏛️ はセッション自身の family の位置に残る

#### 6.3 FAB (SessionInputComposer)

- effort の select だけを置く。model は FAB では変えない (model の変更は Status タブと状態行で行う。Consequences の prompt cache)
- effort の select は送信ボタンの左隣、送信ボタンと同じ行に置き、それだけで 1 行を使わない。`request_override` の返事の理由は、出す時だけその行の上に出す
- 群は default / turn / session の 3 つ
- 送信が適用を兼ねる。選んだだけでは何も送らず、プロンプトの送信の時に送る
  - ⏱️: 送信の `user_prompt` の `effort` に乗せる (§4)
  - 📌: 送信の時に `request_override { effort: <値> }` を送り、続けて `user_prompt` を送る
  - 🏛️ の選択肢: 送信の時に effort の単発と通しの両方のリセット (§6.5) を送り、続けて `user_prompt` を送る
  - 📌 / 🏛️ の `user_prompt` は `request_override` の返事を待ってから送る (文の turn の最初の request に通しが間に合うように)。通しは送信と独立に残るので、`user_prompt` が届かなくても通しの変更はそのまま残る。`request_override` の返事が `applied` 以外の時は、その理由を FAB に出し、`user_prompt` はそのまま送る
- 送信が受け付けられたら default に戻す。届かなかった・未確認の時は文と同じく選択も残す

#### 6.4 Status タブと状態行

- Status タブの OVERRIDE 行と状態行 (§5) の model / effort は、1 つの field の select と [適用] を同じ部品で出す。Status タブは effort と model を 1 つずつ並べ (effort が先)、状態行は model と effort の値の位置にそれぞれ置く
- 状態行の静止時のテキストは §5 の状態行の表示 (`low⁺` 等) で、押すとその位置でその field の select になる。default 以外を選んでいる間は、選んだ option のテキストと [適用] を出す。select・[適用]・返事の理由が出ている間は、状態行を省略記号で切らずに折り返す。状態行は常に画面にある要約なので、返事の理由は 4 秒で消す (TL の「中断しました」と同じ。断られた時の選択と [適用] は残る)。Status タブの理由は次に選ぶまで残す
- 群は default と session (📌 と 🏛️) の 2 つ。turn 群は出さない。単発が効いている間は、畳んだ表示 (default) が `⏱️high` のようにそれを示す (単発の値を別の行には出さない)
- select を default 以外に変えた時だけ、その横に [適用] ボタンを出す。押したら `request_override` を送る (📌 の選択肢は値、🏛️ の選択肢は §6.5 のリセット)。上書きが何も無い時に 🏛️ を選んでも [適用] を出し、押せば同じく送る (送っても何も変わらない)。返事の `delivery` が `applied` 以外の時は、その理由と次の手を横に出す
- 返事が来たら、select は default に戻り、畳んだ表示は変更のイベント (§5) で届いた値で出し直す。断られた・送れなかった時は選択を残し、その理由を横に出す

#### 6.5 🏛️ の選択肢を選んだ時のリセットの流れ

1. webui が `request_override` で、その field を `null` にする (例: `{ effort: null }`)
2. daemon は通しのその field を消して module に送る (§3)
3. module は通しのその field を外し、単発のその field も外す。通しのその field が既に無かった時も、単発のその field を外す
4. 実効値が動いたので module が facts を送り、daemon は変わった上書きごとに `ev: "request_override"` を全 webui に配る (§5)。通しは `target: "session"` でセッション自身の値、単発は `target: "once"` で `null`
5. webui は単発が無く、通しがセッション自身の値と同じなので、畳んだ表示を `🏛️low` ではなく `low` にする

#### 6.6 実装への影響

- protocol
  - webui → daemon の op は増やさない。🏛️ の選択肢を選んだ時のリセットは既存の `request_override` の `null` で表す
  - サイドカーの `request.override` の args は、通しの全体に `clear_once` (op の patch で名指しされた field の列、`null` を含む) を足したもの。通しの全体だけでは「通しのその field は既に無いが単発のその field を外す」を module に伝えられないため。名乗り直しの再送 (§3) はこの欄を付けない。この欄を知らない module は欄を読み捨てる (通しの値が変わった field だけを単発から外す)
- module (`hooks/request-override.ts` の `requestOverrideSet`)
  - 単発から外す field を、通しの値が変わった field に加えて、`clear_once` で名指しされた field にも広げる
- daemon (`packages/daemon/src/request-override.ts` の `namedFields`、server の `request_override`)
  - op の patch で名指しされた field を `clear_once` に入れて `request.override` で送る (名指しが無ければ欄を付けない)
- protocol / daemon (§5 の元の値)
  - `SessionContextUsageSchema` の `engine: { model?, effort? }`。daemon の `contextWithFacts` が module の facts の `model` / `effort` を入れ、facts に無い field は省き、どちらも無ければ `engine` ごと省く。context の `model` は transcript の応答した model のまま
- webui
  - `request-override-view.ts` の `overrideGroups`: field ごとの select の群と option (ラベルと、選んだ時の意味) を返す純関数。default のラベルは状態行の印と同じ判定 (`requestValueViews` の `by`)
  - `RequestOverridePicker.tsx`: `OverrideSelect` (1 つの field。静止時はテキストの button、押すと select を描いて focus と `showPicker()`)、`SessionOverrideField` (1 つの field の select と [適用]。状態行では静止時に状態行の表示を出す)、`SessionOverrideEditor` (Status タブの effort と model)、`ContextLine` (状態行。model と effort の位置に `SessionOverrideField`)
  - `SessionInputComposer.tsx`: effort の 1 つの select。選んだ option を持ち、送信の時に 📌 / 🏛️ なら `ws.requestOverride` の返事を待ってから `ws.userPrompt` を送る
  - 状態行 (§5) の表示と、`ev: "request_override"` / `ev: "request_overrides"` の受け方は変えない

## 裁定 (kawaz 2026-10-26)

1. **通しの上書きを daemon が保持する**: 採用。session id ごとにメモリに持ち、run が名乗った時に送り直す (§3)。`--resume` で起動し直した run に再送されて効いた (findings)
2. **subagent には効かせない**: kawaz の運用では subagent は model / effort を明記して起動するので main とは独立で、効かせる方が誤り。`agentId` 付きの `turn.step` は素通しにする (§1)
3. **変更の op は通しだけ、単発はプロンプト送信に乗せる**: `request_override { session_id, model?, effort? }` (§3) と `user_prompt` の `model` / `effort` (§4)。単発の寿命はその turn の終わり (`turn.complete`) まで
4. **通しの変更は単発も更新する**: 単発が効いている最中でも、通しの変更が次の request から反映される (§3)
5. **変更は daemon がイベントで全タブに配る**: 実効値が変わった時だけ配り、webui はそのイベントで状態を持つ (§5)
6. **実効値の表示と印**: 採用 (状態行の押せる部分を作る例外を含む)。印は「実効値がセッションの元の値と違う時」に出す (§5)
7. **model の上書きと `[1m]` の付け方**: 採用 (§2)
8. **`/clear` / `/resume` で上書きを捨てる**: 採用 (§3)
9. **通しの初期値はセッションの元の値**: 設定されていない field はセッション自身の値に従う (端末の `/model` / `/effort` も効く) (§1)
10. **主役は effort**: model の変更も置くが、状態行の picker では effort を一等に、model を一段奥にする (§5、Consequences)

## 裁定 (kawaz 2026-10-28)

11. **選択の表示は今効いている層と値**: 畳んだ表示は印 (⏱️ 単発、📌 通し) と値で、上書きが無ければ値だけ。選択肢は default / turn / session の群に分けたネイティブ `<select>` (§6.1、§6.2)
12. **🏛️ は engine の値のラベル、選ぶと単発と通しの両方をリセットする**: 🏛️ はその値がセッション自身の値であることを表す印で、通しの群のその値の位置に出る。その選択肢を選ぶ操作は、その field の単発と通しの両方のリセット。変更のイベントを受けた webui は値だけの表示に戻る (§6.5)
13. **FAB は effort だけ**: FAB では送信が適用を兼ねる (§6.3)
14. **Status タブは model と effort を同じ形の select で出す**: 群は session (🏛️ を含む) だけで、変えた時だけ出る [適用] で通しの変更を送る (§6.4)
15. **状態行の選択も Status タブと同じ select にする**: 同じ部品を状態行と Status タブの両方で使う。状態行で model を一段奥 (開閉の中) に置く形 (裁定 10) は、これに置き換わる。単発の値を別に出す Status タブの行は無くし、畳んだ表示 (`⏱️high`) で示す (§5、§6.4)
16. **FAB の 📌 / 🏛️ は `request_override` → `user_prompt` の順に送る**: 通しは送信と独立に残るので、`user_prompt` が届かなくても通しだけが変わるのは許容する (§6.3)
17. **セッション自身の値が語彙に無い時は 🏛️ を出さない**: 全部の値を 📌 で出す (§6.1)。上書きが何も無い時に 🏛️ を選んでも [適用] を出し、そのまま送ってよい (冪等、§6.4)
18. **model の select の候補は別名、🏛️ の位置は engine の model の family**: 候補は launch の語彙 (`fable` / `opus` / `sonnet` / `haiku`)、🏛️ は engine の model (`fable-5-1`) から切り出した family の位置 (§6.2)。engine の値は module の facts から取り、状態行の表示 (request が実際に走った値) とは分ける (§5)
19. **静止時は select を見せない**: FAB、状態行、Status タブのどれも、静止時は押せると分かるテキストで畳んだ表示の値を出し、押した間だけ select にする。選択の確定・blur・Esc でテキストに戻る。select の中身と、FAB は送信が適用・Status と状態行は変えた時だけ [適用] の規則は変えない (§6)

## 裁定 (kawaz 2026-10-30)

20. **状態行の値はその位置で select になる**: 状態行の model / effort を押すと、その値の位置がその field の select になる。別の行・パネル・閉じるボタンは出さない (§5、§6.4)
21. **FAB の effort は送信ボタンの左**: effort の select に 1 行を使わず、送信ボタンと同じ行のその左隣に置く (§6.3)

## Alternatives Considered

| 案 | 不採用理由 |
|---|---|
| `$.command.run('model' / 'effort')` で組み込みの切替を呼ぶ | 既定として settings.json に保存され、以後に起動する全セッションに効く (findings の実測) |
| `config.set` を deny して保存だけを止める | 切替ごと取り消され、model が変わらない。`/effort` は `config.set` を起こさないので止められない (findings の実測) |
| engine の表示 (`/model` の picker 等) に合わせる | mods から engine の model / effort の状態を session 限りで変える口が無い。表示は ccmsg の実効値で出す |
| module が model の別名を具体的な id に写す表を持つ | 版が出るたびに古くなり、別名の行き先を環境変数で変えた環境と食い違う。解決は engine に任せる |
| 通しの上書きを module だけが持つ (daemon は中継だけ) | restart で module が上がり直すと意図が消える。daemon が持てば名乗り直しで戻せる |
| 単発を別の op にする (`request_override` の `target: "once"` で送信の前に投げる) | プロンプトと分かれると、単発を投げたが送らなかった状態ができ、意図しない次の turn に効く。プロンプトに乗せれば、プロンプトが入った時だけ効く (kawaz 裁定) |
| webui が status snapshot の上書きの欄で状態を持つ | snapshot はそのセッションの Status / Timeline を開いているタブにしか来ない。変更のイベントを全タブに配れば、どのタブ・デバイスでも同じ表示になる (kawaz 裁定) |
| 上書きを subagent の request にも効かせる | subagent は model / effort を明記して起動するので、main の上書きで変えるのは誤り (kawaz 裁定) |

## Consequences

- 上書きは engine の状態を変えないので、ccmsg の外 (端末の `/model`、Claude Code の status line) からは見えない。人が端末で `/model` を打つと、その切替は元の値を変え、通しの設定されていない field はそれに従う。設定された field は上書きが勝つ
- 上書きを知らない (古い) module は `request.override` に答えない (`unconfirmed`)。facts に `request_override` が無いので、webui には変更のイベントが来ず、状態行に印も付かない。セッションを再起動すると新しい module が載る
- Claude Code 2.1.312 では、セッションで最初に tool を使う turn の中の tool_result を運ぶ request に、`turn.step` の hook が返した effort が効かず、その turn の前の request の値で送られる (2 回目以降の turn では効く。[findings 2026-10-28-dr-0041-ui-verify](../findings/2026-10-28-dr-0041-ui-verify.md))。その turn の途中で通しを変えたり 🏛️ で外したりしても、その request は前の値のままになる。hook の返り値では直せないので、ccmsg 側では手当てしていない
- FAB で単発を選んで送ったが文が turn を始めなかった時 (`/compact` のような組み込みの command 等) は、単発は次に始まる turn に結び付く
- model の `[1m]` は元の request の `e.model` に従う。`haiku[1m]` も request の `anthropic-beta` に `context-1m-…` が付いた (代役の API で確認)。1M の context を持たない model に付いた時に本物の API がどう答えるかは確かめていない
- prompt cache は model ごとなので、model の上書きを付け外しすると、その request で cache が効かなくなり、会話の全体を読み直す分だけ高くつく。このため model の切替は滅多に使わない操作とし、UI では effort を先に置き、FAB には model を置かない (裁定 10、13)。effort は cache を切らないので気軽に変えてよい

## 関連

- [findings 2026-10-26-mods-command-run-builtin](../findings/2026-10-26-mods-command-run-builtin.md) — 差し替えの根拠の実測
- [DR-0035](./DR-0035-user-input-via-composer-fill.md) — webui → daemon → サイドカー → module の経路、facts
- [DR-0039](./DR-0039-all-mods-and-typed-tools.md) — module の関心の分け方と `bus` の登録
- [DR-0040](./DR-0040-permit-request-tool.md) — 購読の時の全件と 1 件ずつの push の流儀
- [DR-0020](./DR-0020-session-status-tab.md) — Status タブと TL 下の状態行
- [DR-0018](./DR-0018-session-launcher.md) — model / effort の語彙
