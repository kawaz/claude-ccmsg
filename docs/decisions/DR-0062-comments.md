# DR-0062: TL のメッセージと Files にコメントを付け、daemon に溜めて (または即時に) エージェントへ送り、エージェントは `comment_reply` でコメントごとに返信する

- Status: Accepted (2026-11-22、kawaz「どの件もそのまま進めて」) — 🟡 部分実装 (段階 1: protocol の `comments.ts`、daemon の `comments.ts` と `server.ts` のコメントの op・`session_status_subscribe` への push・届いたの確定・turn の終わりの未確認、webui の `comment-view.ts`・`timeline/comments.tsx`・Timeline の 💬 の印・返信・コメントの吹き出し・💬 のフィルタ。P27 (FAB の直送も送信の列に並べる) も入れた。段階 1 は未決の U10 / U12 / U13 を推しのとおり仮に入れた。段階 2〜5 は未実装)
- Decision は kawaz と統括の議論 (2026-11-22) で決めたものと、設計の監査を受けて統括が決めたもの。統括が議論で出して kawaz が否定しなかったものは「統括案、kawaz の異論なし」と書く。それ以外の主素材に無い判断は「統括の推し」(P 番号) に分け、kawaz の判断を待つものは「未決」(U 番号) に置く。測ったことと実装の途中で測ることは「測ること」。kawaz の裁定は末尾の「裁定」
- Date: 2026-11-22

## Context

TL のエージェントの応答や Files のソースを読みながら、コードレビューのように「この箇所について」の指摘・質問をその場所に付けたい。今の入力は FAB の 1 本の欄だけで、どこについての話かは人が文で書き添えるしかなく、気づいた順に 1 件ずつ送るとエージェントの作業を細切れに割り込むことになる。そこで、メッセージ (と Files のソース・md プレビュー) にコメントを付け、daemon に溜めて (または即時に) エージェントへ送り、エージェントはコメントごとに返信する仕組みを作る。

### 読んで分かった前提

- **module の tool**: エージェントが使う ccmsg の口は module が `$.tool.register` で登録する typed tool で、handler は `next` を呼ばずに `{ result }` で答え、permission の判定を通らない ([DR-0039](./DR-0039-all-mods-and-typed-tools.md) §3)。登録は `isDeferred: true`・description は数語で、使い方の正本は skill に置く (同「mods の tool の作り方」)。deferred が効く間、tool は読み込まれるまで一覧の名前 1 行だけが context に載り、説明文は載らない (同 Consequences)
- **ccmsg の skill**: plugin の skill (`skills/ccmsg/SKILL.md`) の description は、ccmsg の tool の名前と読む場面を 1 文で持つ。本文は tool をフルネームで名指し、使い方と field の決まりの正本になっている (DR-0039 §3)
- **`-p` / SDK には tool を登録しない**: module は `session.start` の `isInteractive` が false のセッションに tool を登録しない (`hooks/tools.ts` の `toolsAtStart`)。btw の fork ([DR-0060](./DR-0060-btw-mode.md)) は `claude -p` なので、ccmsg の tool を登録しない (fork の init の tool の一覧に無い)。それでも fork の request の `system` と `tools` の形は元のセッションと一致し、本体で ToolSearch で読み込んだ ccmsg の tool の形は fork の request にも載る。fork は会話の末尾に「The following deferred tools are no longer available …」の system の 1 件を足す ([findings 2026-11-22-dr62-btw-cache-and-prompt-concat](../findings/2026-11-22-dr62-btw-cache-and-prompt-concat.md) §1)
- **btw の fork の cache** (同 findings §1): fork に ccmsg の tool が無いことは cache を切らない (ccmsg の tool の読み込みの前後とも)。当たらなかったのは model の別名 (`sonnet[1m]`) を `-p` に渡した時で、履歴の thinking が落ちていた。btw コマンドに正式な id (1M なら `[1m]` 付き) を渡す形に DR-0060 §2 で直した。2 件目以降の fork は fork 同士の cache にも当たる
- **turn の最中に続けて送ったプロンプト** (同 findings §2、§3): transcript では連結されず 1 件 1 行になる。行の形は送った時の状態で 3 通り: 待機中は `type:"user"` / `promptSource:"typed"`、tool の実行中は `type:"attachment"` / `attachment.type:"queued_command"` (文は `attachment.prompt`、`timestamp` は待ちに入った時刻、`type:"user"` の行は出ない)、応答の stream 中は turn の終わりに `type:"user"` / `promptSource:"queued"` (`timestamp` は待ちから出た時刻)。model には同じ turn に別の text block で並んで届く。文は待機中は末尾の空白が、turn の最中は両端の空白が落ちる
- **届いたかの照合の部品**: protocol の `landed-prompts.ts` (`promptTextKey` は両端の空白を落とした文、`pairLandedPrompts` は送った順に最も早い同じ文の行と 1 対 1 で組む)、`queuedPersonPrompt` (`queued_command` の人の行の文)、daemon の `prompt_rows` の `since`。今の FAB の「届いたか分からない」送信の自動解消 (DR-0035 §5) がこれを使っている
- **人の入力の経路**: webui → op `user_prompt` (user role) → daemon の `userPrompt` → サイドカーの `prompt.send` → module が composer に fill して Enter ([DR-0035](./DR-0035-user-input-via-composer-fill.md) §1、§3)。結果は `accepted` / `not_delivered` / `unconfirmed` で、daemon が module の返事を待つのは 12 秒まで。turn の実行中に入れた prompt は Claude Code が待ちの列に置き、tool の結果の後に model に届く (同 §5)。人の入力の記録の正本は transcript。DR-0035 §1 は、人の入力に返信方法の指示行を付けないと決めている
- **module が push する行**: module は transcript の行を daemon に push し、daemon は追いつきの読みと合わせて行を見る ([DR-0045](./DR-0045-say-speaks-in-tool-shown-from-transcript.md) §2、§7)
- **ccmsg の tool の行の表示**: say と許可依頼は、transcript の tool_use の行を表示の正本にし、daemon は人の状態だけを持つ (DR-0045 §7、[DR-0040](./DR-0040-permit-request-tool.md) §4)。結果の文の照合は protocol の純関数 (`permitRequested` 等) に置き、daemon と webui が同じものを使う
- **btw**: webui の FAB の btw のチェックボックスから op `btw_ask` で、daemon が btw コマンド (`claude -p --resume <sid> --fork-session --no-session-persistence`) を 1 件ずつ起こし、記録 (`BtwRecordSchema`、聞いた時点の transcript の最後の行 `after_uuid` を持つ) を `<stateDir>/sessions/<sid>.btw.jsonl` に追記し、そのセッションの transcript の購読者に `ev:"btws"` / `ev:"btw"` で配り、webui が TL の `after_uuid` の直後に点線の枠の `BtwBubble` で出す (DR-0060)。FAB の btw は ⏱️ の effort と添付を持てる。同時に走る btw は daemon 全体で 4 つまでで、超えると `btw_busy` で断る。DR-0060 §12 は「btw の続きの質問」をやらないことに入れ、続けて聞く時は新しい btw を送るとしている
- **セッションごとの保存の場所**: `<stateDir>/sessions/`。`ccmsg sidecar begin` が begin の時に、mtime が 30 日より古いファイルを拡張子を問わず消す (ディレクトリは消さない)。daemon が webui のために持つ全セッション 1 ファイルの状態 (`say-read.json` / `permit-state.json` / `bookmarks.json`) は小さいものだけで、長い文を持つ btw の記録はセッションごとの追記のファイルにした (DR-0060 §9 の Design rationale)
- **セッションの購読**: webui のセッションの画面は、Files / Status / Timeline のタブの間 `session_status_subscribe` でそのセッションの状態を購読し、`ev:"session_status"` を受ける (`SessionView`)。`transcript_subscribe` は Timeline を表示している間だけ。FAB は Terminal タブでは出さない (DR-0035 §1)
- **TL のツールバーとフィルタ**: `tl-toolbar` の左端に 🔔 🔐 ⭐ 👤 🔍 が並び (`TOOLBAR_BADGE_KINDS`)、押すとページ固有の query `filter=<種類>` で、`.tl-lines[data-filter]` が該当しない項目を CSS で隠す。数は `CountBadge` (赤い角丸、0 は数なし、100 以上は `99+`)。フィルタの間の項目のクリックはその項目の位置への移動 ([DR-0050](./DR-0050-timeline-notification-badges.md)、[DR-0058](./DR-0058-timeline-bookmarks.md) §5、§6、§11、[DR-0022](./DR-0022-in-view-search.md))。窓の外の項目は daemon に聞いて時刻の位置に合流させる (`slotsByTime`)
- **💬 の字の既存の用途**: 🔍 のフィルタのフォームの検索対象のトグル 👤 🤖 💬 の 💬 は「ccmsg 経由のメッセージ」を指す (DR-0022)
- **項目の右上の組とバブルの足元**: どの項目も右上の角に「jsonl ⭐」の組を置き、右詰めのユーザの発言だけは組を吹き出しの右上の外側 (組の下端 = 吹き出しの上端、右端 = 吹き出しの右端) に置く (DR-0058 §3)。吹き出しの足元の行は `BubbleFooter` (時刻 → 翻訳タブ → 吹き出しごとの付随ボタン、[DR-0049](./DR-0049-webui-plamo-translation-tab.md) §8)。☆ / ⭐ のように入れ替わる印は `StackedLabels` で同じ升目に重ねる (DR-0058 §3)
- **描画した文字への印**: TL の検索のハイライトは CSS Custom Highlight API で、描画された文字の連結の上の範囲を Range に戻して塗る (`rendered-text-search.ts`)。Files の編集の着色も同じ API ([DR-0051](./DR-0051-file-editor-syntax-highlight.md))。md の描画は mdast の walker で、mdast の節点は元の文の位置 (行) を持つ ([DR-0010](./DR-0010-timeline-markdown-rendering.md))
- **FAB の添付**: 添付は `POST /attachment` で daemon の一時ディレクトリ (OS の TMPDIR の下) に置かれ ([DR-0015](./DR-0015-composer-attachments.md))、本文の `[FILE<N>]` の番号は下書きごとに 1 から振られる (`SessionInputComposer` の `beginUpload`)。送る時に `[FILE<N>:<name>](<path>)` に置き換える

## 目的

TL の項目・Files の箇所・会話のその時点に付けたコメントを、どこについての話かが分かる形でエージェントに届け、エージェントの返信をその場所と結んで読めるようにする。どのデバイスで付けたコメントも、送る前でも、同じセッションを見ている全ての webui で見える。送る時機は人が選ぶ (すぐ送る / 溜めて読み直してから送る)。済んだ話題は解決済みにして畳める。

想定する使い方:

- **裁定待ちの問いの md に答える**: エージェントが裁定待ちの問いを並べた md (例: `docs/QUESTIONS.md`) を Files の md プレビューで開き、答えたい部分を範囲選択してコメントを付け、キューに溜めてまとめて送る。応答は箇所ごとの返信 (`comment_reply`) にまとまる。問いの番号 (「XX-Q2」等) を手で写す必要が無くなる
- **応答の中の問いに 1 つずつ返す**: TL の応答の吹き出しに並んだ問いを 1 つずつ範囲選択して返信する

増やしたくないもの:

- **人の入力をセッションに入れる経路**: コメントも FAB のキューも、送る時は `user_prompt` と同じ composer への fill で入れる (DR-0035)。別の注入の経路を作らない
- **daemon とエージェントの間で覚える状態**: 1 つのコメントはそれだけで意味が分かるテキストで渡し、daemon は「このセッションに指示を付けたか」等を覚えない。エージェントへの指示は compact で消えない場所に置く
- **btw の入口と記録の種類**: btw はコメントの 1 つの形 (btw のフラグの付いたコメント) にし、FAB の btw もコメントとして作る。btw コマンド (DR-0060 §2) はそのまま使い、btw だけの記録・保存・push を別に持たない
- **TL の描画の経路**: エージェントに届いたコメントとエージェントの返信は transcript の行から描く。フィルタ用に TL を別に描かない
- **エージェントに見せる識別子**: エージェントに渡すのは cid と人が読むのと同じ手掛かり (種類と引用と選んだ文字) だけで、uuid・時刻・描画の位置は渡さない

