# DR-0041: webui から走行中のセッションの model / effort を request 単位で上書きする

- Status: Accepted (2026-10-26、kawaz 裁定) — ✅ 実装済み (protocol の `RequestOverrideSchema`・op `request_override`・`user_prompt` の `model` / `effort`・サイドカーの `request.override` と `prompt.send` の `override`・facts の `request_override`・push `request_overrides` / `request_override`、daemon の通しの保持と名乗り直しでの再送と変更の配送、module の関心 `request-override`、webui の状態行の picker・FAB の単発の選択・Status の行)。実機の確認は [findings 2026-10-26-request-override-verify](../findings/2026-10-26-request-override-verify.md)
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
- webui の TL 下の状態行 ([DR-0020](./DR-0020-session-status-tab.md) の Addendum 2026-07-18 の `ctx … · <model> · <effort> · …`) は model / effort を `once ?? session` の実効値で出し、セッションの元の値 (status snapshot の context) と違う field には印 (`⁺` と色) を付ける (上書きが元の値と同じなら印は付けない)。hover の説明に元の値と、どちらの上書きかを書く。model / effort の部分を押すと小さな picker が開き、通しを変更・解除できる (picker は元の値と違う field だけを選択済みで出す)。picker は effort を先に、すぐ選べる形で出し、model は一段奥 (小さな開閉の中) に置く。状態行の枠は FAB と重なる位置での誤クリックを避けるために押せなくしてあり、押せるのはこの 2 つと開いた picker だけにする
- FAB のプロンプトフォームに単発の選択 (既定は「上書きなし」) を置き、送信の `user_prompt` に乗せる。effort を先にすぐ選べる形で、model は一段奥に置く。送信が受け付けられたら「上書きなし」に戻し、届かなかった・未確認の時は文と同じく選択も残す
- Status タブに通しの picker と、単発が効いている間はその値の行を出す

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
10. **主役は effort**: model の変更も置くが、picker と FAB では effort を一等に、model を一段奥にする (§5、Consequences)

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
- FAB で単発を選んで送ったが文が turn を始めなかった時 (`/compact` のような組み込みの command 等) は、単発は次に始まる turn に結び付く
- model の `[1m]` は元の request の `e.model` に従う。`haiku[1m]` も request の `anthropic-beta` に `context-1m-…` が付いた (代役の API で確認)。1M の context を持たない model に付いた時に本物の API がどう答えるかは確かめていない
- prompt cache は model ごとなので、model の上書きを付け外しすると、その request で cache が効かなくなり、会話の全体を読み直す分だけ高くつく。このため model の切替は滅多に使わない操作とし、UI では effort を主、model を一段奥に置く (裁定 10)。effort は cache を切らないので気軽に変えてよい

## 関連

- [findings 2026-10-26-mods-command-run-builtin](../findings/2026-10-26-mods-command-run-builtin.md) — 差し替えの根拠の実測
- [DR-0035](./DR-0035-user-input-via-composer-fill.md) — webui → daemon → サイドカー → module の経路、facts
- [DR-0039](./DR-0039-all-mods-and-typed-tools.md) — module の関心の分け方と `bus` の登録
- [DR-0040](./DR-0040-permit-request-tool.md) — 購読の時の全件と 1 件ずつの push の流儀
- [DR-0020](./DR-0020-session-status-tab.md) — Status タブと TL 下の状態行
- [DR-0018](./DR-0018-session-launcher.md) — model / effort の語彙
