# DR-0041: webui から走行中のセッションの model / effort を request 単位で上書きする

- Status: Proposed (2026-10-26) — 実装済み (未 push)。下の「裁定待ち」の 6 点は統括の推しの形で実装してあり、kawaz の裁定で確定する。実機の確認は [findings 2026-10-26-request-override-verify](../findings/2026-10-26-request-override-verify.md)
- Date: 2026-10-26

## Context

走行中のセッションの effort や model を、人が webui から変えたい場面がある。例: 何気ない一言を高い effort で投げてしまい、tool の連鎖が走り出した時に、咄嗟に low に落として次の request から軽くしたい。

Claude Code の組み込みの `/model` / `/effort` は使えない。[findings 2026-10-26-mods-command-run-builtin](../findings/2026-10-26-mods-command-run-builtin.md) の実測 (2.1.310):

- `$.command.run({ command: 'model' | 'effort', args })` で組み込みの切替は走るが、人が引数付きで打った時と同じく**既定として settings.json に保存される**。そのセッションだけの一時的な変更にならず、以後に起動する全セッションの既定が変わる
- `config.set` を deny して保存だけを止める形は、切替ごと取り消される
- `turn.step` の hook で `next({ ...e, model, effort })` と差し替えると、その request の `model` と `output_config.effort` が変わり、settings にも `/model` の状態にも影響しない。`/clear` の後も module の変数は残る。ただし `$.session.model()`、`/model` の picker、`turn.step` の `e.model` / `e.effort` は差し替える前の元の値のまま

kawaz 2026-10-26 の裁定:

1. **通しの上書き** (session override): セッション単位で持ち、リアルタイムに変更・解除できる。effort と model はそれぞれ任意
2. **単発の上書き** (one-shot override): プロンプト送信 1 回分。そのサブミットから始まる turn の最初の request から `turn.complete` まで効き、終わると消える。同じ turn では単発が通しに勝つ
3. 用途の例は上の「咄嗟に low に落とす」(次の request から効く)

## Decision

### 1. 差し替えは module の `turn.step` で行う

- hooks module の新しい関心 `request-override` が、通しの上書きと単発の上書きを module の変数に持つ
- `turn.step` の hook で、field ごとに `単発 ?? 通し ?? 元の値` の順に `model` / `effort` を決め、上書きのある field だけを差し替えて `next` に渡す。上書きの無い request は受け取ったまま渡す
- subagent / teammate の request (`e.agentId` がある `turn.step`) にも効かせる。止めたい tool の連鎖は subagent を含むため
- `$.command.run` で組み込みの `/model` / `/effort` を呼ぶ形は使わない (Context のとおり既定として保存される)

### 2. 値の語彙

- effort は `low` / `medium` / `high` / `xhigh` / `max`、model は `fable` / `opus` / `sonnet` / `haiku`。launch の picklist (`LaunchEffortSchema` / `LaunchModelSchema`、[DR-0018](./DR-0018-session-launcher.md) §3) と同じ語彙で、どちらも protocol の `RequestOverrideSchema` が持つ
- model は family の別名のまま engine に渡し、その request の `e.model` が `[1m]` で終わる時だけ `[1m]` を付ける (例: `e.model` が `claude-opus-5-5[1m]` の request を sonnet にすると `sonnet[1m]`)。別名から具体的な model id への解決は engine に任せる (`sonnet[1m]` は request の `model: claude-sonnet-5-5` と `anthropic-beta` の `context-1m-…` になった。2.1.310、代役の API で確認)。module が `claude-sonnet-5-5` のような id を表で持つと、新しい版が出るたびに古くなり、環境変数で別名の行き先を変えている環境 (`ANTHROPIC_DEFAULT_*_MODEL`) とも食い違う
- 合わない値は daemon が `invalid_args` で断る (wire の request のスキーマで読む)

### 3. 通しの上書きの経路