## Decision

### 1. 用語

| 語 | 意味 |
|---|---|
| コメント | 人が書いて daemon に置く文。1 つずつ cid を持ち、1 つのアンカーを持つ |
| アンカー | コメントの結び付く先。種類はタイミング・メッセージ・選択範囲・ファイルの箇所・コメント (§2) |
| 返信 | アンカーがコメント (cid) のもの。人の返信 (コメント) と、エージェントの返信 (`comment_reply`) と、btw の答えがある。どれも新しい cid を持つ |
| スレッド | アンカーがコメントのものを辿って繋がったコメントと返信の列。アンカーがコメントでない最初のコメントがスレッドの始まり |
| 解決済み | スレッドに付ける印 (§6) |
| 未送信 | daemon に溜めてあり、まだ送っていないもの (コメントと FAB の下書き) |
| キュー | 未送信のものの集まり |
| 入れた / 届いた | 入れた: composer への fill が受け付けられた (`accepted`)。届いた: module が push した人の行にそのコメントのブロックを見た (§11) |

### 2. アンカー

アンカーは 1 つの概念で、種類を持つ。全てのコメントと返信がちょうど 1 つ持つ。

| 種類 | 何に結び付くか | 記録が持つもの | 作る所 |
|---|---|---|---|
| タイミング | 会話のその時点 (特定のメッセージや引用でなく、タイミングへのアンカー) | 無し。位置は記録の時点 (下、P21) | FAB の btw |
| メッセージ | TL の項目 | 項目の行の uuid、`on` | バブルの「返信」ボタン |
| 選択範囲 | TL の項目の中の引用 | 項目の行の uuid、`on`、選んだ文字と前後の少しの文字、描画された文字の中の位置 (手掛かり) | 範囲選択のツールバー |
| ファイルの箇所 | Files のソース・md プレビューの中の引用 | ファイルのパス、ソースかプレビューか、選んだ文字と前後の少しの文字、コメントした時点の行・列とその行の文 (P20) | Files の範囲選択のツールバー |
| コメント | 既存のコメント・返信 (cid)。その中の引用も持てる | 返信先の cid。範囲選択なら選んだ文字と前後の少しの文字 | `comment_reply` の応答・送ったコメント・btw の答えのバブルの「返信」ボタンと範囲選択、`comment_reply`、btw の答え |

表示はアンカーの種類で決まる:

| 種類 | TL / Files の印 | 届いたコメントの出る所 | btw の答えの出る所 | エージェントへの文 |
|---|---|---|---|---|
| タイミング | 無し | transcript の人の行 (§12) | 送った時点の transcript の最後の行の直後 | `on` / `quote` 無し |
| メッセージ | 項目に 💬 (数付き) | transcript の人の行 | 送った時点の行の直後 | `on` と `quote` |
| 選択範囲 | 項目に 💬、範囲のハイライトと範囲の後ろの 💬 | transcript の人の行 | 送った時点の行の直後 | `on`、`quote`、`<selection>` |
| ファイルの箇所 | Files のその箇所にハイライトと 💬 | transcript の人の行 | 送った時点の行の直後 | `on` (パスと行)、`quote`、`<selection>` |
| コメント | 返信先のバブルに 💬、範囲選択ならそのハイライトと 💬 | transcript の人の行 | 送った時点の行の直後 | `reply_to`、`on` (返信先の種類)、`quote` (返信先の本文の先頭)、範囲選択なら `<selection>` |

- **時点の記録** (P21): アンカーとは別に、全ての記録が「いつ書いた」と「いつ送った」をそれぞれ時刻とその時点の transcript の最後の行の uuid (DR-0060 の `after_uuid` と同じ決め方) で持つ。タイミングのアンカーの位置は、送ったものは送った時点、未送信のものは書いた時点。btw の答えは、どの種類のアンカーでも送った時点 (fork が読んだ文脈の位置、DR-0060 §4 の「少なくともこの行までは見て答えた」位置) に出す
- **選択範囲を作れる表示**: 選択範囲・ファイルの箇所・コメントの中の引用は、原文の表示 (翻訳タブでない、md の描画の表示。Files はソースか md プレビュー) の時だけ作れる。jsonl の表示・翻訳タブ・raw の表示では範囲選択のツールバーを出さない
- **探し直し**: 選択範囲とコメントの中の引用も、ファイルの箇所 (P20) と同じく「選んだ文字 + 前後の少しの文字」で、今描かれている文字の中から探し直す。描画された文字の中の位置は手掛かりに留める (翻訳・md の描画の変更・幅の違いで文字の連結が変わりうるため)。見つからない時は印を出さず、💬 のフィルタで「元の場所が見つからない」と出す
- **agent の TL**: subagent / teammate の TL (DR-0025) の項目へのコメントは、この DR では付けられない。agent の TL では範囲選択のツールバーと返信ボタンを出さない

### 3. 付け方 (webui)

- **範囲選択のツールバー** (統括案、kawaz の異論なし): バブルの中の文字を範囲選択した時だけ、そのバブルの右上 (ツールバーの下端 = バブルの上端、右端 = バブルの右端) に小さいツールバー (`SelectionToolbar`) を出す。バブルの右上が画面の外にある時 (長い応答の下の方を選んだ時) は、選択範囲の右上に出す。中身は 💬 (コメント) と btw の 2 つ。どちらを押してもコメントのフォームが出る (btw は btw のフラグを入れた状態で出る)。アンカーは選択範囲 (`comment_reply` の応答・送ったコメント・btw の答えのバブルの中ならコメント)。Files のソースと md プレビューでの範囲選択も同じツールバーを出し、アンカーはファイルの箇所 (置き場は P9)
- **返信ボタン** (統括案、kawaz の異論なし。置き場は kawaz 2026-11-23): 全てのメッセージバブル (エージェントの応答、`comment_reply` の応答、送ったコメントのバブル、ユーザの発言、btw の答え等) に「返信」ボタンを置く。置き場は許可依頼の「まとめて許可」(DR-0040 §7) と同じく、バブルの枠の中の最後の行の右端で、hover を待たず常に出す。最後の行にボタンが既にある項目 (許可依頼の「既読」「まとめて許可」、say の「既読」) はその行の中に並べ (許可依頼では「既読」の左、「まとめて許可」が右端のまま)、他は本文の後ろに「返信」だけの行を足す (`CommentReplyRow`)。見た目は枠だけの小さなボタンで、塗りの accent にせず本文より目立たせない。枠を持たない fold の行 (tool の呼び出し等) は、開いた中身のすぐ下にその左端に揃えて出し、閉じている間は出さない。押すとそのバブル全体へのコメントのフォームが出る。アンカーはメッセージで、`comment_reply` の応答・送ったコメント・btw の答えのバブルではコメント (そのバブルの cid)
- **FAB の btw**: FAB の btw のチェックボックス (DR-0060 §8) で送ったものは、アンカーがタイミングの btw コメントになる (§14)
- **フォーム** (`CommentForm`): 本文の欄、「今すぐ送る」のチェックボックス、btw のチェックボックス、保存 (送信) のボタン
  - 「今すぐ送る」が付いていれば、daemon に保存してすぐにそのコメント 1 件を送る (キューで待たせない)。外れていれば daemon に保存して溜める (未送信)
  - 「今すぐ送る」のチェックの状態はセッションごとに localStorage に覚える (統括案、kawaz の異論なし)
  - btw のフラグはコメント 1 つごとに付けられる (§14)
- **未送信のコメントは送る前に直す・消す操作を持つ** (統括案、kawaz の異論なし)。送ったコメントは直さない・消さない

### 4. エージェントに渡す形 (コメントのブロック)

1 つのコメントは、それだけで意味が分かるテキストのブロックで渡す。エージェントは uuid も時刻も知覚できないので、どこを指しているかは人が読むのと同じ手掛かりで渡す。ブロックの文は protocol の純関数 (`commentBlockText`) が作り、daemon の送信と webui のプレビュー (§13) が同じものを使う。逆向きの読み取りは `parseCommentBlocks` (§12)。

```
<comment cid="c7k2p" on="応答" quote="この関数は呼び出し側で null を返すことがあり、そのまま…">
<selection>null を返すことがあり</selection>
ここは undefined を返すのでは？
</comment>
```

- **cid**: コメントの識別子 (形は §7)
- **on**: 対象の種類。下の表。アンカーがタイミングのコメントは持たない
- **quote**: 対象の本文の先頭 40 文字ほど (空白を詰め、超えたら `…`)。thinking は中身を書かず、`on="thinking"` だけにする (統括案、kawaz の異論なし)
- **selection**: アンカーが選択範囲・ファイルの箇所・コメントの中の引用の時の選んだ文字。TL のバブルでは位置を付けない。Files のソースと md プレビューは大まかな位置 (行) を `on` に付ける。md プレビューで選んだ文字は、md の元の文のどの行かを `on` の行で示す (P26)。上限は 2000 文字で、超えたら先頭と末尾の引用 (それぞれ数百文字と、間を省いた印) に縮める
- 本文: ユーザのプロンプト
- **エスケープ**: 属性の値と、入れ子の全ての本文 (`<selection>`、本文、§14 の btw の組の質問と答え) に同じ規則を当て、`parseCommentBlocks(commentBlockText(x))` が `x` に戻るようにする (規則の細部は P3)

| 対象 | `on` |
|---|---|
| エージェントの応答 | `応答` |
| thinking | `thinking` (`quote` なし) |
| ユーザの発言 | `ユーザの発言` |
| subagent / teammate への指示 (Agent の呼び出しの prompt、SendMessage) | `<agentid> への指示` |
| subagent / teammate からの応答 (Agent の結果、task-notification、teammate-message) | `<agentid> からの応答` |
| Files のソース | `ファイル <path>:<行>:<列>` (選択の始まり) |
| Files の md プレビュー | `ファイル <path>:<行> (プレビュー)` |
| `comment_reply` の応答 (アンカーがコメント) | `エージェントの返信` |
| 送ったコメント (アンカーがコメント) | `コメント` |
| btw の答え (アンカーがコメント) | `btw の答え` |
| 上に無い項目 (tool の呼び出し、say、許可依頼、ccmsg のメッセージ等) | P2 |

- **返信** (アンカーがコメント): cid があれば足りるが、compact の後に備えて短い引用も付ける (統括案、kawaz の異論なし)

  ```
  <comment cid="c3xq9" reply_to="c8m1t" on="エージェントの返信" quote="c8m1t の本文の先頭 40 文字…">
  本文
  </comment>
  ```

- **アンカーがタイミングのコメント** (FAB の btw): `<comment cid="c5h2w">本文</comment>`
- 複数のコメントをまとめて送る時は、ブロックを空行で区切って 1 つのプロンプトにする (統括案、kawaz の異論なし。§11)
- ブロックにもプロンプトにも、返し方の指示行 (「`comment_reply` で返して」等) を付けない。返し方は ccmsg の skill が持つ (§5)
- daemon 側は正確な位置を持つ (§7): TL の項目の uuid、描画された文字列の中の選択の位置、ファイルの正確な行・列と前後の文字。エージェントへの文には載せない
- **人の入力に載るエージェントの文**: `quote`・`<selection>`・btw の組には、エージェントや btw の fork が書いた文が引用として載り、それが人の入力 (composer への fill) としてセッションに入る。足されるのは引用で、許可ではない (DR-0035 §4、DR-0039 §6 の「足されるのは文脈であって権限ではない」と同じ)。auto mode の classifier が引用の部分を人の発話として読むかは未検証

### 5. エージェントの返信: tool `comment_reply { cid, body }`

- ccmsg の module が登録する tool (DR-0039 §3 の typed tool)。model からは `mcp__ccmsg-v1__comment_reply`
- handler は入力を valibot で読み、daemon の `POST /op` ([DR-0046](./DR-0046-module-op-over-http.md)) に op `comment_reply` (session role、§9) を、呼び出しの tool_use の id を添えて送る。daemon は cid が返信先になれる記録か確かめ、返信の記録を作って新しい cid を振る
- **返信先になれる記録**: 本体に送った人のコメント (`status` が `sent` / `delivered` / `unconfirmed`) と、エージェント自身の返信。`draft`・`deleted`・btw のフラグの付いたコメント・btw の答え (本体の context に無いもの) は `not_found`
- **二重の記録を防ぐ**: 同じ tool_use の id の `comment_reply` が来たら、新しく作らずに前の記録の cid を返す
- 結果として、その返信自身にも新しい cid が振られたことが分かる文と、返信先の短い引用を返す (返信の返信でスレッドになる)。例: `c7k2p (「ここは undefined を返すのでは？」) への返信を記録した。この返信の cid は c8m1t (人がこれに返信すると reply_to="c8m1t" で届く)`。結果の文の照合 (新しい cid の取り出し) は protocol の純関数 (`commentReplyRecorded`) に置き、webui が transcript の結果の行から cid を読む
- 失敗の文は次にすることを添える:
  - daemon が居ない・古い: 他の tool と同じ文 (daemon を起こす・更新する)
  - cid が返信先になれない: `cid c99xx はこのセッションの本体に届いたコメントに無いので記録していない。届いた <comment> の cid を確かめて書き直す`
  - 入力が形に合わない: `comment_reply の入力が形に合わないので何もしていない: <理由>`
- **登録の形**: 他の ccmsg の tool と同じく `isDeferred: true`、description は数語 (`Reply to a comment`)。field の説明は付けない (DR-0039「mods の tool の作り方」)
- **返し方の指示は ccmsg の skill の description に置く** (裁定 2)。skill の一覧 (名前と description) は compact の後も context に載る前提で (「測ること」3 で確かめる)、daemon は「初回に指示を付けたか」を覚えない。description に足す文の案 (今の description の後ろに 1 文):

  ```
  <comment cid="…"> が届いたら、コメントごとに mcp__ccmsg-v1__comment_reply { cid, body } で返し、同じ内容を応答の本文に書き直さない (この tool が無ければ本文で返す)。
  ```

  - 「同じ内容を応答の本文に書き直さない」は、返信が応答と同じ吹き出しで出る (§12) ので、本文にも書くと同じ話が 2 度並ぶため。この句が無い文では、model は `comment_reply` の後に毎回、返信の中身の要約を本文にも書いた (「測ること」3)

  - tool のフルネームと引数を書くのは、deferred で未ロードの tool を ToolSearch なしに名前で呼ばせるため (未ロードの plugin の tool を名前で呼んでも handler に届く、DR-0039 §3)
  - 「この tool が無ければ本文で返す」は、tool を持たないセッション (plugin の更新の前に起動した、module の無い) と btw の fork のため
  - 使い方の正本は skill の本文に置く (DR-0039 §3 の流儀): コメントのブロックの読み方 (`on` / `quote` / `<selection>` / `reply_to` / btw の組)、1 つのコメントに 1 回呼ぶこと、結果の文の新しい cid、失敗の文の扱い。description は本文を読む契機の 1 文に留める
- **コメントのブロックには返し方の指示行を付けない** (DR-0035 §1 の「人の入力に返信方法の指示行を付けない」と揃う)。ブロックは人が書いたこととその場所だけを運ぶ
- **btw の fork**: fork は `comment_reply` を持たない (module が `-p` に tool を登録しない) ので、description の「tool が無ければ本文で返す」と DR-0060 §3 の前置きの「結果は本文に書く」で、答えは本文になる。fork の context に ccmsg の skill の一覧が載るかは確かめていないが、どちらでも本文の答えになる
- **弱点**: description は model が読んで従う前提で、model が skill を読まずに本文で返す (または一部のコメントにだけ `comment_reply` を呼ぶ) ことはありうる。その時、返信は普通の応答としては読めるが、コメントのスレッドに結ばれない。これを測る (「測ること」3、P33)
- webui では普通のエージェントの応答とほぼ同じに見せる (§12)

### 6. 解決済み

- コメントのスレッドに「解決済み」の印 (✔️ / ✅) を付けられる。単位はスレッド (最初のコメントと、その返信・`comment_reply`・btw の答えの連なり)
- 付け外しは人 (webui) の操作 (op `comment_resolve`、§9)。外すと未解決に戻る。daemon が状態を持ち (スレッドの状態の行、§7)、別のデバイスにも配る
- **解決にできないもの**:
  - 未送信のコメント (`draft`) を持つスレッド
  - 始まりが `draft` / `deleted` のスレッド (対象外)
  - 人が見ていた後に新しい記録が足されたスレッド: `comment_resolve` は人が見ていたスレッドの最後の cid を持ち、それより新しい記録があれば断る
- btw の答えが走っている間に解決にしたスレッドは、答えが終わった時に解決を外す (答えを読まないまま隠さない)
- 印は `StackedLabels` で ✔️ (未解決、押すと解決) と ✅ (解決済み、押すと外す) を重ねる (置き場は P14)
- 💬 のフィルタの画面では、✅ の付いたスレッドは既定で出さない。画面に `[ ] 解決済みを表示` のトグルを置く (置き場は U10、覚えるかは P19)
- エージェントが解決にできるか (U11)、解決済みのスレッドの TL の印 (U12)、解決済みのスレッドに未送信のコメントが加わった・新しい返信が来た時 (U13) は未決

### 7. 記録

コメント・エージェントの返信・btw の答えを、1 件 1 つの記録で表す。protocol の `CommentRecordSchema` (valibot) が形を持ち、daemon の保存 (§8)・push (§10)・webui の store が同じスキーマで読む。スレッドの解決の状態は別の種類の記録 `ThreadStateSchema` に持つ。

**cid**: `c` と英小文字・数字 4 字の乱数 (`c7k2p`)。daemon はそのセッションのファイルの中に同じ cid が無いことを確かめて振り、あれば振り直す。連番にしない (ファイルが掃除で消えた後に振り直した番号が、会話に残る古い cid と重なるため)。読む → 振る → 書くは sid ごとの記録の列 (§11) で直列にする。

`CommentRecordSchema`:

| field | 中身 |
|---|---|
| `kind` | `"comment"` (行の種類) |
| `cid` | 上 |
| `session_id` | コメントの付いたセッション |
| `author` | `user` (人のコメント) / `agent` (`comment_reply`) / `btw` (btw の答え) |
| `anchor` | アンカー (下)。`author` が `agent` / `btw` の記録はコメント (返信先の cid) |
| `quote` | ブロックの `quote` に入れる文。メッセージ・選択範囲は対象の本文の先頭、ファイルの箇所は選んだ文字の行の文の先頭、コメントは返信先の本文の先頭。人のコメントは webui が作った時に渡し、エージェントの返信は daemon が `body` の先頭から作る |
| `body` | 本文。`author` が `user` (人のプロンプト) と `btw` (btw の答えの文) の時だけ持つ。`agent` の本文は transcript の `comment_reply` の行が正本で、記録は持たない |
| `attachments` | 添付 `[{ n, name, path }]` (`author` が `user` の時、§15 と同じ置き場) |
| `effort` | btw の effort (`author` が `user` で btw の時。FAB の ⏱️ の選択) |
| `written` | 書いた時点 `{ at, after_uuid? }` (P21) |
| `sent` | 送った時点 `{ at, after_uuid? }`。未送信なら無い (P21) |
| `updated_at` | 最後に変わった時刻。直す・送る操作が「見ていた版」として送り返す (§9) |
| `btw` | btw のフラグ (`author` が `user` の時だけ) |
| `status` | `author` が `user` で btw でない時: `draft` / `sending` / `sent` (入れた) / `delivered` (届いた) / `unconfirmed` / `deleted`。btw の時: `draft` / `sending` (列で空きを待つ) / `sent` (fork を起こした) / `deleted`。`author` が `btw` の時: `running` / `done` / `failed` / `canceled` (DR-0060 §4)。`agent` は持たない |
| `send_error` | 送れなかった理由。次に送れたら消す |
| `row_uuid` | 届いた時、そのブロックを持つ transcript の人の行の uuid |
| `tool_use_id` | `author` が `agent` の時、`comment_reply` の呼び出しの tool_use の id |
| `model` / `tool` / `ended_at` / `error` | `author` が `btw` の時だけ。DR-0060 §4 の同じ名前の field と同じ中身 (`tool` は保存しない)。`effort` も btw コマンドに渡した値を持つ |
| `btw_id` | DR-0060 の btw の記録から写した記録だけが持つ、元の btw の id (§14) |

`anchor` の形 (`kind` で分ける):

- タイミング: `{ kind: "timing" }`
- メッセージ: `{ kind: "message", uuid, on }`。`uuid` はその項目の行の uuid (TL の位置になれる行、DR-0058 §2)、`on` は §4 の表の値 (webui が項目の種類から作る)
- 選択範囲: `{ kind: "selection", uuid, on, text, before, after, start?, end? }`。`text` は選んだ文字、`before` / `after` は前後の少しの文字 (探し直しに使う、§2)、`start` / `end` は描画された文字の連結の中の位置 (手掛かり)
- ファイルの箇所: `{ kind: "file", path, view: "source" | "preview", text, before, after, line, col?, line_text }`。`text` は選んだ文字 (プレビューは描画された文字)、`line` / `col` はコメントした時点の選択の始まり (プレビューは選んだ文字を含む md の塊の元の行で、`col` は持たない)、`line_text` はその行の元の文 (P20)
- コメント: `{ kind: "comment", cid, text?, before?, after?, start?, end? }`。範囲選択でなければ `cid` だけ

`ThreadStateSchema`: `{ kind: "thread", session_id, root, resolved_at?, seen_cid? }`。`root` はスレッドの始まりの cid、`resolved_at` は解決済みにした時刻 (無ければ未解決)、`seen_cid` は解決にした時に人が見ていた最後の cid。

### 8. 保存

- 置き場は `<stateDir>/sessions/<sid>.comments.jsonl` (コメント・返信・btw の答え・スレッドの状態) と `<stateDir>/sessions/<sid>.queue.jsonl` (FAB の下書き、§15)。1 行が記録 1 つの全体で、daemon だけが追記し、読む時は同じキー (`kind` と cid / root / id) の後の行が前の行に勝つ。コメントを消す (`deleted`) のも 1 行の追記。FAB の下書きは記録そのものを消す (§15) ので、消す時は削除の行 `{ kind: "draft_removed", id }` を足す (ファイルの書き直しは P34)
- **行の組み方**: 書く行は、書く直前のメモリの最新の記録から組み、その操作が変える field だけを替える (前に読んだ古い写しから組まない。並んだ操作が互いの変更を消さないため)。書き込みは sid ごとの記録の列 (§11) を通す
- 書くのは変わるたび (作る、直す、消す、送る前 (`sending`)、送った結果、届いた、返信を記録した時、解決の付け外し、btw の答えが始まった時と終わった時)。btw の答えが走っている間の伸びは書かない (push だけ、DR-0060 §9 と同じ)。書いてから答え、push する
- **書けなかった時**: 人の操作 (作る、直す、消す、送る前の `sending`、解決の付け外し、未確認の扱い) の行が書けなければ、op は `state_not_writable` で断り、メモリも配りも変えない (人は断りを見てやり直せる)。セッションが起こした変化 (送った結果、届いた、turn の終わりの未確認、起動の後の `sending` の読み替え) の行が書けなければ daemon.log に残し、メモリと配りは進める (セッションの側では既に起きたことで、人がやり直せるものが無い。次の daemon は書けた所までを読む)
- 読むのは daemon がそのセッションのコメントを初めて要る時 (購読の始まり、op、module の行) で、ファイルごとメモリに持ち、以後は追記の分を足す。読んだ時に送った (`sent` / `unconfirmed`) まま届いたと確かめていないものがあれば、transcript の追いつきの読みで照合する (§11。daemon が止まっていた間に行が出ていれば、次の行の push を待たずに `delivered` になる)
- daemon の起動の後に読んだ記録が `sending` のまま残っていれば `unconfirmed`、`running` のまま残っていれば `failed` (`error` は「daemon が止まった」) として扱い、その行を追記する
- 寿命は `<stateDir>/sessions/` の掃除に従う (DR-0060 裁定 4 と同じ。最後の書き込みから 30 日)