webui (user role) → daemon の op `session_override` → daemon が保持 → そのセッションの生きている run の module にサイドカーの依頼 `session.override` → module の変数。

- op `session_override` は `{ session_id, model?, effort? }`。各 field は、無ければ今のまま、`null` なら解除、値ならその値にする (JSON Merge Patch と同じ読み)。user role だけが送れる (人の操作であり、セッションが自分や他のセッションの model を変える口にしない)
- daemon は通しの上書きを session id ごとにメモリに持ち、変更を受けたら、そのセッションの生きている全 run の module に `session.override` (上書きの全体、`{}` は上書き無し) を送る。prompt と違って二重に入る害が無いので、run を 1 つずつ試す必要は無い
- 応答は、変更後に daemon が持つ上書きと、module に届いたか (`delivery`): `applied` (1 つ以上の run の module が適用した)、`unconfirmed` (書いたが答えが無い)、`no_module` (生きている run が無い)
- run のサイドカーが名乗った時 (`sidecar_hello`) に、daemon はそのセッションの上書きを持っていればその run に送り直す。restart で上がり直した module や、daemon より後に起動した run にも意図が残る
- daemon が上書きを消すのは、明示の解除 (両 field を `null`) か daemon の再起動だけ。セッションの終了では消さない (restart はセッションを一度終わらせてから同じ id で再開する)
- module は session id が変わった時 (`/clear` / `/resume`) に通しの上書きを捨てる。daemon は session id ごとに持つので、新しい id では上書きが無い状態に揃う

### 4. 単発の上書きの経路と寿命

webui → daemon の op `user_prompt` (`model?` / `effort?` を足す) → サイドカーの依頼 `prompt.send` (`override?` を足す) → module。

- module は `prompt.send` の上書きを、fill した文の受け付けを待つ間 (`awaiting`) に一緒に持つ
- composer から来たその文の `prompt.submit` の**前** (`next` を呼ぶ前) に単発の上書きを有効にする。`prompt.submit` の `next` は turn が始まった時点で resolve するので (reference `claude-mods/events`)、resolve の後では最初の request に間に合わないことがある。`prompt.submit` が `drop` で終わった時は、まだ request に載っていなければ取り消す
- 有効になった単発の上書きは、その後の main thread の最初の `turn.start` か `turn.step` でその turn に結び付き、その turn の main thread の `turn.complete` で消える
  - idle で送った時: 送った文の turn の最初の request から、その turn の終わりまで
  - turn の実行中に送った時: queue された prompt は別の turn にならず、実行中の turn の次の request に入る (2.1.299 実測、reference `claude-mods/events`)。単発の上書きもその次の request から、実行中の turn の終わりまで効く
  - 実行中の turn が、送った後に request をせずに終わった時は、その turn には結び付かず、queue された prompt で始まる次の turn に結び付く
- 単発の上書きは、それが有効な間の subagent の request にも効く (§1)
- 同じ field では単発が通しに勝つ。field が違えば両方が効く (単発で effort、通しで model 等)
- 単発の上書きが効いている間に、上書きを付けた次の送信が受け付けられると、新しい方に置き換わる

### 5. 表示

engine 側の表示 (`/model` の picker、`$.session.model()`) は変わらないので、ccmsg が実効値を出す。