Design rationale: btw の記録と同じく、`<sid>.json` (`ccmsg sidecar begin` が丸ごと書き直す) にも全セッション 1 ファイルにも入れない (DR-0060 §9)。コメントは本文を持ち、1 件足すたびに全セッション分を書き直すことになるため。

### 9. op

どの op も、そのセッションの記録を読む・変える部分は sid ごとの記録の列 (§11) で直列に走る。

`session_id` はセッションの id の形 (`isSessionIdShape`) でなければ `bad_request` (コメントのファイルの名前になるので、別のディレクトリを指す文字列を受けない)。daemon がそのセッションの transcript を見つけられなければ `session_not_found` で断る (コメントは transcript の上に付くもの。btw_ask と同じ)。行が書けない時の断りは §8。

user role だけ (session role は `bad_request` で断る。セッションのエージェントが人のコメントを作る・送る口にしない、DR-0035 §4):

- `comment_add { session_id, anchor, quote?, body, btw, effort?, attachments?, send_now }` → `{ ok: true, comment, outcome? }`。daemon は書いた時点 (`written`) を transcript の末尾から決める。`send_now` なら保存してから §11 の送信をし、その結果を `outcome` (`queue_send` の項目の結果と同じ形) で添える (`user_prompt` と同じ遅い返事)
  - `invalid_args`: 本文が空、`anchor` の形が合わない、`effort` が語彙 (`LaunchEffortSchema`) の外、btw でないのに `effort` がある。受けるアンカーの種類は実装の段階で増える (段階 1 はメッセージとコメントだけで、他の種類は `bad_request`)
  - `not_found`: アンカーがコメントで、その cid がそのセッションに無いか、`draft` / `deleted` の記録 (送っていないコメントには返信できない)
- `comment_update { session_id, cid, seen_updated_at, body?, btw?, effort?, attachments? }` → `{ ok: true, comment }`。`draft` の記録だけ。`seen_updated_at` が今の `updated_at` と違えば `conflict` で断る (別のデバイスで先に直された・送られた)。版が同じで `draft` でなければ `invalid_args` (版を先に見る。別のデバイスで先に送られたものは `conflict` になる)
- `comment_delete { session_id, cid, seen_updated_at }` → `{ ok: true }`。`draft` の記録だけ `deleted` にする。`conflict` は上と同じ
- `comment_resolve { session_id, cid, resolved, seen_cid }` → `{ ok: true, thread }`。`cid` はスレッドのどの記録でもよい。解決にできないスレッド (§6) は `invalid_args` で、`seen_cid` より新しい記録があれば `conflict`。同じ状態への設定は何も変えず送らない
- `comment_btw_cancel { session_id, cid }` → `{ ok: true }`。走っている btw の答え (`cid`) を止める (DR-0060 の `btw_cancel` と同じ働き)。終わった答えは何もせず ok
- `comment_btw_retry { session_id, cid }` → `{ ok: true, comment }`。最後の答えが `failed` / `canceled` の btw のコメント (`cid` は質問) をもう一度聞く (§14)
- `queue_send { session_id, items: [{ kind: "comment", cid, seen_updated_at } | { kind: "draft", id, seen_updated_at }] }` → `{ ok: true, results: [{ kind, id, outcome, reason? }] }` (§11)。1 件ずつの送信・セクションごとの送信・全部送るを、この 1 つの op で表す (渡す列が違うだけ)。`outcome` は `sent` / `unconfirmed` / `not_delivered` (`reason` は DR-0035 §5 の語彙、`UserPromptReasonSchema`) / `btw_started` / `btw_waiting` / `refused` (`reason`: `not_sendable` (`draft` / `queued` でない、今の状態を `status` に添える)・`conflict`・`attachment_missing`・`not_found` (項目が無い、または返信先がまだ送られていない))
- `prompt_queue_add` / `prompt_queue_update` / `prompt_queue_delete` (§15)
- `unconfirmed_settle { session_id, item: { kind: "comment", cid } | { kind: "draft", id }, action: "back_to_draft" | "mark_sent", seen_updated_at }` → `{ ok: true }`。`unconfirmed` の項目への人の操作 (§11): `back_to_draft` はコメントを `draft`、下書きを `queued` に戻す。`mark_sent` はコメントを `sent` にし (P32)、下書きは記録を消す (§15)。版が違えば `conflict`、版が同じで `unconfirmed` でなければ `invalid_args`

断りの語彙 `conflict` と `state_not_writable` (daemon が state dir に行を書けない、§8) を ErrorCode に足す (他の断りは既存の語彙)。

session role だけ (module の `POST /op`):

- `comment_reply { cid, body, tool_use_id }` → `{ ok: true, cid: <新しい cid>, quote: <返信先の引用> }`。セッションは呼び手の sid (接続の identity)。`not_found`: cid が返信先になれない (§5)。`invalid_args`: 本文が空。subagent からの呼び出しは P6

記録を読む op は持たない。読むのは購読の始まりの push (§10)。daemon.log に op ごとに 1 行 (sid、cid、本文の byte 数。本文は書かない。送信は送った結果ごとにもう 1 行)。

### 10. 配り方

コメント・キュー・解決の push は、TL を表示している間 (`transcript_subscribe`) に縛らない。Files / Status / Timeline のどれを見ていても届き、FAB の数もそれで出す。載せる購読は P28。

- `ev:"comments" { session_id, comments, threads, drafts }`: 購読の始まりに、保存されている記録と走っている btw の答えの全部 (`deleted` を除く)、スレッドの状態、FAB の下書きのうち `queued` / `sending` / `unconfirmed` のもの (送り終えた `sent` は含めない。届いたら記録ごと消える、§15) を送る (空でも送る。daemon の再起動の後に繋ぎ直したタブが古い分を捨てられるように)
- `ev:"comment" { comment }`: 記録が変わるたびに 1 つ送る。webui は `cid` で置き換える (`deleted` なら消す)。btw の答えの伸びは 1 つの答えにつき 100ms に 1 回までにまとめ、`status` が変わった時はすぐ送る (DR-0060 §5 と同じ)
- `ev:"comment_thread" { thread }`: スレッドの状態が変わるたびに 1 つ送る
- `ev:"prompt_draft" { draft }`: FAB の下書きの記録が変わるたびに 1 つ送る。webui は送り終えた (`sent`) 下書きを一覧から外す
- `ev:"prompt_draft_removed" { session_id, id }`: FAB の下書きの記録を消した時に送る。webui はその下書きを外す
- 購読していない webui には送らない

### 11. 送信

- **sid ごとの 2 本の列**: daemon はセッションごとに次の 2 本の列を持つ
  - **記録の列**: 記録を読んで決めて書く区間 (op の検査と行の書き込み、cid を振る、送信の前の `sending` と送った時点と送った結果、届いたの確定、turn の終わりの未確認) を順に走らせる。区間の中で await を挟んでも (transcript の末尾を読む、行を書く) 次の区間は始まらない。区間はセッションの返事を待たない
  - **送信の列**: プロンプトをセッションに入れること (コメントの送信・`send_now`・FAB の下書きの送信・キューを通さない FAB の直送 (`user_prompt`、P27)・btw を列に入れる操作) を順に走らせる。送信は前の送信の結果が出てから次を始める。`user_prompt` の 12 秒の期限は列の順番が来てから数える (列の待ちと module の待ちで期限を食って `unconfirmed` になるのを防ぐ)
  - 送信が module の返事を待っている間も記録の列は進むので、直す・消す・解決はすぐ答える
- **受ける状態**: `queue_send` と `send_now` が送るのは、コメントは `draft`、FAB の下書きは `queued` だけ。daemon は記録の列の中で `sending` を書いてから送信の列に入れる。返信 (アンカーがコメント) は、受け付けた時と送信の列で順番が来た時 (記録の列の中で送る直前) の両方で返信先を見て、`draft` に戻っていたり消えていれば送らない (`refused` / `not_found`。順番が来た時に断ったものは `draft` に戻す。エージェントが受け取っていない cid を `reply_to` に持つブロックを作らない)。それ以外の状態の項目は送らず、項目ごとの結果 (`refused` / `not_sendable` と今の状態) で返す。見ていた版 (`seen_updated_at`) が違う項目も送らない (`conflict`)
- 送る文は daemon が記録から作る (`commentBlockText`、§4)。送り方は `user_prompt` と同じ `userPrompt` (composer への fill + Enter、DR-0035) で、新しい注入の経路を作らない。送る直前に送った時点 (`sent`) を transcript の末尾から決める
- **コメント**: 送る列のうち btw のフラグの無いものを、渡された順にブロックを空行で区切って 1 つのプロンプトにする。`accepted` なら `sent` (入れた)、`unconfirmed` なら `unconfirmed`、`not_delivered` なら `draft` に戻して `send_error` に理由を書く。1 つのプロンプトで送ったコメントは同じ結果になる
- **届いたの確定**: daemon は module が push した人の行と追いつきの読み (DR-0045 §2、§7) を `parseCommentBlocks` で読み、そのセッションの `sent` / `unconfirmed` の cid のブロックを見たら `delivered` にして `row_uuid` を書く。読む人の行は 3 通り (Context): `type:"user"` の `promptSource` が `typed` / `queued` の行の文と、`queued_command` の添付の行の `attachment.prompt` (`queuedPersonPrompt`)。`type:"user"` の行が人の発言かは、webui の TL が人の発言として描く行の決め方 (protocol の `classifyUserMessage` が `user-prompt` とする行) と同じ 1 つの規則で決め、daemon と webui で別の規則を持たない (DR-0058 §11 と同じ考え方)。ccmsg で届いたメッセージ・harness の差し込み (`isMeta`)・compact の要約の行は読まない。照合はそのセッションの記録を読んだ時 (§8) にも走る。`unconfirmed` のうち照合できないものには、人の操作「下書きに戻す」(`draft` に戻す) と「送った扱いにする」(`sent` にする、P32) を置く
- **行が出るまでの描き方**: `sending` / `sent` / `unconfirmed` のコメントは、transcript に行が出るまで記録から描く (TL の送った時点の位置と 💬 のフィルタ)。送信の列で順番を待つ `sending` と、その間に daemon が止まって `unconfirmed` になったものは送った時点 (`sent`) を持たないので、書いた時点 (`written`) の位置に描く (§2 の「未送信のものは書いた時点」と同じ)。未送信の一覧からも TL からも消える間を作らない。`sent` を持たない `unconfirmed` も照合の対象で、「下書きに戻す」「送った扱いにする」を出す。`delivered` になったら transcript の行の描画に替わる (cid で同じものと分かる)
- **btw のフラグの付いたコメント**: 本体の context に入れず、1 件ずつ btw として走らせる (§14)。送る順序の対象外
- **FAB の下書き**: 1 件ずつ別のプロンプトとして送る (空行で連結しない)。1 件ずつ送れば、turn の最中に続けて送っても transcript では 1 件 1 行になり、送った下書きと人の行を 1 対 1 で照合できる (Context)。model には同じ turn に別の text block で並んで届く。送る前に添付が在るかを確かめ、無ければ送らずに `attachment_missing` を返す (§15)。結果はコメントと同じく `accepted` なら `sent`、`unconfirmed` なら `unconfirmed`、`not_delivered` なら `queued` に戻して `send_error` に理由を書く。`not_delivered` が出たら残りを送らない (P7)
- **FAB の下書きの届いたの確定**: daemon は push された人の行と追いつきの読みで、3 通りの人の行 (上の「届いたの確定」と同じ) の文と、そのセッションの `sent` / `unconfirmed` の下書きの送った文 (添付を置き換えた後) を `pairLandedPrompts` で組み、組めた下書きを届いたとして記録を消す (§15)。文の正規化は `promptTextKey` (両端の空白を落とす) で、今の FAB の未確認の自動解消 (DR-0035 §5) と同じ部品を使う。行の時刻は `queued_command` では待ちに入った時刻、`queued` の行では待ちから出た時刻で、どちらも送った時刻より後になる
- **照合できないまま turn が終わった時**: 送ったコメントと FAB の下書きが `sent` のまま、送った後の最初の turn が終わって idle になった時点でまだ届いたと照合できていなければ、`unconfirmed` に落として人の目に出す (P35)
- **全部送る順序**: コメントを先、FAB の下書きを後に送る
- **今すぐ送る** (`comment_add` の `send_now`): そのコメント 1 件を同じ列で上と同じ形で送る (btw なら btw の列に入れる)
- turn の最中に続けて入れたプロンプトは連結されず 1 件 1 行で残り、model には同じ turn に並んで届く (Context)。並んで届くことは、プレビューのエリア (§13) で人が通読して送る形で扱う

### 12. TL と Files の見せ方

- **届いたコメントのバブル** (`CommentBubble`、右寄せは統括案、kawaz の異論なし): 送ったコメントは、ユーザの発言の側 (右寄せ) の専用のコメントバブルとして出す。transcript の人の発言の行の本文がコメントのブロックだけでできていれば、その行をブロックごとのバブルとして描く (まとめて送った時は複数のコメントバブルに見える)。cid から記録を引いてアンカーへのリンクと選んだ文字を出す。最後の行の右端に「返信」ボタン (§3)。行が出る前は記録から同じ部品で描く (§11)。コメントのバブルで描く行も人の発言の行なので、👤 のフィルタ・「↑前 | 次↓」・「↑最新のプロンプトへ移動↑」の対象に入る (窓の中と外で同じ。DR-0058 §11 の判定 `user-prompt` のまま)
- **`comment_reply` の応答** (`CommentReplyBubble`): transcript の `comment_reply` の呼び出しの行 (結果が `commentReplyRecorded` で読めるもの) を、普通のエージェントの応答とほぼ同じに見せる。バブルの一番上に、`comment_reply` による応答と分かる少しの装飾・元のコメントの場所へ飛ぶリンク・返信先の cid のユーザのコメントを出すヘッダを足す。本文は呼び出しの行の `body` を応答と同じ markdown で描く。最後の行の右端に「返信」ボタン (§3)。表示の正本は transcript の行 (DR-0040 §4 と同じ流儀)。TL の並びでも普通の応答と同じ扱いで、fold (「N items」) の中に入れず、そこで fold の並びが切れる (前後の tool の呼び出しは別々の fold になる)。呼び出しの結果の行は吹き出しに含め、TL の項目として出さない。本文は 🔍 の検索の対象 (応答の本文と同じ)
- **btw のコメントと答え** (`BtwBubble` をコメントの記録で描く形に寄せる、§14): btw のフラグの付いたコメントとその答えの組を、送った時点の位置 (`sent.after_uuid` の行を含む項目の直後。置き方は DR-0060 §7 の `after_uuid` と同じ) に 1 項目で出す。質問の側はコメントの見た目 (種類・引用・選んだ文字・本文)、答えの側は今の btw の答えの見た目で、全体を点線の枠で囲んで本体の context に入っていないことを示す。答えの最後の行の右端に「返信」ボタン (§3)。`failed` / `canceled` の答えの下に「もう一度聞く」(`comment_btw_retry`)
- **アンカーの印** (§2 の表): アンカーがメッセージ・選択範囲・コメントのコメントの付いたバブルには常に 💬 を数付きで出す (数と置き場は P8)。範囲選択のコメントは、バブルの中の選んだ文字を探し直した範囲 (§2) をハイライトし、範囲の後ろに 💬 を置く (塗り方は P31)
- **Files の箇所**: アンカーがファイルの箇所のコメントは、Files でそのファイルを開いた時に、今の内容の中から文字で探し直した箇所をハイライトし、後ろに 💬 を置く。探し直し方と、見つからない時の扱いは P20 / U3
- 💬 (項目の印とハイライトの後ろの 💬) を押すと 💬 のフィルタの画面 (§13) へ移り、そのコメントを選んだ状態にする

### 13. 💬 のフィルタの画面とプレビューのエリア

- **ツールバー**: TL のツールバーの並び (🔔 🔐 ⭐ 👤 🔍) に 💬 を置く (位置は P4)。数は未送信のコメントの数 (`status` が `draft`)。FAB の下書きは数えない (FAB 自身に出す、§15)。数の部品と決まりは `CountBadge` (DR-0050)。agent の TL では出さない
- **URL**: `?filter=comment`
- **コメントの一覧**: フィルタの画面には、コメント (未送信 / 送信中 / 入れた / 届いた / 未確認が分かる) を並べる。届いたコメントバブル (§12) もここに出る。未送信のコメントには個別の送信ボタン (と直す・消す) を、未確認のコメントには「下書きに戻す」「送った扱いにする」を付ける。個別のコメントから、コメントした場所 (uuid の項目、ファイル、返信先のコメント) へ飛べる (項目は DR-0058 §6 の移動、ファイルは Files のその箇所を開く)。窓の外のエージェントの返信は記録の `quote` で出す (本文は transcript)。並べ方は P10
- **解決済み**: ✅ の付いたスレッドは既定で出さない。`[ ] 解決済みを表示` のトグルで出す (§6)
- **プレビューのエリア**: フィルタの画面の一番下に、まとめて送る前に通読する「プレビューのエリア」を置く (上は終わった話題、下がこれからの話、の並び)
  - 中は「FAB の下書き」と「コメント」の 2 つのセクション (2 つの上下の並びは P11)
  - ボタンはセクションごとの送信・全部送る・1 件ずつの送信 (どれも `queue_send`)。全部送る時はコメントを先、FAB の下書きを後に送る
  - btw の付いたものは本体の context に入らず 1 件ずつ別に走るので順序の対象外で、同じセクションに btw の印付きで並べる
  - エリアには実際に届く形のまま見せる: コメントのセクションは `commentBlockText` で作った 1 つのプロンプトの全文、FAB の下書きは 1 件ずつ添付を置き換えた後の文を 1 件ずつ分けて見せる。続けて送ったものは連結されないが「同じ turn に並んで届く」ことを添える

### 14. btw のフラグと btw モードの吸収

- btw の付いたコメントはエージェントの context に足さず、daemon が DR-0060 の btw コマンド (`claude -p --resume <sid> --fork-session --no-session-persistence`) で 1 件ずつ別に走らせ、結果を webui に送って同じように混ぜて表示する。プロンプトは DR-0060 §3 の前置きの後にコメントのブロック (§4) を置いたもの。添付は送る時に `[FILE<N>:<name>](<path>)` に置き換える。effort は記録の `effort` (無ければセッションが今走っている値、DR-0060 §2)
- まとめて聞かない (btw 同士の文脈が混ざるため)。cache の読み込みの重複は気にしない
- **順に走らせる**: btw は daemon 全体の上限 (`BTW_MAX_CONCURRENCY`) の空きを待って、列に入った順に走らせる。上限に達していても断らない (全部送るで 5 件以上を送っても `btw_busy` にしない)。待っている間の質問は `sending`
- **質問の状態**: `draft` → (送る) → `sending` (列で空きを待つ) → `sent` (fork を起こした、送った時点 `sent` を書く)。btw コマンドを起こせなかった時は `draft` に戻して `send_error` に理由を書く
- **答えの記録**: fork を起こした時に daemon が答えの記録 (`author: "btw"`、アンカーは質問の cid、`status: "running"`) を作って cid を振り、stream-json の読み方 (DR-0060 §4) で `body` を伸ばし、終わりを `status` に書く
- **もう一度聞く**: 最後の答えが `failed` / `canceled` の質問は `comment_btw_retry` でもう一度聞ける。同じ質問から新しい答えの記録を作る (P30)
- **btw の答えへの返信**: スレッドの {btw の質問, btw の答え} の組を順に並べ、新しい質問を足して渡す。btw を外して本体に返信する時も同じ組を「何に対する返信か」として渡す (本体はその btw を見ていないため。統括案、kawaz の異論なし)。btw の fork に渡す組の答えは全文、本体に渡す組の答えは先頭の引用 (`quote` と同じ長さ) にする。組の書き方は `commentBlockText` が持つ (P3)

  ```
  <comment cid="c2v8d" reply_to="c9q4r" on="btw の答え" quote="c9q4r の本文の先頭 40 文字…">
  <btw_thread>
  <btw_question cid="c4n7b" on="応答" quote="…">c4n7b の本文</btw_question>
  <btw_answer cid="c9q4r">c9q4r の本文 (本体に渡す時は先頭の引用)</btw_answer>
  </btw_thread>
  続きの質問
  </comment>
  ```

- **btw の中では `comment_reply` を使わせない**。module は `-p` に tool を登録しないので、btw の fork はもとから `comment_reply` を持たず、答えは本文に書く (§5 の btw の fork)。止めるための引数 (`--disallowedTools`) と settings の `permissions.deny` は付けない。fork に ccmsg の tool が無いことは cache に効かない (Context)。本体で ToolSearch で読み込み済みの ccmsg の tool は fork の request の形に載るが、fork は末尾の system で「no longer available」と知らされ、handler も無い。fork がそれを呼んだ時の挙動は確かめていない (「測ること」4)
- btw コマンドに渡す model は正式な id (1M なら `[1m]` 付き) で、別名で cache が外れる件は DR-0060 §2 で直した
- btw の答えは「本体の context に入っていない」ことがひと目で分かる見た目にする (今の btw の点線の枠、DR-0060 §7)
- **btw モード (DR-0060) を吸収する** (裁定 1): FAB の btw のチェックボックスで送るものは、アンカーがタイミングの btw コメントにする。FAB の btw の今の機能 (⏱️ の effort、添付、取り消し) は落とさない。btw の記録・保存・配り方・表示の部品をコメントの仕組みに寄せる:

  | DR-0060 の部品 | 寄せた先 |
  |---|---|
  | `btw_ask` | `comment_add` (アンカーはタイミング、`btw: true`、`effort`、`attachments`)。FAB の「今すぐ送る」が付いていれば `send_now` |
  | `btw_cancel` | `comment_btw_cancel` |
  | `btw_busy` | 断らずに空きを待つ |
  | `BtwRecordSchema` の質問 (`prompt`) | 質問のコメントの記録 (`author: "user"`) |
  | `BtwRecordSchema` の答え (`response`、`status`、`model`、`effort`、`tool`、`ended_at`、`error`) | 答えの記録 (`author: "btw"`、P24) |
  | `after_uuid` / `ts` | 質問の記録の送った時点 (`sent`) |
  | `<sid>.btw.jsonl` | `<sid>.comments.jsonl` |
  | `ev:"btws"` / `ev:"btw"` | `ev:"comments"` / `ev:"comment"` |
  | `BtwBubble` (質問は `prompt` の文) | 同じ部品で、質問の側をコメントの見た目で描く |

  変えずに使うもの: btw コマンドと標準入力・標準出力の契約 (DR-0060 §2、`btw_command`)、前置き (§3)、stream-json の読み方と答えの組み立て (§4)、同時の上限の値 (`BTW_MAX_CONCURRENCY`)、SESSIONS の `Non-interactive` (§11)、点線の枠

- **移行の段** (実装の段階 5、下):
  1. コメントの btw (コメントの記録で走らせ、答えの記録を作り、`BtwBubble` をコメントの記録で描く) を入れる。この間、DR-0060 の `btw_ask` と FAB のチェックボックスは今のまま動く
  2. FAB の btw のチェックボックスの送信を `btw_ask` から `comment_add` に替える
  3. 既にある `<sid>.btw.jsonl` の記録をコメントの記録に写す (P25)。写した記録は元の btw の id (`btw_id`) を持ち、同じ `btw_id` の記録が既にあれば写さない (写しの途中で止まって読み直しても二重にしない)
  4. `btw_ask` / `btw_cancel`・`ev:"btws"` / `ev:"btw"`・`BtwRecordSchema`・`<sid>.btw.jsonl` の読み書きを消す