- module は facts ([DR-0035](./DR-0035-user-input-via-composer-fill.md) §3) に今効いている上書き (`override: { session?, single? }`) を足し、変わるたびに送る。facts の `model` / `effort` は元の値のまま (`$.session.model()` と `turn.step` の差し替える前の `e.effort`)
- daemon は session status の snapshot に `request_override` (`held`: daemon が持つ通しの上書き、`session` / `single`: module が今効かせている上書き) を載せる。daemon が持つ上書きが変わった時も push する
- webui の TL 下の状態行 ([DR-0020](./DR-0020-session-status-tab.md) の Addendum 2026-07-18 の `ctx … · <model> · <effort> · …`) は model / effort を実効値で出し、上書きが効いている field には印 (`⁺` と色) を付ける。hover の説明に元の値と、どちらの上書きかを書く。model / effort の部分を押すと小さな picker が開き、通しの上書きを変更・解除できる。状態行の枠は FAB と重なる位置での誤クリックを避けるために押せなくしてあり、押せるのはこの 2 つと開いた picker だけにする
- FAB のプロンプトフォームに単発の上書きの選択 (model / effort、既定は「上書きなし」) を置く。送信が受け付けられたら「上書きなし」に戻す
- Status タブに通しの上書きの行を出す。daemon が持つ上書きと module が効かせている上書きが違う時 (module がまだ受け取っていない) は、その旨を添える

## 裁定待ち

どれも「推し」(統括の推しで、今の実装の形) と「代替」、実装と実測で分かったことを書く。実測は findings 2026-10-26-request-override-verify (2.1.310、代役の API)。

### 1. 通しの上書きを daemon が保持するか

- 推し: daemon が session id ごとにメモリに持ち、run のサイドカーが名乗った時に送り直す (§3)。消すのは明示の解除か daemon の再起動だけ
- 代替: module の変数だけに持ち、daemon は中継だけにする。daemon の状態は増えないが、restart や `--resume` で module が上がり直すと意図が消え、webui も今の値を module の facts からしか知れない
- 分かったこと: 上書きを持ったまま `--resume` で起動し直すと、名乗り直した run に `applied` で再送され、次の request が sonnet / medium になった。止めている最中に変えた時の応答は `unconfirmed` だったが、上書きは daemon に残って再送された

### 2. subagent / teammate の request にも効かせるか

- 推し: 効かせる (§1)。止めたい tool の連鎖は subagent を含むため
- 代替: main thread の request だけにする。subagent の model を agent 定義どおりに保てるが、subagent が回す高い effort の連鎖は止められない
- 分かったこと: 通しの sonnet / low が、Agent が起こした subagent の request にも載った。model の上書きは、subagent の agent 定義が決めた model も変える

### 3. 単発の上書きは prompt 送信に相乗りするか

- 推し: `user_prompt` に `model?` / `effort?` を足し、サイドカーの `prompt.send` の `override` で運ぶ。submit の前に有効にし、結び付いた turn の終わりで消す (§4)
- 代替: 単発用の op を別に設け、送信の前に送る。送信と上書きの組が 2 回の往復に分かれ、どちらかだけが届く場合を扱う必要が出る
- 分かったこと: 単発 haiku / max を付けた送信は、その turn の 1 つ目と tool の後の request が haiku / max になり、次の turn では消えた。webui の FAB からの送信でも同じだった。上書きを知らない古い module は `override` を黙って読み飛ばす (Consequences)

### 4. 実効値の表示と印

- 推し: 状態行の model / effort を実効値で出し、上書きの効いた field に `⁺` と警告色を付け、hover に元の値とどちらの上書きかを書く。model / effort を押すと picker が開く。状態行のパネルは FAB と重なる位置での誤クリックを避けるために押せなくしてあり (`pointer-events: none`)、押せるのはこの 2 つと開いた picker だけにする (この判断の例外)。FAB に単発の選択、Status タブに通しの上書きの行を出す (§5)
- 代替: (a) 状態行は元の値のまま、上書き中だけ別の行や印を足す。(b) 状態行は押せないままにし、変更は Status タブだけで行う (誤クリックの判断は崩れないが、咄嗟に落とすまでの手数が増える)
- 分かったこと: `… · low⁺ · …` と表示され、picker から変えた値が request に効いた。ただし webui の session_status の購読が読み込み直後に切れる既存の不具合があり、変えた結果は読み込み直すまで表示に出ない (issue `session-status-subscribe-dropped-on-load`)

### 5. model の上書きを含めるか、`[1m]` の付け方