- DR-0060 の本文はこの DR では変えない。移行の段 4 の時に、DR-0060 を archive にするか、btw コマンドと前置きの契約だけを残す形に書き換えるかを決める

### 15. FAB のキュー

- FAB の送信もキューに置ける。キューは単に送るタイミングを後ろにずらすだけで、エージェントには通常のプロンプトが複数届いたように見える (comment の形で包まない)。btw でない FAB の下書きはコメントにせず、アンカーを持たない (送る前は TL のどこにも出ず、送った後は transcript の人の行として出るので、位置を決めるアンカーが要らない。時点の記録 `written` / `sent` は持つ)
- まとめて送る時も 1 件ずつ別のプロンプトとして送る (§11)。transcript では 1 件 1 行になり、model には同じ turn に並んで届く。並んで届くことは、プレビューのエリア (§13) で人が通読して送る形で扱う
- 未送信の FAB の下書きの数は FAB 自身に出す (TL の 💬 はコメントの数だけ)
- **下書きの記録** (`PromptDraftRecordSchema`): `{ kind: "draft", id, session_id, written, sent?, updated_at, text, attachments: [{ n, name, path }], status: "queued" | "sending" | "sent" | "unconfirmed", send_error? }`。`id` は daemon が振る UUIDv4 (エージェントに見せないので cid にしない)
- **送り終えた下書きは記録ごと消す** (裁定 3)。「送信済み」の印で残さない (残す意味が無い)。状態の移り方:
  - `queued` → (送る) → `sending` → `sent` (入れた) / `unconfirmed` / `queued` (`not_delivered`、`send_error` 付き)
  - `sent` / `unconfirmed` → 送った文が transcript の人の行として届いたのを確かめた時 (§11) に記録を消す。届くまでは `sending` / `sent` で持つ (未確認になった時に下書きに戻す・送り直すために要る)
  - `unconfirmed` → 人の操作「下書きに戻す」で `queued`、「送った扱いにする」で記録を消す
  - `queued` → 人の操作「消す」(`prompt_queue_delete`) で記録を消す
- **消すのは記録だけで、添付のファイルは消さない**。送った本文の `[FILE<N>:<name>](<path>)` が添付のパスを指していて、エージェントが後から読むため。添付は `<stateDir>/sessions/` の 30 日の掃除に任せる
- **添付の置き場**: 下書き (とコメント) の添付は、キューに置いた時点で daemon が state dir の下に移す (OS の TMPDIR は OS が消しうるため。置き場は P29)。送る時に添付が在るかを確かめ、無ければ送らずに `attachment_missing` を返し、下書きは `queued` のまま残す
- **添付の番号**: 添付の番号は daemon がセッションごとに 1 から順に振る `[FILE<n>]` (下書きごとに 1 から数え直さない。人が読むものなので連番にする)。キューに置く時 (`prompt_queue_add`) は全ての添付に、直した時 (`prompt_queue_update`) は記録にまだ無い添付 (パスで見分ける) にだけ、セッションの続きの番号を振り、本文の `[FILE<N>]` も同じ対応で書き換える。記録に既にある添付は番号を変えない。番号を振るのは sid ごとの列の中 (§11)。番号の続きは daemon のセッションごとの状態に保存する (P12)
- **op**: `prompt_queue_add { session_id, text, attachments }` → `{ ok: true, draft }`、`prompt_queue_update { session_id, id, seen_updated_at, text, attachments }` → `{ ok: true, draft }`、`prompt_queue_delete { session_id, id, seen_updated_at }` → `{ ok: true }` (記録を消す) (どれも user role、`queued` の記録だけ。`seen_updated_at` が違えば `conflict`)。送るのは `queue_send` (§11)、未確認の扱いは `unconfirmed_settle` (§9)
- FAB に「今すぐ送る」のチェックボックスを置き、外した送信はキューに置く (P13)。btw のチェックボックスを入れた送信は FAB の下書きでなく、アンカーがタイミングの btw コメントになる (§14)

### 16. 既存の DR との関係

- **[DR-0060](./DR-0060-btw-mode.md) (btw モード)**: 吸収する (§14、裁定 1)。btw コマンド・前置き・答えの組み立てはそのまま使い、記録・保存・配り方・FAB の入口はコメントの仕組みに寄せる。`btw_busy` で断る代わりに空きを待つ。§12 の「btw の続きの質問はしない」は、btw の答えへの返信 (組を並べた新しい btw、fork を resume しない) で変わる。DR-0060 の本文の扱いは移行の段 4 で決める
- **[DR-0039](./DR-0039-all-mods-and-typed-tools.md) §3 (typed tool)**: `comment_reply` は typed tool の規約 (valibot の入力、結果を文で返す、`next` を呼ばない、input schema の導き方) に従い、登録の形 (deferred、description は数語) も同じ。使い方の正本は ccmsg の skill の本文に置き、skill の description に返し方の 1 文を足す (§5、裁定 2)。description に tool のフルネームと引数まで書くのは、今の description (tool の名前と読む場面だけ) より一歩踏み込む
- **[DR-0035](./DR-0035-user-input-via-composer-fill.md)**: 送信は `prompt.send` の経路をそのまま使う。§1 の「返信方法の指示行を付けない」に揃え、コメントのブロックにも返し方の指示を付けない (§4)。コメントの送信は人が送るボタンを押した (か「今すぐ送る」で付けた) 時の人の入力で、エージェントが人の入力を作る経路 (§4) ではない。ブロックにエージェントの書いた文が引用として載ることと、足されるのが引用で許可ではないことは §4
- **DR-0039 §6**: 「足されるのは文脈であって権限ではない」を、コメントのブロックの中の引用にも当てる (§4)
- **[DR-0040](./DR-0040-permit-request-tool.md) §4 / [DR-0045](./DR-0045-say-speaks-in-tool-shown-from-transcript.md) §7**: `comment_reply` の応答の表示の正本は transcript の行で、daemon の記録は本文を持たない (cid・返信先・時点・tool_use の id・先頭の引用だけ)。本文を記録に持つのは transcript に無い btw の答えだけ
- **[DR-0050](./DR-0050-timeline-notification-badges.md) / [DR-0058](./DR-0058-timeline-bookmarks.md) / [DR-0022](./DR-0022-in-view-search.md)**: ツールバーに 💬 を足し、`TimelineFilter` に `comment` を足す。フィルタの入り方・解除・項目のクリックでの移動は同じ決まり。💬 のフィルタの画面は、項目を CSS で隠すだけでなく、コメントの一覧・解決済みのトグル・プレビューのエリアを持つ点が他のフィルタと違う。💬 の字の重なりは U5、範囲選択のツールバーと「jsonl ⭐」の組の置き場の重なりは U6
- **[DR-0025](./DR-0025-workflow-drilldown.md)**: agent の TL の項目へのコメントはこの DR では付けない (§2)
- **[DR-0015](./DR-0015-composer-attachments.md)**: キューに置いた下書きの添付を state dir の下に移し、番号をセッションごとにする (§15)。キューを通さない FAB の送信の番号は U7
- **[DR-0061](./DR-0061-no-clear-handling.md)**: `/clear` で sid が替わった時の扱いは考えない。コメントもキューも sid のもの

## 裁定 (kawaz 2026-11-22)

1. **DR-0060 の btw モード (FAB の btw のチェックボックス) をコメントの仕組みに吸収する** (§14)。FAB の btw は、アンカーがタイミングの btw コメントになる
2. **`comment_reply` で返せという指示は、ccmsg の skill の description に置く** (§5)。`<comment cid>` が届いたら `mcp__ccmsg-v1__comment_reply` で返す旨を書く
3. **FAB のキューの下書きは、送信が済んだら「送信済み」の印で残さず、記録そのものを消す** (§15)。消すのは届いたのを確かめた時と「送った扱いにする」を押した時で、添付のファイルは消さない

## 統括の推し (主素材に無い判断、kawaz の確認待ち)

- **P2: §4 の表に無い項目の `on`** は、TL の項目の種類の名前 (`tool Bash の呼び出し`、`say`、`許可依頼`、`<agentid> からの ccmsg` 等) にし、`quote` は TL がその項目の見出しに描く文の先頭にする。段階 1 で使っている語は次のとおり:
  - `tool <name> の呼び出し` (専用の見せ方の無い tool の `quote` は見出しの `tool_use: <name>`)、`tool の結果` (Agent の tool の結果も、呼び出しと結び付けられないのでこの語)
  - `say`、`tool PushNotification の呼び出し`、`許可依頼`、`turn interrupted`、`! コマンドの実行`、`! コマンドの出力`
  - `<agentid> への指示` (SendMessage / Agent)、`<from> からの応答` (peer-message / task-notification)、`<from> からの ccmsg`、`<to> への ccmsg` (送った側)
  - これらの項目の「返信」の置き場も §3 のとおり
- **P3: ブロックのエスケープと綴り**: 属性の値は `&` `"` `<` `>` を XML の実体にし、改行・CR・タブは数値の実体 (`&#10;` `&#13;` `&#9;`) にする (空白を詰めない。`parseCommentBlocks` で元の文に戻すため)。入れ子の本文 (`<selection>`、本文、btw の組の質問と答え) は `&` `<` `>` を実体にする (本文の中の `</comment>` 等のタグに読める文字列が、ブロックの区切りに読まれないように)。`<path>` はセッションの cwd の中ならその相対、外なら絶対。btw の組のタグ名 (`btw_thread` / `btw_question` / `btw_answer`) は §14 の例のとおり
- **P4: ツールバーの 💬 の位置は 👤 と 🔍 の間** (統括案、kawaz の異論なし)。DR-0058 §11 と同じく今の並びの位置を動かさず、数を持つバッジの並びの最後に置く (🔍 は数を持たない)
- **P6: subagent / teammate からの `comment_reply` は断る** (`permit` と同じ形、DR-0040 §9)。コメントは本体に届くもので、subagent が cid を知る経路が無い
- **P7: FAB の下書きをまとめて送る時に `not_delivered` が出たら、残りを送らずにキューに残す**。順序を保ち、届かない理由 (ダイアログ中等) の間に後ろの件が先に入るのを避ける
- **P8: 項目の 💬 の印は項目の右上の組に置き (「jsonl 💬 ⭐」の並び)、数はそのバブルをアンカー (メッセージ・選択範囲・コメント) にした人のコメント (未送信も含む、`deleted` を除く) の数**。☆⭐ と同じく項目の高さに入れない
- **P9: Files の範囲選択のツールバーはビューアの選択範囲の右上に置く** (Files には吹き出しが無いため)
- **P10: 💬 のフィルタの一覧の並び**: 届いたコメントのバブルと `comment_reply` の応答は transcript の行の位置に、行が出る前の送ったコメントと btw のコメントと答えは送った時点の位置 (§12) に、未送信のコメントは、アンカーがメッセージ・選択範囲ならその項目の直後、コメントなら返信先の直後、タイミングなら書いた時点の位置、ファイルの箇所なら書いた時刻の位置 (`slotsByTime`) に置く。窓の外のものは daemon の記録から時刻の位置に合流させる (DR-0058 §5 と同じく過去分は読まない)
- **P11: プレビューのエリアのセクションは「コメント」を上、「FAB の下書き」を下に並べる**。全部送る時の送る順と上下を揃え、上から読んだ順がエージェントに届く順になるようにする
- **P12: FAB の下書きの添付の番号の続きは `<sid>.queue.jsonl` の中に持つ** (別のファイルを持たない)。下書きの記録は消えるので記録の最大からは導けず、番号を振るたびに `{ kind: "file_seq", next }` の行を足す (読む時は最後の行が勝つ)。P34 の書き直しでもこの行は残す
- **P13: FAB の「今すぐ送る」のチェックの状態もセッションごとに localStorage に覚え、コメントのフォームとは別のキーにする**。FAB は既定で付いている (今の送信と同じ)
- **P14: 解決の印 (✔️ / ✅) の置き場は、スレッドの各バブル (届いたコメント、`comment_reply` の応答、btw の答え) の足元と、💬 のフィルタのスレッドの頭**。どれを押してもそのスレッドに効く
- **P19: `[ ] 解決済みを表示` のトグルの状態は覚えない** (フィルタを開くたびに既定の「出さない」)
- **P20: ファイルの箇所のアンカーは「選んだ文字 + 前後の少しの文字 + コメントした時点の行」で持ち、表示の時は今の内容の中から文字で探し直す**。裁定待ちの問いの md のように、エージェントが答えた問いの節を消す・直すファイルでは、行番号だけだとすぐずれるため。探す順は「前後の文字と選んだ文字の並び」→「選んだ文字だけ (1 か所だけ当たる時)」。プレビューは描画された文字の中で探す。見つからなければ「元の場所が無くなった」と出し、コメントと引用は残す (スレッドは読める)
- **P21: 時点の記録 (`written` / `sent`、それぞれ時刻とその時点の transcript の最後の行の uuid) をアンカーとは別の field で全ての記録に持つ**。タイミングのアンカーは自分では値を持たず、位置は送ったものは `sent`、未送信は `written` で決める。btw の答えの位置もどのアンカーでも `sent` で決まるので、アンカーの中に時点を持つと、他の種類のアンカーにも同じ値を重ねて持つことになるため
- **P24: btw の答えの走っている状態 (`status`、`model`、`effort`、`tool`、`ended_at`、`error`) は答えの記録 (`author: "btw"`) に持つ**。質問は人のコメントの記録で、答えはその返信の記録なので、DR-0060 の 1 つの記録の質問の側と答えの側を 2 つの記録に分けて持つ
- **P25: 既にある `<sid>.btw.jsonl` の記録は、移行の段 3 で daemon がそのセッションの記録を初めて読む時にコメントの記録 (質問と答えの 2 つ、cid を振る) に写し、写し終えたら `<sid>.btw.jsonl` を消す**。読める間に写さないと、FAB で聞いた btw が TL から消えるため
- **P26: md プレビューの `on` の行は、選んだ文字を含む md の塊 (段落・見出し・箇条書きの項目) の元の文の始まりの行** (mdast の節点の位置)。コメントした時点の行で、送る時に探し直さない。エージェントは選んだ文字と引用で探せる
- **P27: キューを通さない FAB の送信 (`user_prompt`) も、同じ sid ごとの列に並べる**。module の `prompt.send` は 1 つずつ処理されるので、列の外から入ると、列の中の送信の 12 秒の期限を同じ理由で食う
- **P28: コメント・キュー・解決の push は `session_status_subscribe` (Files / Status / Timeline のタブの間に張られている) に載せる**。専用の subscribe を増やさず、FAB を出すタブの組と購読の張られるタブの組が同じなので、どのタブでも FAB の数が出る。transcript の無いセッション (`SessionView` が status を購読しない) ではコメントを付ける項目も無い
- **P29: 添付の置き場は `<stateDir>/sessions/<sid>.att-<uuid><ext>` の平らなファイル**。`<stateDir>/sessions/` の掃除 (30 日) がディレクトリを消さないので、ディレクトリを作らずに同じ掃除に乗せる。送った後もエージェントが読むので、送っても消さない
- **P30: もう一度聞く時は、質問の送った時点 (`sent`) を聞き直した時点に書き換え、新しい答えの記録 (新しい cid) を作る**。前の失敗・取り消しの答えの記録は残し、`BtwBubble` は最後の答えを出して、前の試みは理由の 1 行で畳む。fork は聞き直した時点までの会話を読むので、位置もそこに移す
- **P31: 範囲のハイライトは CSS Custom Highlight で塗り (検索のハイライトと同じ仕組み、名前は別)、範囲の後ろの 💬 は本文の DOM に差し込まず、範囲の最後の矩形の後ろに重ねて置く** (描画された文字・検索・選択を変えない)
- **P32: コメントの「送った扱いにする」は記録を `sent` (入れた) にする**。`delivered` にはせず、行が見つかれば後から `delivered` になる。行が出るまでは記録から描く (§11)。FAB の下書きの「送った扱いにする」は裁定 3 のとおり記録を消す
- **P35: 送ったコメントと FAB の下書きが `sent` のまま、そのセッションの turn が終わって idle になった時 (送った後の最初の turn の終わり) にまだ届いたと照合できていなければ、`unconfirmed` に落とす**。turn の終わりは module の事実の `turn` が responding から idle に変わったこと (DR-0035 §3) で知る。落ちた下書きは `ev:"comments"` の drafts に入って人の目に出、そこからは今の `unconfirmed` の操作 (下書きに戻す / 送った扱い、`unconfirmed_settle`) で片付ける。時間 (タイマー) では落とさない。届いていればその turn の中で transcript の行が出ているはずで、turn が終わっても無ければ、連結や文の書き換えで照合できなかったか、届いていない。daemon が既に知っている turn の終わりを使えば、待つ時間の根拠を持たずに済む。「送った後の最初の turn」は送った後に始まった最初の turn で、turn の途中で送ったもの (その行は turn の終わりに出る) はその turn の終わりでは落とさず、次の turn の終わりで落とす。落とすのはその 1 回だけで、それより前に始まった turn の後に送ったものに限る (人が「送った扱いにする」で `sent` に戻したものは、以後の turn の終わりでは落とさない)。前の turn がいつ始まったかは daemon のメモリにだけ持ち、daemon の起動の後に最初に終わる turn は、それより前に送った全てにとって最初の turn として扱う
- **P34: `<sid>.queue.jsonl` は、daemon がそのセッションのキューを初めて読んだ時に、消えた下書き (`draft_removed` の付いたもの) の行と古い版の行を捨てて書き直す (compaction)**。今ある下書きの最新の行と最後の `file_seq` の行だけを一時ファイルに書いて rename で置き換え、sid ごとの列の中で行う。下書きは送るたびに消えて行が溜まる一方なので、読み戻しの時に縮めないとファイルが膨らみ続ける。書き直しは読み戻しの時だけにし、追記の途中では行わない (書き込みの経路を 1 つに保つ)
- **P33: 「`<comment>` を送った時に `comment_reply` で返すか」を測る項目に足し、実装の段階 2 の終わりに測る** (「測ること」3)。裁定 2 は model が skill の description に従う前提に立ち、外れると返信がスレッドに結ばれない (§5 の弱点) ので、前提を観測で確かめる。段階 2 に置くのは、測るのに `comment_reply` と skill の文が要り、先に測るには使い捨ての plugin を別に作ることになるため。段階 1 は返信が本文でも使えるので、段階 2 の結果を待たずに進められる

## 未決 (kawaz の判断を待つ)

- **U3: Files のコメントの位置がファイルの変更でずれた時の扱い**。統括の推しは P20
- **U5: 💬 の字が DR-0022 の検索対象のトグル 💬 (ccmsg 経由のメッセージ) と重なる**。🔍 のフィルタの画面とツールバーで同じ字が別の意味になる。どちらかの字を変えるか、そのままにするか
- **U6: 範囲選択のツールバーの置き場が、ユーザの発言の「jsonl ⭐」の組 (DR-0058 §3、吹き出しの右上の外側) と同じ所になる**。ツールバーを出している間は組の左に並べるか、組を隠すか
- **U7: キューを通さない FAB の送信の添付の番号**。§15 はキューの下書きだけをセッションの番号にする。直送の下書きが今のまま下書きごとに 1 から数えると、キューの下書きと同じ番号の `[FILE<n>]` が同じ会話に並ぶ。直送もセッションの番号にするか
- **U8: キューに置いた FAB の下書きの effort**。今の FAB の ⏱️ / 📌🏛️ の選択 ([DR-0041](./DR-0041-request-model-effort-override.md) §6.3) を下書きに持たせるか。統括の推しは「持たせない」(送る時点のセッションの通しで走る。キューは送る時機をずらすもので、選んだ時と送る時で通しが変わりうるため)
- **U9: thinking の中の範囲選択**。§4 は thinking へのコメントに中身を書かない。thinking の中の文字を範囲選択した時、選んだ文字もエージェントへの文から落とすか (記録には持つ)、選んだ文字だけは載せるか
- **U10: `[ ] 解決済みを表示` のトグルの置き場** (画面の上 / 下 / 両方)。統括の推しは上 (下は通読と送信のエリアなので、表示の切り替えは一覧の頭に置く)
- **U11: エージェントが解決にできるか** (`comment_reply` に解決の印を付けられるようにするか)。統括の推しは「しない」(解決は読んだ人が決める)
- **U12: 解決済みのスレッドの TL の上の 💬 と選択範囲のハイライト**。統括の推しは「出したまま薄くする」
- **U13: 解決済みのスレッドに未送信のコメントが加わった時・新しい返信 (人の返信、`comment_reply`、btw の答え) が来た時**。統括の推しは「daemon が解決を外す」(隠れたままにしない)

## 測ること

1 と 2 は受理の前に測った ([findings 2026-11-22-dr62-btw-cache-and-prompt-concat](../findings/2026-11-22-dr62-btw-cache-and-prompt-concat.md))。3 は実装の段階 2 の終わりに測り、§5 に反映した (P33)。4 はまだ測っていない (btw のフラグの付いたコメントが要る。実装の段階 5)。

1. **対話のセッションからの btw の fork で cache が当たるか** (測った): fork に ccmsg の tool が無いことは cache を切らない (tool の読み込みの前後とも)。外れたのは model の別名を渡した時で、DR-0060 §2 で直した。§14 に反映した
2. **turn の実行中に続けて送ったプロンプトが連結されて届くか** (測った): 連結されず 1 件 1 行で、行の形は 3 通り。model には同じ turn に並んで届く。§11・§13・§15 に反映した
3. **対話のセッションで `<comment>` を送った時に `comment_reply` で返すか** (測った、[findings 2026-11-22-dr62-comment-reply-measure](../findings/2026-11-22-dr62-comment-reply-measure.md)): ccmsg の tool が未ロードのセッション (opus) で、コメント 1 つ・3 つを 1 つのプロンプト (エージェントの返信への返信を含む)・compact の後の 1 つの全部に、コメントごとに `comment_reply` を 1 回ずつ呼んだ。skill の本文は読まれず、description の 1 文だけで呼んだ。compact の後も skill の一覧にその 1 文が載っていた。呼んだ後に毎回、同じ内容の要約を応答の本文にも書いたので、description の 1 文に「同じ内容を応答の本文に書き直さない」を足した (§5)
4. **btw の fork が、本体で読み込み済みの `comment_reply` を呼んだ時に何が起きるか**。fork の request の形には載るが handler が無い (§14)。本体で `comment_reply` を読み込んだ後に btw のフラグの付いたコメントを送り、fork が呼ぶか、呼んだら何が返り、答えの記録がどう終わるかを見る

## 実装の段階分け

1. **コメントの保存と送信と 💬 のフィルタ**: `CommentRecordSchema` / `ThreadStateSchema` (アンカーはメッセージとコメント)、`<sid>.comments.jsonl`、sid ごとの列、`comment_add` / `comment_update` / `comment_delete` / `comment_resolve` / `queue_send` (コメントだけ)、届いたの確定、`ev:"comments"` / `ev:"comment"` / `ev:"comment_thread"` (`session_status_subscribe` に載せる)、`commentBlockText` / `parseCommentBlocks`、バブルの「返信」ボタン、`CommentForm` と「今すぐ送る」、`CommentBubble` (記録からの描画を含む)、項目の 💬 の印、ツールバーの 💬、`?filter=comment` の一覧・解決済みのトグル・プレビューのエリアのコメントのセクション
2. **`comment_reply`**: tool の登録 (deferred)、ccmsg の skill の description の 1 文と本文の節、op `comment_reply`、`commentReplyRecorded`、`CommentReplyBubble`、返信の返信。終わりに「測ること」3 を測る
3. **範囲選択とハイライト**: `SelectionToolbar`、アンカーの選択範囲・ファイルの箇所・コメントの中の引用、文字での探し直し、ハイライトと範囲の後ろの 💬、Files のソースと md プレビューのコメント (U3 の裁定の後)
4. **FAB のキュー**: `PromptDraftRecordSchema`、`<sid>.queue.jsonl`、`prompt_queue_*`、添付の移し替えと番号の振り直し、FAB の数、プレビューのエリアの FAB の下書きのセクションと全部送る
5. **btw のフラグと btw モードの吸収**: §14 の移行の段 1〜4 (コメントの btw と空き待ちの列ともう一度聞く、FAB の btw の付け替え、既存の記録の写し、DR-0060 の部品の削除と DR-0060 の扱いの決定)