- 推し: 含める。family の別名を engine に渡し、元の request の `e.model` に `[1m]` があれば付ける (§2)
- 代替: (a) effort だけにする。(b) module が別名を具体的な id に写す表を持つ (版が出るたびに古くなる)。(c) `[1m]` を付けない (長い会話で 200k を超えると request が通らない)
- 分かったこと: `sonnet[1m]` / `haiku[1m]` は engine が `claude-sonnet-5-5` / `claude-haiku-5-5` に解決し、`anthropic-beta` に `context-1m-…` が付いた。1M の context を持たない model に付いた時に本物の API がどう答えるかは確かめていない。model を付け外しすると prompt cache は効かない

### 6. `/clear` / `/resume` で通しの上書きを捨てるか

- 推し: 捨てる。module は session id が変わった時に上書きを捨て、daemon は新しい id に上書きを持たない (§3)
- 代替: 同じ run が仕える新しい id に引き継ぐ。daemon が run の仕えた id の対応 (`SidecarRuns` の served) をもとに移し替える。人から見ると同じ端末の続きなので意図に近いが、daemon の状態の移し替えが要る
- 分かったこと: 捨てる振る舞いは unit test でだけ確かめた (実機では未確認)

## Alternatives Considered

| 案 | 不採用理由 |
|---|---|
| `$.command.run('model' / 'effort')` で組み込みの切替を呼ぶ | 既定として settings.json に保存され、以後に起動する全セッションに効く (findings の実測) |
| `config.set` を deny して保存だけを止める | 切替ごと取り消され、model が変わらない。`/effort` は `config.set` を起こさないので止められない (findings の実測) |
| engine の表示 (`/model` の picker 等) に合わせる | mods から engine の model / effort の状態を session 限りで変える口が無い。表示は ccmsg の実効値で出す |
| module が model の別名を具体的な id に写す表を持つ | 版が出るたびに古くなり、別名の行き先を環境変数で変えた環境と食い違う。解決は engine に任せる |
| 通しの上書きを module だけが持つ (daemon は中継だけ) | restart で module が上がり直すと意図が消える。daemon が持てば名乗り直しで戻せる |
| 単発の上書きを `prompt.submit` の resolve の後に有効にする | turn の最初の request が resolve より先に来うるので、最初の request に効かないことがある |

## Consequences

- 上書きは engine の状態を変えないので、ccmsg の外 (端末の `/model`、Claude Code の status line) からは見えない。人が端末で `/model` を打つと、その切替は元の値を変えるが、上書きのある field は上書きが勝つ
- 上書きの無い (古い) module は `session.override` に答えず (`unconfirmed`)、`prompt.send` の `override` を黙って読み飛ばす。どちらも facts に上書きが出ないので、webui の状態行に印が付かないことで分かる。セッションを再起動すると新しい module が載る
- 単発の上書きを付けた文が turn を始めない時 (`/compact` のような組み込みの command 等) は、上書きは次に始まる turn に結び付く
- model の `[1m]` は元の request の `e.model` に従う。`haiku[1m]` も request の `anthropic-beta` に `context-1m-…` が付いた (代役の API で確認)。1M の context を持たない model に付いた時に本物の API がどう答えるかは確かめていない
- prompt cache は model ごとなので、model の上書きを付け外しすると、その request の cache は効かない

## 関連

- [findings 2026-10-26-mods-command-run-builtin](../findings/2026-10-26-mods-command-run-builtin.md) — 差し替えの根拠の実測
- [DR-0035](./DR-0035-user-input-via-composer-fill.md) — webui → daemon → サイドカー → module の経路、`prompt.send`、facts
- [DR-0039](./DR-0039-all-mods-and-typed-tools.md) — module の関心の分け方と `bus` の登録
- [DR-0020](./DR-0020-session-status-tab.md) — Status タブと TL 下の状態行
- [DR-0018](./DR-0018-session-launcher.md) — model / effort の語彙