各段階はその前の段階だけに依る。1 だけでも、バブル全体へのコメントを溜めて送る機能として使える。

## 実装の時に確かめること

- `tool.call` の handler で呼び出しの tool_use の id が取れるか (§5 の二重の記録を防ぐのに使う)。取れなければ、daemon が module の push した `comment_reply` の行の tool_use の id と入力で記録を結ぶ形に替える

## Alternatives Considered

| 案 | 採らない理由 |
|---|---|
| コメントの対象を uuid で渡す | エージェントは uuid も時刻も知覚できない。人が読むのと同じ手掛かり (種類と引用) なら、compact の後も文だけで指す所が分かる |
| daemon が「このセッションに返信の指示を付けたか」を覚え、初回のコメントにだけ指示を付ける | compact で指示が消え、daemon の印とエージェントの context が食い違う。覚える状態も増える |
| `comment_reply` だけ deferred にせず登録し、tool の説明文に返し方を書く | 説明文と input schema が毎 request (subagent の request も) の context に載る。本体の tools 列に有って btw の fork に無い tool が増える (deferred の tool が fork に無いことは cache を切らないと測ったが、deferred でない tool の場合は測っていない) (裁定 2) |
| コメントのブロックに返し方の一言を毎回付ける | DR-0035 §1 (返信方法の指示行を付けない) と当たる。指示は daemon の版で届き tool は module の版なので、tool を持たないセッションにも指示が届き、btw の fork にも届く。未ロードの tool を呼ばせるにはフルネームと引数が要り、ブロックが長くなる (裁定 2) |
| DR-0039 §5 の案内 (compact の後に足し直される) に返し方を 1 行足す | 案内は skill への誘導に留める規約 (DR-0039 §5) から外れる (裁定 2) |
| btw のフラグの付いたコメントをまとめて 1 つの btw で聞く | btw 同士の文脈が混ざる |
| FAB の下書きをまとめて送る時に空行で連結して 1 つのプロンプトにする | 短いプロンプトが連結されて別の意味になる。1 件ずつ送れば transcript の人の行と 1 対 1 で照合でき、model には同じ turn に並んで届く |
| コメントを webui の localStorage に溜める | 別のデバイスで見えず、送る前のコメントを他のデバイスから送れない |
| 保存を全セッション 1 ファイル (`bookmarks.json` と同じ形) にする | コメントは本文を持ち、1 件ごとに全セッション分を書き直すことになる (DR-0060 §9 と同じ) |
| 返信を `send` (ccmsg の別セッション宛ての送信) や普通の応答の本文で返させる | どのコメントへの返信かが構造で分からず、webui でコメントと結べない。返信にも cid を振れない |
| btw の中の `comment_reply` を `--disallowedTools` で止める | module は `-p` に tool を登録しないので、止める必要がもとから無い。`--disallowedTools` で request の tools を変えた時の cache への効き方は測っていない (fork に ccmsg の tool が無いことは cache を切らないと測った) |
| cid をセッションごとの連番にする | ファイルが掃除で消えた後に振り直した番号が、会話に残る古い cid と重なる |
| エージェントの返信の本文も daemon の記録に持つ | transcript の行と二重の正本になる (DR-0040 §4 の「中身を貯めない」) |
| コメントの push を `transcript_subscribe` に載せる | TL を表示していない間 (Files / Status) に届かず、FAB の数も出ない |
| 返信のアンカーをタイミングにし、返信先は別の field で持つ | 返信の中の範囲選択 (返信先のバブルの中の引用) を表せない。アンカーの種類にコメントを足せば、結び付く先が 1 つの field で済む |
| FAB の btw を DR-0060 の btw のまま残し、コメントの btw と並べる | btw の入口・記録・保存・push が 2 組になり、FAB で聞いた btw には返信 (スレッド) が付けられない (裁定 1) |
| TL の位置 (タイミング) と指す先 (メッセージ・引用・ファイル) を 2 つの概念に分ける | 全てのコメントが 1 つの結び付く先を持つ形の方が、記録と表示の分け方が 1 つの表で済む (kawaz 2026-11-22: タイミングもアンカーの 1 つの種類) |
| 選択範囲・ファイルの箇所を位置 (描画された文字の中の位置、行番号) だけで持つ | 翻訳・描画の変更・ファイルの書き換えですぐずれる (§2、P20) |

## Consequences

- protocol: `CommentRecordSchema` (アンカーの 5 つの種類、時点の記録、届いたの確定、btw の答えの状態)、`ThreadStateSchema`、`PromptDraftRecordSchema`、op `comment_add` / `comment_update` / `comment_delete` / `comment_resolve` / `comment_btw_cancel` / `comment_btw_retry` / `queue_send` / `prompt_queue_add` / `prompt_queue_update` / `prompt_queue_delete` / `unconfirmed_settle` / `comment_reply`、ErrorCode `conflict` / `state_not_writable`、`ev:"comments"` / `ev:"comment"` / `ev:"comment_thread"` / `ev:"prompt_draft"` / `ev:"prompt_draft_removed"`、`<sid>.queue.jsonl` の行の種類 (`draft` / `draft_removed` / `file_seq`)、`commentBlockText` / `parseCommentBlocks` / `commentReplyRecorded`、`TimelineFilter` の `comment`。移行の段 4 で `btw_ask` / `btw_cancel` / `ev:"btws"` / `ev:"btw"` / `BtwRecordSchema` / ErrorCode `btw_busy` が消える
- module: tool `comment_reply` の登録 (deferred) と handler。tool の一覧が変わるので、走っているセッションには再起動まで届かない (DR-0039 Consequences の hot reload と同じ)。その間に届いたコメントには、skill の「tool が無ければ本文で返す」で本文の返信になる
- skill: ccmsg の skill の description に返し方の 1 文を足し、本文にコメントのブロックの読み方と `comment_reply` の使い方の節を足す
- daemon: `<stateDir>/sessions/<sid>.comments.jsonl` と `<sid>.queue.jsonl` と添付のファイル、sid ごとの列、送信の組み立てと `userPrompt` での送信、push された人の行での届いたの確定、コメントの btw と空き待ちの列 (btw コマンドはそのまま)、返信の記録、解決の状態、`<sid>.btw.jsonl` の写しと削除
- webui: `SelectionToolbar`、`CommentForm`、バブルの「返信」ボタン、`CommentBubble`、`CommentReplyBubble`、コメントの記録で描く `BtwBubble`、項目の 💬 の印、範囲のハイライトと探し直し、Files の箇所のハイライトと探し直し、ツールバーの 💬、💬 のフィルタの一覧・解決済みのトグル・プレビューのエリア、解決の印、未確認の操作、FAB のキューとその数、FAB の btw の付け替え
- 未送信のコメントとキューの下書きと添付は、最後の書き込みから 30 日で消える (§8)
- daemon に溜めるのは人が置いたもので、届かなかった直送を daemon が預かる形 ([DR-0036](./DR-0036-retire-rooms-for-p2p.md) §3) ではない
- 「持たない」ことを壊す変更を止める試験の観点:
  - user role 以外のコメントの op は断り、何も保存しない
  - コメントの送信は `prompt.send` 以外の経路でセッションに入らない
  - 同じセッションへの送信は 1 本の列で順に走り、`draft` / `queued` でない項目と見ていた版の違う項目は送らずに項目ごとに断る
  - まとめて送ったコメントは 1 つのプロンプトに空行で区切ったブロックで入り、FAB の下書きは 1 件ずつ別のプロンプトで入る。全部送るはコメントが先
  - `parseCommentBlocks(commentBlockText(x))` が `x` に戻る (本文や引用に `<comment>` / `</comment>` / `&` / `"` を含むものも)
  - コメントのブロックとそれを並べたプロンプトに、返し方の指示行が入らない
  - 送ったコメントは、push された人の行にブロックが見えたら `delivered` になり、行が出るまでは記録から描かれる (未送信の一覧からも TL からも消えない)
  - btw のフラグの付いたコメントは本体のプロンプトに入らず、1 件ずつ btw になる。上限を超えた分は断らずに順に走る。FAB の btw も同じ記録 (アンカーがタイミングの btw コメント) になり、effort と添付を保つ
  - エージェントに送る文に uuid・時刻・描画の位置が入らない。thinking へのコメントの文に thinking の中身が入らない。`<selection>` は 2000 文字を超えない
  - `comment_reply` は本体に届いていない cid (未送信・btw・削除) を断り、記録した返信に新しい cid を振ってその cid と返信先の引用を結果の文で返す。同じ tool_use の id では 2 つ目の記録を作らない
  - `send_now` の無いコメントはどのセッションにも何も送らない
  - 未送信を持つスレッドと、見ていた後に記録が足されたスレッドは解決にできない。解決の付け外しはエージェントに何も送らない。💬 のフィルタは既定で解決済みのスレッドを出さない
  - Files / Status / Timeline のどのタブを見ていても `ev:"comment"` が届き、別の接続 (別のデバイス) にも届く。購読の始まりに `ev:"comments"` で保存された記録が届く
  - 選択範囲・ファイルの箇所のアンカーは、位置がずれても選んだ文字で同じ箇所に出る。選んだ文字が消えたら「元の場所が無くなった」になり、コメントは残る
  - キューの下書きの `[FILE<n>]` はセッションの中で重ならず、直した時に既にある添付の番号は変わらない。下書きの記録が消えて書き直された後も番号は戻らない。添付が無くなった下書きは送らずに残る
  - 送ったコメントと下書きが照合できないまま送った後の最初の turn が終わったら `unconfirmed` に落ち、下書きは ev の drafts に出る
  - 送った下書きは、届いた人の行を見るまで `sent` / `unconfirmed` で残り、見たら記録が消える。添付のファイルは記録が消えても残る。`ev:"comments"` の drafts に `sent` の下書きは入らない
  - btw の記録の写しは、途中で止まって読み直しても二重にならない

## 関連

- [DR-0060](./DR-0060-btw-mode.md) — btw モード (吸収する。btw コマンドと前置きはそのまま使う)
- [DR-0061](./DR-0061-no-clear-handling.md) — `/clear` の扱いを設計の責務にしない
- [DR-0039](./DR-0039-all-mods-and-typed-tools.md) §3、§5、§6 — typed tool の規約、compact の後の案内、足されるのは文脈であって権限ではない
- [DR-0035](./DR-0035-user-input-via-composer-fill.md) — 人の入力を composer への fill で入れる
- [DR-0045](./DR-0045-say-speaks-in-tool-shown-from-transcript.md) §2、§7 — module が push する行、tool の行を表示の正本にする
- [DR-0040](./DR-0040-permit-request-tool.md) §4 — daemon は人の状態を持ち、依頼の中身を貯めない
- [DR-0050](./DR-0050-timeline-notification-badges.md) / [DR-0058](./DR-0058-timeline-bookmarks.md) / [DR-0022](./DR-0022-in-view-search.md) — TL のツールバーとフィルタ
- [DR-0025](./DR-0025-workflow-drilldown.md) — agent の TL
- [DR-0049](./DR-0049-webui-plamo-translation-tab.md) §8 — 吹き出しの足元の行
- [DR-0010](./DR-0010-timeline-markdown-rendering.md) — md の描画 (mdast の位置)
- [DR-0015](./DR-0015-composer-attachments.md) — FAB の添付
- [DR-0046](./DR-0046-module-op-over-http.md) — module の `POST /op`
