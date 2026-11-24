# DR-0062: TL のメッセージと Files にコメントを付け、daemon に溜めて (または即時に) エージェントへ送り、エージェントは `comment_reply` でコメントごとに返信する

- Status: Accepted (2026-11-22、kawaz「どの件もそのまま進めて」) — 🟡 部分実装 (段階 1: protocol の `comments.ts`、daemon の `comments.ts` と `server.ts` のコメントの op・`session_status_subscribe` への push・届いたの確定・turn の終わりの未確認、webui の `comment-view.ts`・`timeline/comments.tsx`・Timeline の 💬 の印・返信・コメントの吹き出し・💬 のフィルタ。P27 (FAB の直送も送信の列に並べる) も入れた。段階 1 は未決の U12 を推しのとおり仮に入れた。段階 2 と、段階 3 のうち TL の分 (TL の吹き出しの範囲選択のコメント、`comment_add` の選択範囲のアンカー、探し直しとハイライトと範囲の後ろの 💬、`select` の上限) も入れた。段階 4 (FAB のキュー: protocol の `PromptDraftRecordSchema` と `prompt_queue_*`、daemon の `prompt-queue.ts` と `comments.ts` の下書き、webui の FAB の「後で」のピルと数・`timeline/draft-queue.tsx` の 💬 のフィルタの FAB の下書きの吹き出し) も入れ、未決の U7 / U8 を推しのとおり仮に入れた。コメントの添付 (§3 のフォームと未送信のコメントの吹き出しの「直す」の添付、§7 の `attachments`、§9 の `comment_add` / `comment_update` の `attachments`、§11 の送る時の確かめと置き換え、webui の `useAttachmentInput` / `AttachFileButton` を FAB の入力と共有) も入れた (btw のコメントの添付は段階 5)。段階 3 の Files の分 (Files のソースと md プレビューの範囲選択のコメント、`comment_add` のファイルの箇所のアンカー、`file:` の行の範囲の検査、探し直しとハイライトと範囲の後ろの 💬、💬 のフィルタの「コメントした場所へ」) も入れ、段階 3 は全部済んだ。未決の U3 を推しの P20 のとおり仮に入れた。段階 5 (コメントの btw: `comment_add` の `btw` とタイミングのアンカー、fork の起動、答えの記録、`comment_btw_cancel` / `comment_btw_retry`、`queue_send` の `btw_started`、btw の答えへの返信、webui のフォームと範囲選択のツールバーの btw、コメントの記録で描く btw の項目、💬 のフィルタの btw、FAB の btw のピルの送信を `comment_add` に、既にある `<sid>.btw.jsonl` の写し (P25)) も入れ、段階 1〜5 が済んだ)
- Decision は kawaz と統括の議論 (2026-11-22) で決めたものと、設計の監査を受けて統括が決めたもの。統括が議論で出して kawaz が否定しなかったものは「統括案、kawaz の異論なし」と書く。それ以外の主素材に無い判断は「統括の推し」(P 番号) に分け、kawaz の判断を待つものは「未決」(U 番号) に置く。測ったことと実装の途中で測ることは「測ること」。kawaz の裁定は末尾の「裁定」
- Date: 2026-11-22

## Context

TL のエージェントの応答や Files のソースを読みながら、コードレビューのように「この箇所について」の指摘・質問をその場所に付けたい。今の入力は FAB の 1 本の欄だけで、どこについての話かは人が文で書き添えるしかなく、気づいた順に 1 件ずつ送るとエージェントの作業を細切れに割り込むことになる。そこで、メッセージ (と Files のソース・md プレビュー) にコメントを付け、daemon に溜めて (または即時に) エージェントへ送り、エージェントはコメントごとに返信する仕組みを作る。

### 読んで分かった前提

- **module の tool**: エージェントが使う ccmsg の口は module が `$.tool.register` で登録する typed tool で、handler は `next` を呼ばずに `{ result }` で答え、permission の判定を通らない ([DR-0039](./DR-0039-all-mods-and-typed-tools.md) §3)。登録は `isDeferred: true`・description は数語で、使い方の正本は skill に置く (同「mods の tool の作り方」)。deferred が効く間、tool は読み込まれるまで一覧の名前 1 行だけが context に載り、説明文は載らない (同 Consequences)
- **ccmsg の skill**: plugin の skill (`skills/ccmsg/SKILL.md`) の description は、ccmsg の tool の名前と読む場面を 1 文で持つ。本文は tool をフルネームで名指し、使い方と field の決まりの正本になっている (DR-0039 §3)
- **`-p` / SDK には tool を登録しない**: module は `session.start` の `isInteractive` が false のセッションに tool を登録しない (`hooks/tools.ts` の `toolsAtStart`)。btw の fork ([DR-0060](./DR-0060-btw-mode.md)) は `claude -p` なので、ccmsg の tool を登録しない (fork の init の tool の一覧に無い)。それでも fork の request の `system` と `tools` の形は元のセッションと一致し、本体で ToolSearch で読み込んだ ccmsg の tool の形は fork の request にも載る。fork は会話の末尾に「The following deferred tools are no longer available …」の system の 1 件を足す ([findings 2026-11-22-dr62-btw-cache-and-prompt-concat](../findings/2026-11-22-dr62-btw-cache-and-prompt-concat.md) §1)
- **btw の fork の cache** (同 findings §1): fork に ccmsg の tool が無いことは cache を切らない (ccmsg の tool の読み込みの前後とも)。当たらなかったのは model の別名 (`sonnet[1m]`) を `-p` に渡した時で、履歴の thinking が落ちていた。2 件目以降の fork は fork 同士の cache にも当たる
- **turn の最中に続けて送ったプロンプト** (同 findings §2、§3): transcript では連結されず 1 件 1 行になる。行の形は送った時の状態で 3 通り: 待機中は `type:"user"` / `promptSource:"typed"`、tool の実行中は `type:"attachment"` / `attachment.type:"queued_command"` (文は `attachment.prompt`、`timestamp` は待ちに入った時刻、`type:"user"` の行は出ない)、応答の stream 中は turn の終わりに `type:"user"` / `promptSource:"queued"` (`timestamp` は待ちから出た時刻)。model には同じ turn に別の text block で並んで届く。文は待機中は末尾の空白が、turn の最中は両端の空白が落ちる
- **届いたかの照合の部品**: protocol の `landed-prompts.ts` (`promptTextKey` は両端の空白を落とした文、`pairLandedPrompts` は送った順に最も早い同じ文の行と 1 対 1 で組む)、`queuedPersonPrompt` (`queued_command` の人の行の文)、daemon の `prompt_rows` の `since`。今の FAB の「届いたか分からない」送信の自動解消 (DR-0035 §5) がこれを使っている
- **人の入力の経路**: webui → op `user_prompt` (user role) → daemon の `userPrompt` → サイドカーの `prompt.send` → module が composer に fill して Enter ([DR-0035](./DR-0035-user-input-via-composer-fill.md) §1、§3)。結果は `accepted` / `not_delivered` / `unconfirmed` で、daemon が module の返事を待つのは 12 秒まで。turn の実行中に入れた prompt は Claude Code が待ちの列に置き、tool の結果の後に model に届く (同 §5)。人の入力の記録の正本は transcript。DR-0035 §1 は、人の入力に返信方法の指示行を付けないと決めている
- **module が push する行**: module は transcript の行を daemon に push し、daemon は追いつきの読みと合わせて行を見る ([DR-0045](./DR-0045-say-speaks-in-tool-shown-from-transcript.md) §2、§7)
- **ccmsg の tool の行の表示**: say と許可依頼は、transcript の tool_use の行を表示の正本にし、daemon は人の状態だけを持つ (DR-0045 §7、[DR-0040](./DR-0040-permit-request-tool.md) §4)。結果の文の照合は protocol の純関数 (`permitRequested` 等) に置き、daemon と webui が同じものを使う
- **btw**: webui から聞く、本体の会話に残さない横道の質問 ([DR-0060](./DR-0060-btw-mode.md))。セッションの hooks module が本体の会話を継いだ fork の subagent を起こして答えさせ、答えは終わった時に全文で来る。答えは聞いた時点の transcript の最後の行の後に、btw のバッジを付けて出す (§12)
- **セッションごとの保存の場所**: `<stateDir>/sessions/`。`ccmsg sidecar begin` が begin の時に、mtime が 30 日より古いファイルを拡張子を問わず消す (ディレクトリは消さない)。daemon が webui のために持つ全セッション 1 ファイルの状態 (`say-read.json` / `permit-state.json` / `bookmarks.json`) は小さいものだけで、長い文を持つ記録はセッションごとの追記のファイルに置く (§8 の Design rationale)
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
- **btw の入口と記録の種類**: btw はコメントの 1 つの形 (btw のフラグの付いたコメント) にし、FAB の btw もコメントとして作る。btw の fork の起こし方 (DR-0060 §2) はそのまま使い、btw だけの記録・保存・push を別に持たない
- **TL の描画の経路**: エージェントに届いたコメントとエージェントの返信は transcript の行から描く。フィルタ用に TL を別に描かない
- **エージェントに見せる識別子**: エージェントに渡すのは cid と人が読むのと同じ手掛かり (対象のメッセージの冒頭の文字、返信先の cid、ファイルのパスと行、選んだ文字とその前後の文字) だけで、uuid・時刻・描画の位置は渡さない

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
| メッセージ | TL の項目 | 項目の行の uuid、その本文の冒頭 (`msg_start_with`) | バブルの「返信」ボタン |
| 選択範囲 | TL の項目の中の引用 | 項目の行の uuid、その本文の冒頭 (`msg_start_with`)、選んだ文字と前後の少しの文字、描画された文字の中の位置 (手掛かり) | 範囲選択のツールバー |
| ファイルの箇所 | Files のソース・md プレビューの中の引用 | ファイルのパス、ソースかプレビューか、選んだ文字と前後の少しの文字、コメントした時点の選択の始まりの行・列と終わりの行、始まりの行の文 (P20) | Files の範囲選択のツールバー |
| コメント | 既存のコメント・返信 (cid)。その中の引用も持てる | 返信先の cid。範囲選択なら選んだ文字と前後の少しの文字 | `comment_reply` の応答のバブルの「返信」ボタン、`comment_reply` の応答・送ったコメント・btw の答えのバブルでの範囲選択、`comment_reply`、btw の答え |

表示はアンカーの種類で決まる:

| 種類 | TL / Files の印 | 届いたコメントの出る所 | btw の答えの出る所 | エージェントへの文 |
|---|---|---|---|---|
| タイミング | 無し | transcript の人の行 (§12) | 送った時点の transcript の最後の行の直後 | `comment` と `body` だけ |
| メッセージ | 項目に 💬 (数付き) | transcript の人の行 | 送った時点の行の直後 | `on` = `msg_start_with:<冒頭>` |
| 選択範囲 | 項目に 💬、範囲のハイライトと範囲の後ろの 💬 | transcript の人の行 | 送った時点の行の直後 | `on` = `msg_start_with:<冒頭>`、`before` / `select` / `after` |
| ファイルの箇所 | Files のその箇所にハイライトと 💬 | transcript の人の行 | 送った時点の行の直後 | `on` = `file:<パスと行>`、`before` / `select` / `after` |
| コメント | 返信先のバブルに 💬、範囲選択ならそのハイライトと 💬 | transcript の人の行 | 送った時点の行の直後 | `on` = `comment:<返信先の cid>` (btw の答えへの最初の返信は `btw:<cid>` と `btw_req` / `btw_res`、§14)、範囲選択なら `before` / `select` / `after` |

- **時点の記録** (P21): アンカーとは別に、全ての記録が「いつ書いた」と「いつ送った」をそれぞれ時刻とその時点の transcript の最後の行 (uuid を持ち、sidechain でない行) の uuid で持つ。タイミングのアンカーの位置は、送ったものは送った時点、未送信のものは書いた時点。btw の答えは、どの種類のアンカーでも送った時点 (fork が少なくともこの行までは見て答えた位置) に出す
- **コメントを付けられる対象** (kawaz 2026-11-23): エージェントの通常の応答、ccmsg のメッセージ、subagent / teammate への指示 (SendMessage・Agent) とそこからの応答、`comment_reply` の応答、ファイル、cid を持つもの (送ったコメント、btw の答え)。ユーザの発言 (コメントでないもの)・say / PushNotification・許可依頼・tool の呼び出しと結果・thinking・! コマンド・API エラーの行は対象外で、範囲選択でも付けない
- **選択範囲を作れる表示**: 選択範囲・ファイルの箇所・コメントの中の引用は、md の描画の表示 (原文と翻訳タブのどちらも。Files はソースか md プレビュー) で作れる。翻訳タブで作った時の選んだ文字と前後の文字は翻訳後の文字で、context の文と一字一句同じとは限らない (kawaz 2026-11-23)。jsonl の表示・raw の表示では範囲選択のツールバーを出さない
- **探し直し**: 選択範囲とコメントの中の引用も、ファイルの箇所 (P20) と同じく「選んだ文字 + 前後の少しの文字」で、今描かれている文字の中から探し直す。描画された文字の中の位置は手掛かりに留める (翻訳・md の描画の変更・幅の違いで文字の連結が変わりうるため)。描かれている文字は、バブルの描画された文字の連結 (ブロックの境目に改行を挟む) で、探す時は空白と改行を数えない。探す順は「前後の文字と選んだ文字の並び」→「選んだ文字だけ (1 か所だけ当たる時)」で、並びが何か所にも当たる時は元の位置に近い方。見つからない時は印を出さず、💬 のフィルタで「元の場所が見つからない」と出す。この断りはそのバブルが描かれていて探し直せなかったコメントにだけ出す (窓の外の項目は描かれていないので判定しない)。ファイルの箇所は P20 のとおりで、ソースはファイルの今の内容から、プレビューは描かれている文字から探し、何か所にも当たる時は元の位置 (ソースは元の行と列、プレビューは元の行以降で最初の md の塊) に近い方。見つからない時の断りは「元の場所が無くなった」で、Files でそのファイルが描かれていて探し直せなかったコメントにだけ出す
- **agent の TL**: subagent / teammate の TL (DR-0025) の項目へのコメントは、この DR では付けられない。agent の TL では範囲選択のツールバーと返信ボタンを出さない

### 3. 付け方 (webui)

- **範囲選択のツールバー** (統括案、kawaz の異論なし。置き場は kawaz 2026-11-23): コメントの対象 (§2) のバブルの中の描画された文字を範囲選択した時だけ、小さいツールバー (`SelectionToolbar`) を出す。範囲選択の対象は「返信」の行 (`CommentReplyRow`) を持つバブルで、その中の描画された文字 (md の表示、ccmsg の msg タブ、agent のカードの本文、task-notification のフィールド、送ったコメントの本文。翻訳タブの表示も含む) を選んだ時だけ出る。source タブ・ccmsg の raw タブ・jsonl の表示・バブルの頭の行では出ない
  - **置き場**: バブルの外側の、選択範囲の縦の真ん中。列は、バブルの右に空きがあれば右の外側の余白 (項目の右上に「jsonl ☆」の組が出ている縦の帯)、右に無くて左にあれば (右寄せの送ったコメントのバブル) バブルのすぐ左。両方にあれば右。どちらにも無い項目 (fold の中の task-notification のフィールドの並び) は項目の枠の右端の内側に重ねる。選択範囲が画面より縦に長い時は、見えている部分の縦の真ん中 (画面の外に出さない)
  - **避けるもの**: その列にある FAB・入力のパネル・コメントのフォーム・右のパネルのつまみとは重ねず、空いている所のうち選択範囲の真ん中に最も近い所に置く。項目の右上の「jsonl ☆」の組と項目の 💬 の印 (P8) とも重ねず、それらの下に置く (選択が項目の頭にある時。前の項目の側へは逃がさない)
  - 選択の変化・TL のスクロール・見える範囲の大きさの変化で一瞬で置き直す。スマホでも PC でも同じ置き場で、当たりは指で押せる 44px 角
  - **置き場の理由**: スマホの OS の選択のメニュー (コピー・調べる・翻訳 等) は選択範囲の上か下に出るので、選択範囲と同じ高さの横なら縦に重ならない。本文の外なので、選択のつまみ (範囲の両端の丸) とも選んだ文字とも重ならない
  - **押す時**: 押し始めで選択を動かさず、押している間に選択が解かれても (スマホではタップが先に選択を解く) ツールバーを消さない。選んだ文字は選んだ時点で読んでおき、押した時はそれを使う
  - 中身は 💬 (コメント) と btw の 2 つで、💬 の下に btw を縦に並べる (2 つの組の縦の真ん中を選択範囲の縦の真ん中に置く)。どちらを押してもコメントのフォームが出る (btw は btw のフラグを入れた状態で出る)。フォームの頭には選んだ文字の引用が出る。アンカーは選択範囲 (`comment_reply` の応答・送ったコメント・btw の答えのバブルの中ならコメント)。Files のソースと md プレビューでの範囲選択も同じツールバーを出し、アンカーはファイルの箇所 (置き場は P9)。出すのは読み取りの表示 (ソースの行の文と md プレビューの描画) の時だけで、行番号だけの選択では出さない。編集のモード (`TextFileEditor`) では出さない (編集の文は保存していない人の文で、行もファイルとずれる。保存すると読み取りの表示に戻る)
- **返信ボタン** (統括案、kawaz の異論なし。対象と置き場は kawaz 2026-11-23): 返信してスレッドにする項目にだけ「返信」ボタンを置く。対象は 4 種類: メインの会話のエージェントの応答、`comment_reply` の応答、ccmsg のメッセージ、subagent / teammate への指示 (SendMessage・Agent) とそこからの応答 (teammate のメッセージ・task-notification)。加えて cid を持つもののうち、本体に送ったコメントのバブル (`status` が `sent` / `delivered` / `unconfirmed`、btw でないもの) にも出す (kawaz 2026-11-23。コメントの追記のように使う)。未送信・送信の順番待ち (`sending`) のコメントと btw のコメントには出さない。それ以外の項目 (ユーザの発言、! コマンドのカード、API エラーの行、say / PushNotification、許可依頼、tool の呼び出しと結果の fold の行等) には出さない。これらは §2 のコメントの対象外で、範囲選択でもコメントを付けない。置き場は吹き出しの本文の一番下に足した 1 行の右端で、hover を待たず常に出す (`CommentReplyRow`)。指示と応答の項目は fold の中の行で、開いた中身 (吹き出し、task-notification はフィールドの並び) の一番下の行の右端に出す。見た目は say の「既読」ボタンと同じ (枠の色だけ吹き出しの地に馴染む色)。押すとそのバブル全体へのコメントのフォームが出る。アンカーはメッセージで、`comment_reply` の応答と送ったコメントのバブルではコメント (そのバブルの cid、ブロックの `on` は `comment:<cid>`)
- **FAB の btw**: FAB の 3 分割のボタンの btw (§15) で送ったものは、アンカーがタイミングの btw コメントになる (§14)
- **フォーム** (`CommentForm`): 頭に何へのコメントかの 1 行と閉じるボタン (✕)、本文の欄、添付のチップ、下の行に左から 📎 のボタン、btw・後で・送る の 3 分割のボタン
  - **添付**: FAB の入力と同じ操作と部品 (DR-0015 §2.4、§2.5): 📎 で選んだファイル・本文の欄への貼り付け・ドロップを upload し、caret の位置に `[FILE<N>]` を入れ、本文の欄の下にチップ (`FILE<N>: <名前>`) を並べる。チップの × は本文の `[FILE<N>]` ごと外す。番号は入力欄の中の続き (今ある添付と本文の `[FILE<N>]` の最大の次) で、セッションの番号に振り直すのは daemon (§15)。upload の途中は保存できない。webui の部品は `useAttachmentInput` (upload・差し込み・外す・貼り付け・ドロップ) と `AttachFileButton` (📎) と `ComposerAttachments` (チップ) で、FAB の入力・このフォーム・未送信のコメントの吹き出しの「直す」が同じものを使う
  - **入力欄のフォーカス** (kawaz 2026-11-24): 本文の欄で書いている間に、フォームの中の操作 (3 分割のボタンの区画 (選ぶのも実行するのも)、📎、添付のチップの ×) を押しても、本文の欄のフォーカス・キャレットの位置・スマホのソフトキーボードの出た状態・画面のスクロールの位置を変えない。外れてから戻すのでなく、そもそも外さない (本文の欄にフォーカスがある間、これらのボタンの押し始めは既定の動きを止める。外れてから戻すと、スマホではキーボードが一度しまわれて出直し、画面が動くため)。キーボード (Tab で移って Enter / Space) と支援技術からの操作は今のまま効く。本文の欄に居なかった時 (ボタンにフォーカスして押した等) は、フォーカスを本文の欄に移さない。添付の × の後のキャレットは、本文の同じ所 (外した `[FILE<N>]` の分だけ前) に置く。📎 のファイルの選択は OS の画面を挟むのでフォーカスが外れうる: 選択が閉じた時 (選んだ時も、取り消した時も)、開く前に本文の欄に居たなら、本文の欄にフォーカスと元のキャレットの範囲を戻し、選んだファイルの `[FILE<N>]` はその位置に入る。実行した後 (保存して閉じた後) と閉じる操作のフォーカスは、この決まりの外 (「キー」のとおり「返信」のボタンに戻す)。FAB の入力のパネルも同じ (§15)。webui の部品は `compose-focus.ts` (入力欄が文脈で配る本文の欄を、部品 (`SendSplitButton`・`ComposerAttachments`・`AttachFileButton`) が読む)
  - **置き場** (kawaz 2026-11-23): TL の項目の並びに差し込まず、TL の上に浮かせる。コメントする箇所を見たまま書くため。FAB の入力 (`SessionInputComposer` のパネル) と同じ幅・重なりの順・見た目で、余白を掴んで動かせる (位置は覚えない)。TL は見えたまま読め、スクロールでき、フォームの外を押しても閉じない。開いても閉じても TL の項目は増減せず、スクロールの位置も動かない
  - **出す所** (kawaz 2026-11-24): 開いた元 (押した「返信」のボタン。範囲選択の 💬 / btw から開いた時は選択範囲。Files の範囲選択も同じ) の近くに出す。既定はすぐ下で、下に入り切らなければすぐ上、どちらにも入り切らなければ広い側に置いて画面の中へ寄せる。横は、「返信」のボタンから開いた時はボタンと右端を揃え、範囲選択から開いた時は選択範囲の左端にフォームの左端を揃える (選んだ文字の真下からフォームが始まる)。どちらも置ける範囲からはみ出さないよう寄せる。置ける範囲はセッションの画面 (そのタブの中身の箱。サイドバーとタブの見出しの外) の中で、画面の端からは FAB の入力が右下に置かれる時の右と下の余白 (safe area を含む) を空け、ソフトウェアキーボードに隠れる所は含まない。フォームはサイドバーやセッションの一覧の上まで伸びない。置ける範囲よりフォームが広い時 (スマホの狭い幅でほぼ全幅になる時) は、横は範囲の右端に揃えた全幅の位置で、縦だけ開いた元に合わせる。最初の描画の前に置き、右下から飛んで見えない。出た後はスクロールしても画面の同じ位置に留まり (開いた元に付いて行かない)、人がドラッグで動かしたらその位置を保つ。別の対象のフォームに替わったら、新しい対象の近くに出し直す (同じ対象で開き直した時は動かさない)
  - **スマホ**: 置き場の基準は FAB の入力と同じ #app で、ソフトウェアキーボードが出ている間は見える範囲に縮む。縮んだら、動かしていないフォームは開いた元の近くに置き直し (下に入らなければ上)、近くに置けなければキーボードのすぐ上に寄せる。動かしたフォームは見える範囲の中へ寄せるだけ。本文の欄にフォーカスしても TL は送られない
  - **頭の 1 行**: 並びの中に無いので、何へのコメントかをフォームの頭に出す。メッセージ・選択範囲はその冒頭の文字 (`msg_start_with`)、コメントへの返信は返信先の cid とその冒頭の文字、ファイルの箇所はブロックの `on` と同じ `<path>:<行>` (複数行なら `<path>:<r1>-<r2>`)。範囲選択なら選んだ文字の引用を添える
  - **キー**: 開くと本文の欄にフォーカスする。閉じる口は右上の ✕ と Esc だけで、「やめる」のボタンは持たない (kawaz 2026-11-24)。Esc で閉じる (IME の変換中の Esc は変換のもので、閉じない)。⌘Enter / Ctrl+Enter で 3 分割のボタンの選ばれている区画を実行する (押すのと同じ)。閉じると、開いた「返信」のボタンにフォーカスを戻す
  - 開けるフォームはセッションの画面に 1 つ (Timeline と Files で 1 つ) で、別の項目の「返信」や範囲選択の 💬 を押すとそちらのフォームに替わる (書きかけの本文は持ち越さない。前の対象の書きかけはその対象のものとして残る)。フォームは開いたタブの上に浮かぶ (TL の項目へのコメントは Timeline のタブ、ファイルの箇所へのコメントは Files のタブ)
  - **書きかけ** (kawaz 2026-11-24): 閉じても (✕、Esc、別の対象のフォームに替わる) 書きかけの本文と添付は消さず、コメントの対象ごと・セッションごとに覚え、同じ対象のフォームを開き直すと続きから書ける。覚えるのはページを開いている間だけ (メモリ。再読み込みで消え、localStorage にも daemon にも持たない。webui の `comment-form-drafts.ts`)。3 分割のボタンの選択は覚えない。本文も添付も空で閉じると何も残らない (これが書きかけを消す操作)。「送る」/「後で」/ btw で保存できたら、その対象の書きかけを消す。保存に失敗した時は残す。添付はアップロードの済んだものだけを覚え、アップロードの途中・失敗の添付は覚えない (フォームを閉じた後に終わったアップロードは書きかけに足さない。本文の `[FILE<N>]` はそのまま残る)。書きかけが残っていることを示す印は出さない
  - **書いている間の範囲** (kawaz 2026-11-24): 範囲選択から開いたフォームは、フォームにフォーカスが移ってブラウザの選択が消えても、開いている間はその範囲を送った後と同じハイライト (`ccmsg-comment`、P31) で示す。範囲は送った後と同じく今描かれている文字から探し直し (§2)、見つからなければ示さない。まだコメントでないので範囲の後ろの 💬 は付けず、💬 のフィルタの「元の場所が見つからない」にも数えない。保存した時・閉じた時・別の対象のフォームに替わった時に消え、保存したものは記録の範囲として示される。TL の吹き出しの中の選択範囲・コメントの中の引用と、Files のソース・md プレビューのファイルの箇所のどれも同じ。範囲選択の無いフォーム (「返信」で開く吹き出し全体へのコメント) は何も示さない
  - **FAB との重なり**: フォームが開いている間、FAB とその入力のパネルは画面から外す (フォームと重なりうるため)。外すだけで、書きかけ・開閉・位置は保ち、フォームを閉じると戻る
  - **btw・後で・送る の 3 分割のボタン** (kawaz 2026-11-24): FAB の下の行と同じ部品 (§15) で、決まりも同じ。1 つの枠の中に左から btw、後で、送る の 3 つの区画が並び、そのうち 1 つが選ばれている。選ばれていない区画を押すと選択がそこへ移り、何も実行しない。選ばれている区画を押すとそれを実行する (⌘Enter / Ctrl+Enter も同じ)。タップの端末でも、後でや btw は同じ所を 2 回押せばよい
  - 送るなら、daemon に保存し、溜まっている未送信のコメントと FAB の下書きを全部送ってから、最後にそのコメントを送る (§11 の「全部送る」、kawaz 2026-11-24)。後でなら daemon に保存して溜める (未送信、💬 のフィルタから送る)。btw なら btw のコメント (§14) として保存してすぐに聞く。選ばれるのは 1 つなので、フォームから btw の未送信は作れない
  - 区画の字は「btw」「後で」「送る」で、選択でも保存の途中でも変えない。区画の幅も選択で変わらない
  - 実行できない時 (本文が空、保存の途中、添付の upload の途中、同じ本文で保存済み) は、選ばれている区画は押せない見た目で、押しても実行しない。選ばれていない区画への切り替えは、保存の途中を除いてできる
  - 選択は覚えない。フォームを開くたびに送るが選ばれている。範囲選択の btw から開いた時だけ btw が選ばれた状態で開く
  - 未送信のコメントの吹き出しの「直す」は、本文と添付を直して保存するだけで、3 分割のボタンを出さない (FAB の下書きを直している間と同じ、§15)。下の行は左から 📎、「閉じる」(元の文のままにして閉じる)、「保存」(kawaz 2026-11-24)
- **未送信のコメントは送る前に直す・消す操作を持つ** (統括案、kawaz の異論なし)。送ったコメントは直さない・消さない。未送信のコメントの吹き出しは添付を送った時と同じリンクで本文の中に出し (§13)、「直す」の間はチップで出してフォームと同じ添付の操作で足し引きできる

### 4. エージェントに渡す形 (コメントのブロック)

1 つのコメントは、それだけで意味が分かる JSON の 1 行 (コメントのブロック) で渡す。エージェントは uuid も時刻も知覚できないので、どこを指しているかは人が読むのと同じ手掛かり (対象のメッセージの冒頭の文字、返信先の cid、ファイルのパスと行、選んだ文字とその前後の文字) で渡す。これは AI に宛てた形で、効率と論理性で決める (裁定 2026-11-23)。ブロックの形は protocol の valibot のスキーマ (`CommentBlockSchema`) が持ち、型はそこから導く。文は純関数 `commentBlockText` (`JSON.stringify`) が作り、daemon の送信が使う。webui はコメントの指す先を同じ `commentBlockOf` の `on` で出す (§13)。逆向きの読み取りは `parseCommentBlocks` (§12)。

```
{"comment":"c7k2p","on":"msg_start_with:起動手順を終えました (role-main の必読 6 件、…","body":"状態ファイルは書き直しておいて"}
{"comment":"c7k2q","on":"msg_start_with:起動手順を終えました (role-main の必読 6 件、…","before":"未 commit の変更 (11-23 01:07、","select":"4 ファイル +109 −59","after":"): bubbles.tsx、comments.tsx","body":"これは案 B の残り？"}
{"comment":"c7k2r","on":"file:docs/QUESTIONS.md:20-22","before":"## 裁定待ち ","select":"(なし)","after":" ## 確認待ち","body":"ここに未決を並べて"}
{"comment":"c5h2w","on":"comment:c8m1t","body":"さらに続き"}
{"comment":"c2v8d","on":"btw:c9q4r","btw_req":"xx て何?","btw_res":"<答えの全文>","body":"続きの質問"}
```

キー (この順に書く):

| キー | 中身 | 持つ時 |
|---|---|---|
| `comment` | cid (形は §7) | 常に |
| `on` | 指す先。種類の語と `:` と値 (下の表) | アンカーがタイミングでない時 |
| `btw_req` / `btw_res` | btw の質問の文と、btw の答えの全文 (§14) | `on` が `btw:` の時だけ。2 つ揃えて持つ |
| `before` / `select` / `after` | `select` は選んだ文字。`before` / `after` はその前と後ろの 30 文字 (空白の並びを 1 つの空白に詰める。`…` は付けない)。翻訳された表示の上で選んだ文字のことがあり、context の文と一字一句同じとは限らない (§2) | 範囲選択がある時だけ。3 つ揃えて持つ |
| `body` | 人の本文 | 常に |

`on` の種類 (指す先は常に 1 つ):

| 値 | 指す先 | アンカー |
|---|---|---|
| `msg_start_with:<冒頭>` | cid を持たないメッセージ (エージェントの通常の応答、ccmsg のメッセージ、subagent / teammate への指示 (SendMessage・Agent) とそこからの応答、§2)。冒頭は 30 文字で、空白の並びを 1 つの空白に詰めて両端の空白を落とし、30 文字を超えたら 30 文字で切って末尾に `…` を付ける | メッセージ・選択範囲 |
| `comment:<cid>` | cid を持つもの (`comment_reply` の応答、送ったコメント)。cid が context にあるのでそれだけで通じ、冒頭の文字は付けない | コメント |
| `file:<path>[:r1[-r2]]` | ファイルの箇所。path はセッションの cwd の中なら cwd からの相対、外なら絶対。r1 / r2 は選択の始まりと終わりの行 (同じ行なら r1 だけ)。読み取りのスキーマは、値の末尾が `:<r1>` か `:<r1>-<r2>` なら r1 が 1 以上・r1 <= r2・その前のパスが空でないことを検査し、末尾が行でない値はパスだけと読む | ファイルの箇所 |
| `btw:<cid>` | btw の答え (その答えの cid)。`btw_req` / `btw_res` を伴う (§14) | コメント (返信先が btw の答え) |

- **`on` の読み方**: 値の最初の `:` で分け、前を種類、後ろをそのまま値にする (`file:` の値にも `:` が入る)。スキーマは種類ごとに値を読み (`comment:` / `btw:` は cid の形、`file:` は空でない)、読んだ形 (`{ kind, value }`) で持つ
- **誰の発言かは載せない**。指す先の種類は `on` の頭の語で分かる
- **範囲選択の無いコメントは `before` / `select` / `after` を持たない**。付いた先の全体へのコメントだと形で分かる。指す先 (`on`) と選択範囲 (`before` / `select` / `after`) は独立で、メッセージの中の範囲選択は両方を持つ
- **同じ冒頭のメッセージが複数ある時**は、エージェントは最も新しいものを指すと読む (ccmsg の skill の本文に書く、§5)
- **ファイル**: ソースとプレビューの区別と列は載せない (記録は持つ、§7)。md プレビューで選んだ文字の行は md の元の文の行 (P26)
- **`select` の上限**は 2000 文字 (見た目の 1 文字で数える) で、超えたら先頭と末尾の 900 文字ずつと、間に省いた数の印 (`…(<N> 文字略)…`) に縮める。縮めるのはブロックだけで、記録の選んだ文字 (`text`) は探し直しに全文を使うので縮めない
- 冒頭の文字・選んだ文字・前後の文字に markdown の記号が混ざっても落とさない
- **アンカーがタイミングのコメント** (FAB の btw) は `comment` と `body` だけ
- **複数のコメント**をまとめて送る時は、ブロックの行を改行で並べて (JSONL) 1 つのプロンプトにする (統括案、kawaz の異論なし。§11)
- **1 つのブロックは常に 1 行**: `JSON.stringify` は文字列の中の改行を `\n` に書くので、本文や選んだ文字が改行を含んでもブロックは改行を含まない
- **読み取り** (`parseCommentBlocks`): プロンプトを行に分け、行ごとに JSON として読んでスキーマに通す。通った行だけがコメントで、`comment` (cid の形) と `body` を持ち、上の表に無いキーを持たず、`on` が上の種類のどれかで、`btw:` の `on` と `btw_req` / `btw_res` が揃い、`before` / `select` / `after` を揃えて持つか 1 つも持たない行。スキーマに合う行はコメントと読む (人が同じ形の行を手で打てば、コメントとして描かれる)。壊れた JSON の行とスキーマに合わない JSON の行は読まない。`parseCommentBlocks(commentBlockText(x))` は `x` に戻る
- ブロックにもプロンプトにも、返し方の指示行 (「`comment_reply` で返して」等) を付けない。返し方は ccmsg の skill が持つ (§5)
- daemon 側は正確な位置を持つ (§7): TL の項目の uuid、描画された文字列の中の選択の位置、ファイルの正確な行・列と前後の文字。エージェントへの文には載せない
- **人の入力に載るエージェントの文**: `on` の冒頭の文字・`before` / `select` / `after`・`btw_req` / `btw_res` には、エージェントや btw の fork が書いた文が引用として載り、それが人の入力 (composer への fill) としてセッションに入る。足されるのは引用で、許可ではない (DR-0035 §4、DR-0039 §6 の「足されるのは文脈であって権限ではない」と同じ)。auto mode の classifier が引用の部分を人の発話として読むかは未検証

### 5. エージェントの返信: tool `comment_reply { cid, body }`

- ccmsg の module が登録する tool (DR-0039 §3 の typed tool)。model からは `mcp__ccmsg-v1__comment_reply`
- handler は入力を valibot で読み、daemon の `POST /op` ([DR-0046](./DR-0046-module-op-over-http.md)) に op `comment_reply` (session role、§9) を、呼び出しの tool_use の id を添えて送る。daemon は cid が返信先になれる記録か確かめ、返信の記録を作って新しい cid を振る
- **返信先になれる記録**: 本体に送った人のコメント (`status` が `sent` / `delivered` / `unconfirmed`) と、エージェント自身の返信。`draft`・`deleted`・btw のフラグの付いたコメント・btw の答え (本体の context に無いもの) は `not_found`
- **二重の記録を防ぐ**: 同じ tool_use の id の `comment_reply` が来たら、新しく作らずに前の記録の cid を返す
- 結果として、その返信自身にも新しい cid が振られたことが分かる文と、返信先の短い引用を返す (返信の返信でスレッドになる)。例: `c7k2p (「ここは undefined を返すのでは？」) への返信を記録した。この返信の cid は c8m1t (人がこれに返信すると "on":"comment:c8m1t" で届く)`。結果の文の照合 (新しい cid の取り出し) は protocol の純関数 (`commentReplyRecorded`) に置き、webui が transcript の結果の行から cid を読む
- 失敗の文は次にすることを添える:
  - daemon が居ない・古い: 他の tool と同じ文 (daemon を起こす・更新する)
  - cid が返信先になれない: `cid c99xx はこのセッションの本体に届いたコメントに無いので記録していない。届いたコメントの "comment" の cid を確かめて書き直す`
  - 入力が形に合わない: `comment_reply の入力が形に合わないので何もしていない: <理由>`
- **登録の形**: 他の ccmsg の tool と同じく `isDeferred: true`、description は数語 (`Reply to a comment`)。field の説明は付けない (DR-0039「mods の tool の作り方」)
- **返し方の指示は ccmsg の skill の description に置く** (裁定 2)。skill の一覧 (名前と description) は compact の後も context に載る前提で (「測ること」3 で確かめる)、daemon は「初回に指示を付けたか」を覚えない。description に足す文の案 (今の description の後ろに 1 文):

  ```
  {"comment":"<cid>",…} の行が届いたら、コメントごとに mcp__ccmsg-v1__comment_reply { cid, body } で返し、同じ内容を応答の本文に書き直さない (この tool が無ければ本文で返す)。
  ```

  - 「同じ内容を応答の本文に書き直さない」は、返信が応答と同じ吹き出しで出る (§12) ので、本文にも書くと同じ話が 2 度並ぶため。この句が無い文では、model は `comment_reply` の後に毎回、返信の中身の要約を本文にも書いた (「測ること」3)
  - skill の本文には「返信で言い切れたら、その後の応答の本文は `comment_reply_done` の 1 語だけで終える」も書く (kawaz 2026-11-24)。無いと model は返信の後に毎回「xx に返信し、xx を進める」の報告を本文に書き、読む人にはコメント 1 つに 2 つの吹き出しが返る。この 1 語は protocol の定数 (`COMMENT_REPLY_DONE_TEXT`) で、webui の TL は本文が 1 行でこの語を含む応答を吹き出しにせず、特殊な項目として「N items」の畳みの中に入れる (§12)。英字の 1 語にするのは、応答の言語や翻訳で揺れず、普通の文と一致しないため。本文を空にして終える形は採らない: Claude Code 2.1.330 は見える出力の無い応答の後に、続きを促す文 (`Your previous response had no visible output. …`) を会話に差し込んでもう 1 turn 走らせる (実測 2026-11-24)

  - tool のフルネームと引数を書くのは、deferred で未ロードの tool を ToolSearch なしに名前で呼ばせるため (未ロードの plugin の tool を名前で呼んでも handler に届く、DR-0039 §3)
  - 「この tool が無ければ本文で返す」は、tool を持たないセッション (plugin の更新の前に起動した、module の無い) のため
  - 使い方の正本は skill の本文に置く (DR-0039 §3 の流儀): コメントのブロックの読み方 (`comment` / `on` の 4 つの種類 / `btw_req` / `btw_res` / `before` / `select` / `after` / `body`)、1 つのコメントに 1 回呼ぶこと、結果の文の新しい cid、失敗の文の扱い。description は本文を読む契機の 1 文に留める
- **コメントのブロックには返し方の指示行を付けない** (DR-0035 §1 の「人の入力に返信方法の指示行を付けない」と揃う)。ブロックは人が書いたこととその場所だけを運ぶ
- **btw の fork**: fork は本体の tool を継ぐので `comment_reply` を呼べるが、module は btw の fork (自分が起こした fork の agentId、読み込み直しの後は session が plugin の起こした fork として `ccmsg btw` で並べるもの) からの呼び出しを daemon に送らずに断り、結果の文で「この横道からは使えない、答えは応答の本文に書く」と返す。DR-0060 §3 の前置きも「`comment_reply` で知らせない」と書くので、答えは本文になる。他の subagent / teammate からの呼び出しは P6 のとおり断る
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
- 印は文字付きのボタンで、未解決は「✔️解決済み」(押すと解決)、解決済みは「✅解決済み」(押すと外す) (kawaz 2026-11-24)。2 つを `StackedLabels` で同じ升目に重ね、入れ替わっても幅を変えない。見た目は「返信」のボタンと同じ小さい部品 (同じ字の大きさ・余白・角丸の枠) で、解決済みの間は枠を accent にし、解決にできない間は押せない (枠と字を薄くする)。どの吹き出しのボタンを押しても、印はスレッドの最初の人のコメントの cid (`ThreadState` の `root`) に付く (daemon がスレッドを辿る)。置き場は P14
- 💬 のフィルタの画面では、✅ の付いたスレッドは既定で出さない。ヘッダの `resolved` のチェックボックスで出す (§13)
- **解決済みのスレッドに新しい記録が付いた時** (統括の判断、kawaz 2026-11-24 の「済んだ問答は解決済みを押していく」運用を根拠に): 解決済みのスレッドに新しい記録が付いたら、daemon が解決を外して未解決に戻す。新しい記録は、人のコメント (未送信も、付けた時点で外す)、エージェントの `comment_reply`、btw の答え (聞き直しで新しい答えが始まった時と、答えが終わった時)。外すのは記録を足すのと同じ流れで、スレッドの状態の行を書いて配る (`comment_thread`)。💬 のフィルタの既定は解決済みを出さないので、残っているもの = まだ済んでいないもの、という運用で新しい返信が隠れたまま気づかれないことを防ぐ。解決の印は外れたままで、付け直すのは人
- エージェントが解決にできるか (U11)、解決済みのスレッドの TL の印 (U12) は未決

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
| `body_start` | `author` が `agent` の時、その返信の本文の冒頭 (`msg_start_with` と同じ作り方)。daemon が `comment_reply` の `body` から作る。窓の外の返信の表示 (§13) と、その返信にエージェントが返信した時の結果の文の引用 (§5) に使う |
| `body` | 本文。`author` が `user` (人のプロンプト) と `btw` (btw の答えの文) の時だけ持つ。`agent` の本文は transcript の `comment_reply` の行が正本で、記録は持たない |
| `attachments` | 添付 `[{ n, name, path }]` (`author` が `user` の時。無ければ添付なし)。置き場と番号は FAB の下書きと同じ (§15): `path` は state dir の下、`n` は FAB の下書きと 1 本の列のセッションの番号で、`body` の `[FILE<n>]` がそれを指す |
| `effort` | btw の effort (`author` が `user` で btw の時。FAB の ⏱️ の選択) |
| `written` | 書いた時点 `{ at, after_uuid? }` (P21) |
| `sent` | 送った時点 `{ at, after_uuid? }`。未送信なら無い (P21) |
| `updated_at` | 最後に変わった時刻。直す・送る操作が「見ていた版」として送り返す (§9) |
| `btw` | btw のフラグ (`author` が `user` の時だけ) |
| `status` | `author` が `user` で btw でない時: `draft` / `sending` / `sent` (入れた) / `delivered` (届いた) / `unconfirmed` / `deleted`。btw の時: `draft` / `sending` (列で空きを待つ) / `sent` (fork を起こした) / `deleted`。`author` が `btw` の時: `running` / `done` / `failed` / `canceled`。`agent` は持たない |
| `send_error` | 送れなかった理由。次に送れたら消す |
| `row_uuid` | 届いた時、そのブロックを持つ transcript の人の行の uuid |
| `tool_use_id` | `author` が `agent` の時、`comment_reply` の呼び出しの tool_use の id |
| `model` / `tool` / `ended_at` / `error` / `usage` | `author` が `btw` の時だけ。`model` は fork が走った model (DR-0060 §6)、`tool` は走っている間に fork が使っている tool (保存しない)、`ended_at` は終わった時刻、`error` は `failed` / `canceled` の理由と次にすることの文、`usage` は fork の全 request の token 数の合計 (DR-0060 §4)。`effort` は fork が走った level (DR-0060 §6) |
| `btw_id` | `<sid>.btw.jsonl` の btw の記録から写した質問と答えだけが持つ、元の btw の id (P25) |

`anchor` の形 (`kind` で分ける):

- タイミング: `{ kind: "timing" }`
- メッセージ: `{ kind: "message", uuid, msg_start_with }`。`uuid` はその項目の行の uuid (TL の位置になれる行、DR-0058 §2)、`msg_start_with` はその本文の冒頭 (ブロックの `on` の `msg_start_with:` の値、§4)。webui が作る。必ず持つ (無い記録・`comment_add` はスキーマに合わない) ので、メッセージ・選択範囲のコメントのブロックは必ず `on` を持つ
- 選択範囲: `{ kind: "selection", uuid, msg_start_with, text, before, after, start?, end? }`。`msg_start_with` はメッセージと同じ、`text` は選んだ文字、`before` / `after` は前後の少しの文字 (探し直しに使う、§2)、`start` / `end` は描画された文字の連結の中の位置 (手掛かり)
- ファイルの箇所: `{ kind: "file", path, view: "source" | "preview", text, before, after, line, end_line?, col?, line_text }`。`path` はセッションの cwd の中なら cwd からの相対、外なら絶対 (ブロックの `file` にそのまま載る)、`text` は選んだ文字 (プレビューは描画された文字)、`line` / `col` はコメントした時点の選択の始まり (どちらも 1 から。`col` は見た目の 1 文字で数える。プレビューは選んだ文字を含む md の塊の元の行で、`col` は持たない)、`end_line` は選択の終わりの行 (プレビューは選んだ文字を含む md の塊の元の終わりの行。始まりと同じ行なら持たない)、`line_text` は始まりの行の元の文 (P20)
- コメント: `{ kind: "comment", cid, text?, before?, after?, start?, end? }`。範囲選択でなければ `cid` だけ

`ThreadStateSchema`: `{ kind: "thread", session_id, root, resolved_at?, seen_cid? }`。`root` はスレッドの始まりの cid、`resolved_at` は解決済みにした時刻 (無ければ未解決)、`seen_cid` は解決にした時に人が見ていた最後の cid。

### 8. 保存

- 置き場は `<stateDir>/sessions/<sid>.comments.jsonl` (コメント・返信・btw の答え・スレッドの状態) と `<stateDir>/sessions/<sid>.queue.jsonl` (FAB の下書き、§15)。1 行が記録 1 つの全体で、daemon だけが追記し、読む時は同じキー (`kind` と cid / root / id) の後の行が前の行に勝つ。コメントを消す (`deleted`) のも 1 行の追記。FAB の下書きは記録そのものを消す (§15) ので、消す時は削除の行 `{ kind: "draft_removed", id }` を足す (ファイルの書き直しは P34)
- **行の組み方**: 書く行は、書く直前のメモリの最新の記録から組み、その操作が変える field だけを替える (前に読んだ古い写しから組まない。並んだ操作が互いの変更を消さないため)。書き込みは sid ごとの記録の列 (§11) を通す
- 書くのは変わるたび (作る、直す、消す、送る前 (`sending`)、送った結果、届いた、返信を記録した時、解決の付け外し、btw の答えが始まった時と終わった時)。書いてから答え、push する
- **書けなかった時**: 人の操作 (作る、直す、消す、送る前の `sending`、解決の付け外し、未確認の扱い) の行が書けなければ、op は `state_not_writable` で断り、メモリも配りも変えない (人は断りを見てやり直せる)。セッションが起こした変化 (送った結果、届いた、turn の終わりの未確認、起動の後の `sending` の読み替え) の行が書けなければ daemon.log に残し、メモリと配りは進める (セッションの側では既に起きたことで、人がやり直せるものが無い。次の daemon は書けた所までを読む)
- 読むのは daemon がそのセッションのコメントを初めて要る時 (購読の始まり、op、module の行) で、ファイルごとメモリに持ち、以後は追記の分を足す。読んだ時に送った (`sent` / `unconfirmed`) まま届いたと確かめていないものがあれば、transcript の追いつきの読みで照合する (§11。daemon が止まっていた間に行が出ていれば、次の行の push を待たずに `delivered` になる)
- daemon の起動の後に読んだ記録が `sending` のまま残っていれば `unconfirmed`、`running` のまま残っていれば `failed` (`error` は「daemon が止まった」) として扱い、その行を追記する
- 寿命は `<stateDir>/sessions/` の掃除に従う (`ccmsg sidecar begin` が mtime 30 日超のファイルを消す。最後の書き込みから 30 日)

Design rationale: `<sid>.json` の中に入れない。あのファイルは `ccmsg sidecar begin` (別のプロセス) が begin のたびに丸ごと書き直すもので、daemon が同じファイルに書くとプロセスをまたいだ読み書きの順序を揃える仕組みが要り、begin が記録を消す。`bookmarks.json` 等の全セッション 1 ファイルの形にもしない。コメントと btw の答えは本文を持ち、1 件足すたびに全セッション分を書き直すことになる。セッションごとの追記のファイルなら、書くのは 1 行で、読むのはそのセッションを開いた時だけになる。

### 9. op

どの op も、そのセッションの記録を読む・変える部分は sid ごとの記録の列 (§11) で直列に走る。

`session_id` はセッションの id の形 (`isSessionIdShape`) でなければ `bad_request` (コメントのファイルの名前になるので、別のディレクトリを指す文字列を受けない)。daemon がそのセッションの transcript を見つけられなければ `session_not_found` で断る (コメントは transcript の上に付くもの)。行が書けない時の断りは §8。

user role だけ (session role は `bad_request` で断る。セッションのエージェントが人のコメントを作る・送る口にしない、DR-0035 §4):

- `comment_add { session_id, anchor, body, btw, effort?, attachments?, send_now }` → `{ ok: true, comment, outcome? }`。daemon は書いた時点 (`written`) を transcript の末尾から決める。`attachments` (無ければ添付なし) は FAB の下書きの `prompt_queue_add` と同じ扱い (§15): アップロードの置き場のファイルだけを受け、state dir の下に移し、セッションの続きの番号を振って `body` の `[FILE<N>]` を同じ対応で書き換える。番号の続きは記録より先に書く (記録が書けなくても振った番号を二度と振らない)。記録が書けなければ移したファイルを戻す。`send_now` なら保存してから §11 の送信をし、その結果を `outcome` (`queue_send` の項目の結果と同じ形) で添える (`user_prompt` と同じ遅い返事)
  - `invalid_args`: 本文が空、`anchor` の形が合わない (メッセージ・選択範囲のアンカーに `msg_start_with` が無いのも含む)、`effort` が語彙 (`LaunchEffortSchema`) の外、btw でないのに `effort` がある。受けるアンカーはタイミング・メッセージ・選択範囲・ファイルの箇所・コメント (その中の引用も)
  - `not_found`: アンカーがコメントで、その cid がそのセッションに無いか、`draft` / `deleted` の記録 (送っていないコメントには返信できない)
- `comment_update { session_id, cid, seen_updated_at, body?, btw?, effort?, attachments? }` → `{ ok: true, comment }`。`draft` の記録だけ。`attachments` は `prompt_queue_update` と同じ扱い (記録に既にある添付はパスで見分けて番号を変えず、まだ無い添付だけに続きの番号を振る)。`attachments` の無い直しは今の添付を保つ。外した添付のファイルは消さない。`seen_updated_at` が今の `updated_at` と違えば `conflict` で断る (別のデバイスで先に直された・送られた)。版が同じで `draft` でなければ `invalid_args` (版を先に見る。別のデバイスで先に送られたものは `conflict` になる)
- `comment_delete { session_id, cid, seen_updated_at }` → `{ ok: true }`。`draft` の記録だけ `deleted` にする。`conflict` は上と同じ
- `comment_resolve { session_id, cid, resolved, seen_cid }` → `{ ok: true, thread }`。`cid` はスレッドのどの記録でもよい。解決にできないスレッド (§6) は `invalid_args` で、`seen_cid` より新しい記録があれば `conflict`。同じ状態への設定は何も変えず送らない
- `comment_btw_cancel { session_id, cid }` → `{ ok: true }`。走っている btw の答え (`cid`) を止める (DR-0060 の `btw_cancel` と同じ働き)。終わった答えは何もせず ok
- `comment_btw_retry { session_id, cid }` → `{ ok: true, comment }`。最後の答えが `failed` / `canceled` の btw のコメント (`cid` は質問) をもう一度聞く (§14)
- `queue_send { session_id, items: [{ kind: "comment", cid, seen_updated_at } | { kind: "draft", id, seen_updated_at }] }` → `{ ok: true, results: [{ kind, id, outcome, reason? }] }` (§11)。1 件ずつの送信・セクションごとの送信・全部送るを、この 1 つの op で表す (渡す列が違うだけ)。`outcome` は `sent` / `unconfirmed` / `not_delivered` (`reason` は DR-0035 §5 の語彙、`UserPromptReasonSchema`) / `btw_started` / `btw_waiting` / `refused` (`reason`: `not_sendable` (`draft` / `queued` でない、今の状態を `status` に添える)・`conflict`・`attachment_missing`・`not_found` (項目が無い、または返信先がまだ送られていない))
- `prompt_queue_add` / `prompt_queue_update` / `prompt_queue_delete` (§15)
- `unconfirmed_settle { session_id, item: { kind: "comment", cid } | { kind: "draft", id }, action: "back_to_draft" | "mark_sent", seen_updated_at }` → `{ ok: true }`。`unconfirmed` の項目への人の操作 (§11): `back_to_draft` はコメントを `draft`、下書きを `queued` に戻す。`mark_sent` はコメントを `sent` にし (P32)、下書きは記録を消す (§15)。版が違えば `conflict`、版が同じで `unconfirmed` でなければ `invalid_args`

断りの語彙 `conflict` と `state_not_writable` (daemon が state dir に行を書けない、§8) を ErrorCode に足す (他の断りは既存の語彙)。

session role だけ (module の `POST /op`):

- `comment_reply { cid, body, tool_use_id }` → `{ ok: true, cid: <新しい cid>, quote: <返信先の本文の冒頭> }` (`quote` は結果の文の「」の中に入れる文)。セッションは呼び手の sid (接続の identity)。`not_found`: cid が返信先になれない (§5)。`invalid_args`: 本文が空。subagent からの呼び出しは P6

記録を読む op は持たない。読むのは購読の始まりの push (§10)。daemon.log に op ごとに 1 行 (sid、cid、本文の byte 数。本文は書かない。送信は送った結果ごとにもう 1 行)。

### 10. 配り方

コメント・キュー・解決の push は、TL を表示している間 (`transcript_subscribe`) に縛らない。Files / Status / Timeline のどれを見ていても届き、FAB の数もそれで出す。載せる購読は P28。

- `ev:"comments" { session_id, comments, threads, drafts }`: 購読の始まりに、保存されている記録と走っている btw の答えの全部 (`deleted` を除く)、スレッドの状態、FAB の下書きのうち `queued` / `sending` / `unconfirmed` のもの (送り終えた `sent` は含めない。届いたら記録ごと消える、§15) を送る (空でも送る。daemon の再起動の後に繋ぎ直したタブが古い分を捨てられるように)
- `ev:"comment" { comment }`: 記録が変わるたびに 1 つ送る。webui は `cid` で置き換える (`deleted` なら消す)。btw の答えは始まった時 (`running`、本文は空) と終わった時 (全文) に送る
- `ev:"comment_thread" { thread }`: スレッドの状態が変わるたびに 1 つ送る
- `ev:"prompt_draft" { draft }`: FAB の下書きの記録が変わるたびに 1 つ送る。webui は送り終えた (`sent`) 下書きを一覧から外す
- `ev:"prompt_draft_removed" { session_id, id }`: FAB の下書きの記録を消した時に送る。webui はその下書きを外す
- 購読していない webui には送らない

### 11. 送信

- **sid ごとの 2 本の列**: daemon はセッションごとに次の 2 本の列を持つ
  - **記録の列**: 記録を読んで決めて書く区間 (op の検査と行の書き込み、cid を振る、送信の前の `sending` と送った時点と送った結果、届いたの確定、turn の終わりの未確認) を順に走らせる。区間の中で await を挟んでも (transcript の末尾を読む、行を書く) 次の区間は始まらない。区間はセッションの返事を待たない
  - **送信の列**: プロンプトをセッションに入れること (コメントの送信・`send_now`・FAB の下書きの送信・キューを通さない FAB の直送 (`user_prompt`、P27)・btw を列に入れる操作) を順に走らせる。送信は前の送信の結果が出てから次を始める。`user_prompt` の 12 秒の期限は列の順番が来てから数える (列の待ちと module の待ちで期限を食って `unconfirmed` になるのを防ぐ)
  - 送信が module の返事を待っている間も記録の列は進むので、直す・消す・解決はすぐ答える
- **受ける状態**: `queue_send` と `send_now` が送るのは、コメントは `draft`、FAB の下書きは `queued` だけ。daemon は記録の列の中で `sending` を書いてから送信の列に入れる。返信 (アンカーがコメント) は、受け付けた時と送信の列で順番が来た時 (記録の列の中で送る直前) の両方で返信先を見て、`draft` に戻っていたり消えていれば送らない (`refused` / `not_found`。順番が来た時に断ったものは `draft` に戻す。エージェントが受け取っていない cid を `on` の `comment:<cid>` に持つブロックを作らない)。それ以外の状態の項目は送らず、項目ごとの結果 (`refused` / `not_sendable` と今の状態) で返す。見ていた版 (`seen_updated_at`) が違う項目も送らない (`conflict`)
- 送る文は daemon が記録から作る (`commentBlockText`、§4)。送り方は `user_prompt` と同じ `userPrompt` (composer への fill + Enter、DR-0035) で、新しい注入の経路を作らない。送る直前に送った時点 (`sent`) を transcript の末尾から決める
- **コメント**: 送る列のうち btw のフラグの無いもので、渡された順で続いて並ぶもの (間に FAB の下書きを挟まないもの) を、その順にブロックの行を改行で並べて (JSONL) 1 つのプロンプトにする。コメントと FAB の下書きを 1 つのプロンプトに混ぜない (届いたの確定はブロックの行だけでできたプロンプトを読むため)。送る直前に添付が在るかを確かめ、無いコメントはそのプロンプトに入れず `draft` に戻して `attachment_missing` を返す (他のコメントはそれ抜きで送る)。添付はブロックのキーを増やさず、`body` の `[FILE<n>]` を `[FILE<n>:<name>](<path>)` に置き換えて載せる (`commentBlockOf` が置き換える。FAB の下書きと同じ `attachmentLinkedText`)。`accepted` なら `sent` (入れた)、`unconfirmed` なら `unconfirmed`、`not_delivered` なら `draft` に戻して `send_error` に理由を書く。1 つのプロンプトで送ったコメントは同じ結果になる
- **届いたの確定**: daemon は module が push した人の行と追いつきの読み (DR-0045 §2、§7) のうち、本文が (空白だけの行を除いて) コメントのブロックの行だけでできているもの (`commentOnlyBlocks`、§12 の描画と同じ 1 つの規則。daemon が送るプロンプトはブロックの行だけでできている) を読み、そのセッションの `sent` / `unconfirmed` の記録から daemon が作るブロック (`commentBlockOf`、送ったものと同じ) と全部のキーで一致するブロックを見たら `delivered` にして `row_uuid` を書く (cid だけで決めない。送信待ちの cid を持つ別の本文の行を、そのコメントと取り違えないため)。読む人の行は 3 通り (Context): `type:"user"` の `promptSource` が `typed` / `queued` の行の文と、`queued_command` の添付の行の `attachment.prompt` (`queuedPersonPrompt`)。`type:"user"` の行が人の発言かは、webui の TL が人の発言として描く行の決め方 (protocol の `classifyUserMessage` が `user-prompt` とする行) と同じ 1 つの規則で決め、daemon と webui で別の規則を持たない (DR-0058 §11 と同じ考え方)。ccmsg で届いたメッセージ・harness の差し込み (`isMeta`)・compact の要約の行は読まない。照合はそのセッションの記録を読んだ時 (§8) にも走る。`unconfirmed` のうち照合できないものには、人の操作「下書きに戻す」(`draft` に戻す) と「送った扱いにする」(`sent` にする、P32) を置く
- **行が出るまでの描き方**: `sending` / `sent` / `unconfirmed` のコメントは、transcript に行が出るまで記録から描く (TL の送った時点の位置と 💬 のフィルタ。未送信のものと同じ吹き出しで、未送信の印は持たない)。送信の列で順番を待つ `sending` と、その間に daemon が止まって `unconfirmed` になったものは送った時点 (`sent`) を持たないので、書いた時点 (`written`) の位置に描く (§2 の「未送信のものは書いた時点」と同じ)。💬 のフィルタからも TL からも消える間を作らない。`sent` を持たない `unconfirmed` も照合の対象で、「下書きに戻す」「送った扱いにする」を出す。`delivered` になったら transcript の行の描画に替わる (cid で同じものと分かる)
- **btw のフラグの付いたコメント**: 本体の context に入れず、1 件ずつ btw として走らせる (§14)。送る順序の対象外
- **FAB の下書き**: 1 件ずつ別のプロンプトとして送る (空行で連結しない)。1 件ずつ送れば、turn の最中に続けて送っても transcript では 1 件 1 行になり、送った下書きと人の行を 1 対 1 で照合できる (Context)。model には同じ turn に別の text block で並んで届く。送る前に添付が在るかを確かめ、無ければ送らずに `attachment_missing` を返す (§15)。結果はコメントと同じく `accepted` なら `sent`、`unconfirmed` なら `unconfirmed`、`not_delivered` なら `queued` に戻して `send_error` に理由を書く。`not_delivered` が出たら残りを送らない (P7)
- **FAB の下書きの届いたの確定**: daemon は push された人の行と追いつきの読みで、3 通りの人の行 (上の「届いたの確定」と同じ) の文と、そのセッションの `sent` / `unconfirmed` の下書きの送った文 (添付を置き換えた後) を `pairLandedPrompts` で組み、組めた下書きを届いたとして記録を消す (§15)。文の正規化は `promptTextKey` (両端の空白を落とす) で、今の FAB の未確認の自動解消 (DR-0035 §5) と同じ部品を使う。行の時刻は `queued_command` では待ちに入った時刻、`queued` の行では待ちから出た時刻で、どちらも送った時刻より後になる
- **照合できないまま turn が終わった時**: 送ったコメントと FAB の下書きが `sent` のまま、送った後の最初の turn が終わって idle になった時点でまだ届いたと照合できていなければ、`unconfirmed` に落として人の目に出す (P35)
- **送る順**: `queue_send` は渡された順に送る (続いて並ぶコメントは 1 つのプロンプト、FAB の下書きは 1 件ずつ)。btw のフラグの付いたコメントは順の外で、送るプロンプトより先に fork を頼む
- **途中で止まった時**: どのプロンプトでも `not_delivered` が出たら、後ろの項目はコメントも FAB の下書きも送らない (P7)。送らなかったものはコメントは `draft`、下書きは `queued` に戻して `send_error` に同じ理由を書き、項目の結果も同じ理由の `not_delivered` で返す。それより前に入ったものは入ったまま (`sent` / `unconfirmed`) で、一部だけ送れた状態は項目ごとの結果と記録の状態で分かる。`unconfirmed` と `refused` の項目は後ろを止めない
- **全部送る** (kawaz 2026-11-24): 溜めたもの (未送信のコメント (`draft`、btw のフラグの無いもの) と FAB の下書き (`queued`)) は、コメントとプロンプトを区別せずまとめて送る。対象と順は webui の純関数 (`stockedItems`) 1 つで決める: 書いた時点 (`written`) の古い順で、同じ時刻ならコメントが先。届いたか分からない・送信中のもの、btw のコメント (`draft` に戻った btw も)、💬 のフィルタのチェックボックスで隠れているかは見ない。解決済みのスレッドに付いた未送信のコメントも入る。口は 3 つで、どれも同じものを送る:
  - **FAB の通常の送る**: 溜めたものを `queue_send` で送り、その返事の後に今の文を `user_prompt` で送る。結果のどれか (コメントも下書きも) が `not_delivered` なら今の文も送らない (§15)
  - **コメントのフォームの「送る」** (3 分割のボタンの送る、§3): `comment_add` (`send_now` なし) でそのコメントを保存し、溜めたものの後ろにそのコメントを置いた列を `queue_send` で送る。保存した後の `queue_send` が送れなかった時、そのコメントは未送信で残る
  - **💬 のフィルタの「全部送信」** (§13): 溜めたものを `queue_send` で送る
- **すぐ送る** (`comment_add` の `send_now`、btw の時、§3、§14): そのコメント 1 件を btw の列に入れる
- turn の最中に続けて入れたプロンプトは連結されず 1 件 1 行で残り、model には同じ turn に並んで届く (Context)。並んで届くことは、人が溜めたものをまとめて送る形 (全部送る) で扱う

### 12. TL と Files の見せ方

- **届いたコメントのバブル** (`CommentBubble`、右寄せは統括案、kawaz の異論なし): 送ったコメントは、ユーザの発言の側 (右寄せ) の専用のコメントバブルとして出す。transcript の人の発言の行の本文が、空白だけの行を除いて全ての行がコメントのブロックとして読める (§4 の読み取り、`commentOnlyBlocks`。§11 の届いたの確定と同じ規則) なら、その行をブロックごとのバブルとして描く (まとめて送った時は複数のコメントバブルに見える)。cid から記録を引いてアンカーへのリンクと選んだ文字を出す。本体に送ったもの (`sent` / `delivered` / `unconfirmed`) は本文の一番下の行の右端に「返信」ボタンを持つ (§3)。行が出る前は記録から同じ部品で描く (§11)。コメントのバブルで描く行も人の発言の行なので、👤 のフィルタ・「↑前 | 次↓」・「↑最新のプロンプトへ移動↑」の対象に入る (窓の中と外で同じ。DR-0058 §11 の判定 `user-prompt` のまま)
- **`comment_reply` の応答** (`CommentReplyBubble`): transcript の `comment_reply` の呼び出しの行 (結果が `commentReplyRecorded` で読めるもの) を、普通のエージェントの応答とほぼ同じに見せる。バブルの一番上に、`comment_reply` による応答と分かる少しの装飾・元のコメントの場所へ飛ぶリンク・返信先の cid のユーザのコメントを出すヘッダを足す。本文は呼び出しの行の `body` を応答と同じ markdown で描く。本文の一番下の行の右端に「返信」ボタン (§3)。表示の正本は transcript の行 (DR-0040 §4 と同じ流儀)。TL の並びでも普通の応答と同じ扱いで、fold (「N items」) の中に入れず、そこで fold の並びが切れる (前後の tool の呼び出しは別々の fold になる)。呼び出しの結果の行は吹き出しに含め、TL の項目として出さない。本文は 🔍 の検索の対象 (応答の本文と同じ)
- **返信の後の `comment_reply_done`** (kawaz 2026-11-24): assistant の応答 (メインの会話でも subagent / teammate の TL でも) のうち、本文の text が 1 つだけで、前後の空行を除いて 1 行で、`comment_reply_done` (`COMMENT_REPLY_DONE_TEXT`、§5) を英数字と `_` に続かない 1 語として含むものは、吹き出しにせず、ツールの呼び出し等と同じ「N items」の畳みの中の 1 項目にする (返信の吹き出しと同じ話の 2 つ目の吹き出しを作らないため)。バッククォートで囲む・句点が付く等の 1 行の中のブレは同じ扱い。2 行以上の本文、thinking や tool の呼び出しを伴う応答は、この語を含んでいても普通の吹き出し。畳みの中では他の項目と同じ「▶ 時刻 ラベル」の 1 行で、ラベルは `assistant: comment_reply_done`、開くと本文をそのまま出す。扱いは llm-gateway の keep-alive への応答の行と同じで、項目の数・jsonl ⭐ の組・TL の位置 (DR-0058) は畳みの中の他の項目と同じ、TL の検索の対象にはしない
- **スレッドの中の番号** (kawaz 2026-11-24): 人のコメントが 2 つ以上あるスレッドの人のコメントとエージェントの返信の吹き出しの頭の行に、フィルタの無い TL でも「1 / 3」の番号を出す (決まりは §13)。分断されたスレッドを追う手掛かりで、「↓続きへ↓」と対になる
- **「↓続きへ↓」** (kawaz 2026-11-24): スレッドは「人のコメント → エージェントの返信 → 人のコメント → …」と続くが、TL では返信と次の人のコメントの間に別の会話が挟まって分断されることが多い。エージェントの返信 (`comment_reply` の応答) と btw の答えの吹き出しに、続き (その cid を返信先にした送った人のコメントのうち一番古いもの、btw の質問を含む。未送信と消したものは TL に描かれないので数えない) があり、フィルタの無い TL の並びで返信と続きの間に畳み (「N items」の行) 以外の項目が挟まっている時だけ、吹き出しの枠の内側の下端、「返信」の行の左右の真ん中に「↓続きへ↓」を出す。畳みはエージェント自身の作業 (ツールの呼び出し、`comment_reply_done`) を 1 行にしたもので、別の会話ではないので数えない。日の帯と空き (DR-0054) は項目でないので数えない。見た目は「コメントした場所へ」のボタンと同じで、字は「返信」と同じく CSS で出す (本文の選択とコピーに入らない)。押すと続きの行へ「コメントした場所へ」と同じ移動 (`commentPlaceRow` の行へ、DR-0058 §6、短い smooth) で移る。移る行が無い続きには出さない。逆向きは頭の行の「元のコメントへ」。💬 のフィルタでは返信の返信が返信の直後に並ぶ (§13) ので出さない。⭐ / 🔍 のフィルタで返信が見えている時は、フィルタの無い TL の並びで決め、押すとフィルタを外して移る
  - **作り**: webui の純関数 (`continuationsApart`) が、フィルタの無い TL が描く順の並び (各 slot の吹き出し、各組の畳みか項目) と記録から、続きが離れている返信とその移る先の行を決める。吹き出しは TL のコメントの文脈 (`continuationOf`) から引く
- **btw のコメントと答え** (`BtwCommentBubble`、§14): btw のフラグの付いたコメントとその答えの組を、送った時点の位置 (`sent.after_uuid` の行が読み込んだ範囲 (窓) にあればその行を含む項目の直後、行が窓に無い (compact 等で消えた) か無い記録は送った時刻の位置。送った時刻が窓の先頭より古ければ過去分を読み込むまで出さない。同じ位置の複数は送った時刻の順) に 1 項目で出す。質問の側はコメントの見た目 (種類・引用・選んだ文字・本文)、答えの側は `comment_reply` の返信と同じ吹き出し (枠・応答の地・余白・左の縁と頭の行) で描き、質問と答えのどちらの頭にも目立つ「btw」のバッジ (accent の地の角丸、サイドバーの部屋の種類のバッジと同じ見た目) を付けて、本体の context に入っていないことを示す。全体を囲む枠は持たない (kawaz 2026-11-24)。質問の側は「返信」ボタンを持たない (§3)。答えの応答中の行・失敗の文・取り消し・「もう一度聞く」・返信の行は答えの吹き出しの中に、前の試行の 1 行は質問と答えの間に、model・時間・usage の足元は答えの吹き出しの下に置く。解決の印は質問と答えのそれぞれの吹き出しの内側の下端の行に置く (P14)。`failed` / `canceled` の答えの下に「もう一度聞く」(`comment_btw_retry`)
- **アンカーの印** (§2 の表): アンカーがメッセージ・選択範囲・コメントのコメントの付いたバブルには常に 💬 を数付きで吹き出しの外に出す (数と置き場は P8)。範囲選択のコメントは、バブルの中の選んだ文字を探し直した範囲 (§2) をハイライトし、範囲の後ろに 💬 を置く (塗り方は P31)
- **Files の箇所**: アンカーがファイルの箇所のコメントは、Files でそのファイルを開いた時に、今の内容の中から文字で探し直した箇所をハイライトし、後ろに 💬 を置く。付けた表示 (ソースかプレビューか) で出し、もう一方の表示では出さない。ハイライトは TL と同じ `ccmsg-comment` (Files の着色 `ccmsg-syntax-*`、検索 `ccmsg-search-*` と別の名前)。💬 は文字を持たない重ねた層に置き、プレビューは TL と同じ範囲の最後の行の右上の角、ソースは行の間に空きが無いので範囲の最後の行の文の後ろ (その行の右の空き) に行の高さで置く。探し直し方と、見つからない時の扱いは P20 / U3
- 💬 (項目の印とハイライトの後ろの 💬) を押すと 💬 のフィルタの画面 (§13) へ移り、コメントを選んだ状態にする。項目の印はその項目のコメント全部を、範囲の後ろの 💬 はそのコメント 1 件を選ぶ

### 13. 💬 のフィルタの画面

- **ツールバー**: TL のツールバーの並び (🔔 🔐 ⭐ 👤 🔍) に 💬 を置く (位置は P4)。数は未送信のコメントの数 (`status` が `draft`)。FAB の下書きは数えない (FAB 自身に出す、§15)。数の部品と決まりは `CountBadge` (DR-0050)。agent の TL では出さない
- **URL**: `?filter=comment`
- **1 本の並び** (kawaz 2026-11-23): フィルタの画面は、他のフィルタと同じく TL の項目を CSS で絞った 1 本の並びで、送ったものと未送信のものを同じ並びに置く。並ぶのは、コメントとその返信 (届いたコメントバブル (§12)、行が出る前の記録から描くコメント、`comment_reply` の応答)、btw の問答 (`BtwCommentBubble`)、未送信のコメント、FAB の下書きのうち届いたと確かめていないもの (`queued` / `sending` / `unconfirmed`)
- **スレッドごとの並び** (kawaz 2026-11-23): 並びはスレッドごとにまとめる。スレッドの始まりの項目 (返信先が一覧に無いもの) は TL の位置 (P10) の順に並び、その返信 (エージェントの `comment_reply` の応答、それへの人の返信) は transcript の行の位置でなく返信先の直後に続く。同じ返信先への返信は時刻の順 (人のコメントは送った時点、エージェントの返信は記録した時点)。まとめて送った 3 件に 3 件の返信が返った時は「コメント 1 → 返信 1 → コメント 2 → 返信 2 → コメント 3 → 返信 3」。返信先が一覧に無い (読めない・消えた) 返信と、スレッドを持たないもの (送った FAB の下書き、btw の問答) は、自分の TL の位置に 1 件で立つ。この並びは 💬 のフィルタだけのもので、フィルタの無い TL は transcript の順のまま
- **未送信は一番下** (kawaz 2026-11-24): 未送信のもの (`data-unsent` の印を持つもの: 未送信のコメント (送れずに `draft` に戻ったものを含む)、未送信の btw の質問、未送信の FAB の下書き (`queued`)) は、時刻やスレッドに関係なく並びの一番下にまとめる。スレッドへの未送信の返信もスレッドから離して下に置く。下にまとめた中は書いた時刻 (`written`) の順で、同じ時刻ならコメントが FAB の下書きより先 (送る時の順と同じ、`stockedItems`)。送ったもの・届いたものの並びとスレッドのまとめ方は、未送信を抜いた形のまま変わらない (未送信の返信の後に続く送ったものは、スレッドの中のそのままの位置に立つ)。未送信の返信は下にあっても、頭の行 (「↩ … への返信」「コメントした場所へ」) で何への返信かが分かる。未送信の返信もそのスレッドのものとして扱い (スレッドを開くと開いた印が付き、押すとそのスレッドが開く)、スレッドを開いてもスレッドの中に重ねては出さない (1 か所だけに出す)
  - **作り**: 項目の DOM は TL の順のまま作り直さず、webui の純関数 (`threadPlaces`) が決めた並びの位置を項目の `data-thread-order` / `--thread-order` に持たせ、フィルタの CSS が grid の `order` にする (フィルタを外せば TL の順に戻り、§6 の位置合わせが測る DOM も変わらない)。日の帯と空き (DR-0054) は時刻の順の並びのもので、スレッドの順には合わないので 💬 のフィルタでは出さない
- **スレッドの間の線** (kawaz 2026-11-23、見た目は 2026-11-24): スレッドとスレッドの間 (1 件で立つものも 1 つのスレッドとして数える) に、TL の日の帯の罫 (DR-0054、`.tl-day` の `--day-band-line` の 3px) と同じ見た目の目立つ横線を引く。日の帯の札 (日付のピル) は持たない。同じスレッドの中には引かない。未送信のかたまりの手前にも同じ線を 1 本引き、かたまりの中には引かない。線は見えている最初の項目が持ち (`data-thread-sep`)、一覧の頭のスレッド (またはかたまり) は持たない。隠れたスレッドと隠れた項目 (チェックボックス、閉じたスレッドのエージェントの側) は線を持たないので、線が続いたり頭や末尾に残ったりしない。どの項目が見えるかは CSS と同じ決まり (`commentItemShown` と、返信先の人のコメントが並びにあるエージェントの側は開いたスレッドだけ) で決め、「コメントはありません」もこの同じ決まりで見えている項目が無い時に出す
- **解決の付け外しの動き** (kawaz 2026-11-24): `resolved` のチェックが入っていない時に解決済みにしたスレッドの項目 (開いていればその返信も、項目の持つスレッドの間の線も) は、薄くなりながら縦に縮んで消え (ロールアップ)、下の項目が上がってきて消した位置に来る。スクロール位置は JS で動かさず、高さが縮むことで詰まる。解決を外して並びに戻る時と、`resolved` のチェックの入り切りで解決済みが出入りする時も、同じ動きで開く・閉じる。人が押した時も、別のデバイスでの解決の知らせ (`comment_thread` の push) の時も同じ。フィルタに入った時の最初の描画と、他のチェックボックス (`sent` / `comment` / `btw`) の入り切り、スレッドの開閉、他のフィルタの切り替えは動かさない。時間は 180ms ease-out (パネルの出入りと同じ)。動きを減らす設定 (`prefers-reduced-motion: reduce`) と、高さの `auto` への補間 (`interpolate-size`) の無いブラウザでは動かさず一瞬で切り替える。縮んでいる間は押せず、縮み終わると今までどおり `display: none` で隠れ、支援技術にも読まれない
  - **作り**: 隠し方は今までどおり CSS の `display: none` で、DOM は作り直さない。`display` を `transition-behavior: allow-discrete` で終わりまで残し、高さを `interpolate-size: allow-keywords` で `auto` と 0 の間で補間する (出る時は `@starting-style` から)。高さが 0 になった後の行の間 (`.tl-lines` の gap) は下の余白を gap の分だけ負にして消える前に詰め、線は太さと余白で動かす。動くのは、フィルタに入った後に解決が変わったスレッドの項目と、`resolved` のチェックを切り替えた後の解決済みの項目 (`data-thread-motion`) だけで、それをフィルタに入ってからの変化として webui の純関数 (`resolveMovesNext`) が前の描画と比べて決める (変化を見た描画で印を付けるので、隠す変更と同じ commit に印が乗る)。他の出し入れ (他のチェックボックス、スレッドの開閉) が変わった描画で印は全部外れ、その変化は動かない。印が 1 つでもある間、行の列 (`data-comment-motion`) は線の付け外しも動かす (隣のスレッドが一覧の頭になって線を失う時に跳ねないため)。並びの位置は今までどおり `order` で、未送信を一番下に置く決まりとも両立する
- **人のコメントだけを並べ、選んだスレッドの返信を出す** (kawaz 2026-11-24): 並びには人のコメント (未送信・送ったもの・btw の質問) と FAB の下書きを出し、エージェントの側 (`comment_reply` の応答、btw の答えとその前の試行と足元) は既定で出さない。人のコメントを選ぶと、そのスレッド (選んだコメントから返信先を辿った最初のコメントのスレッド) が開き、そのスレッドのエージェントの側が全部出る。開くのは選んでいるコメントのスレッドで、別のコメントを選ぶと前のスレッドは閉じる。項目の 💬 (その項目のコメント全部) を選んでこの画面に来た時は、それらのコメントのスレッドが開く
  - **返信先が並びに無い返信**: 返信先の人のコメントが並びに無い (消された、窓に無い等) エージェントの返信は、開く手段が他に無いので隠さず、自分の位置に 1 件で立つ (線も持つ)。btw の答えは質問と同じ項目にあるので、いつも質問から開ける
  - **閉じる** (kawaz 2026-11-24): 開いているスレッドの先頭の人のコメント (スレッドの根) を押すと、選択が外れてどのスレッドも開いていない状態に戻る。項目の 💬 で開いた時 (選択が項目のもの) も同じ。2 つ目以降の人のコメントを押した時は閉じず、選択がそのコメントに移る
  - **選び方**: 人のコメントの項目を押す (吹き出しの中のボタン・リンク・入力欄を押した時と、押して範囲選択が残る時は選ばない)。選ぶのは既存のコメントの選択 (§12 の `commentSelectionKey`) で、選んだ吹き出しには選んだ印の縁取りが付く。💬 のフィルタの中では、人のコメントの項目を押すのは TL の位置への移動 (DR-0058 §6) でなくこの選択 (TL の位置へは「コメントした場所へ」で移る)
  - **キーボードと支援技術**: 吹き出しの頭の「💬 コメント」が、そのスレッドの開閉のボタン (WAI-ARIA APG の Disclosure の形: `button` と `aria-expanded`) になる。閉じているスレッドでは、並びに出ている人のコメントのどれでも開くので、どのコメントの頭もボタン (`aria-expanded="false"`)。開いているスレッドでは、閉じられる先頭 (根) のコメントの頭だけがボタン (`aria-expanded="true"`) で、2 つ目以降の頭は普通のラベルに戻る (押しても閉じないので、閉じない開閉のボタンを支援技術に見せない。ポインタで 2 つ目以降を押すと選択が移るのは「閉じる」のとおり) (kawaz 2026-11-24)。Tab で移って Enter / Space で、項目を押したのと同じことをする。項目そのものは操作の要素にしない: 項目は中に「返信」や吹き出しのボタン・リンクを持ち、button の中身は支援技術に一つの塊として読まれて中の操作に届かなくなるため。項目を押すのは、本物のボタンと同じことをするポインタ用の近道 (中に操作を含むカードの定番の形)。見た目はラベルのままで、押せることは手の形とキーボードで移った時の枠で示す
  - **全文** (kawaz 2026-11-24): 開いたスレッドの項目 (人のコメント、エージェントの返信、btw の答え) は、フィルタの中の高さの抑え (DR-0058 §6) を掛けずに全部出す。閉じたスレッドの人のコメントは抑えたままで、抑えるのは本文の字だけ (頭の行・引用・操作のボタン・「返信」は抑えの外に置き、切れて見えなくならない)。閉じたスレッドの抑えたコメントを押すと、スレッドが開いて全文になる (押して抑えだけを外す段は、💬 のフィルタの人のコメントには無い)
  - **作り**: 絞り方は今までどおり DOM を作り直さず CSS で隠す。項目は `threadPlaces` が決めた並びの位置と一緒に、閉じたスレッドで隠すエージェントの側の印 (`data-comment-agent`、返信先の人のコメントが並びにあるものだけ) と開いたスレッドの印 (`data-thread-open`) を持つ。開いたスレッドは webui の純関数 (`openThreadRoots`) が選択から決め、押した時の選択は `threadPressKey` が決める
- **スレッドの中の番号** (kawaz 2026-11-24): 人のコメントが 2 つ以上あるスレッドでは、そのスレッドの人のコメントとエージェントの返信 (`comment_reply`、btw の答え) の頭の行に「1 / 3」の形の番号を出す。分母はそのスレッドの人のコメントの数、分子は、人のコメントは自分が何番目か、エージェントの返信は返信先の人のコメントの番号。数えるのは消していない人のコメント (未送信も数える) で、順はスレッドの中の順 (返信先の直後、同じ返信先への返信は時刻の順)。未送信のものは、この画面で一番下に置く前のスレッドの中の位置で数える。人のコメントが 1 つだけのスレッドには出さない。見た目は頭の行の小さい字のままで、字は CSS で出し (本文の選択とコピーに入らない)、支援技術には「3 件中 1 件目」と読ませる。フィルタの無い TL の吹き出しにも同じものを出す (§12)。番号は webui の純関数 (`threadNumbers`) が記録から決める
- **未送信の見せ方**: 未送信のコメント (`draft`) は送ったコメントと同じ `CommentBubble` で、未送信の FAB の下書き (`queued`) はユーザの発言と同じ吹き出しで、添付を置き換えた後の文 (届く形) で描く。違いは吹き出しの緑の地を少し薄くすることだけで (`data-unsent`)、読み上げ用の名前に未送信と入れる (「未送信のコメント」「未送信の FAB の下書き」)。状態を言い分ける字・見出し・区切り (未送信 / 送信中 / 入れた / 届いた 等) は出さない
- **吹き出しの操作**: 未送信のコメントと下書きは吹き出しに「消す」「直す」「送る」を持つ (コメントの「直す」は吹き出しの中で本文を直し、下書きの「直す」は FAB の入力欄に読み込む、§15)。届いたか分からない (`unconfirmed`) コメントと下書きは「下書きに戻す」「送った扱いにする」を持つ。どれもボタンだけで、状態を説明する文を足さない。断られた時と、前の送信が届けられなかった時 (`send_error`) は、その理由を吹き出しの中に出す
- **ヘッダ**: TL のツールバーの中に、`[x] sent` `[x] comment` `[x] btw` `[ ] resolved` のチェックボックスをこの順で並べ、端に「全部送信 (N)」を置く。入り切りは覚えず、フィルタに入るたびにこの既定に戻る
  - `sent`: 送ったもの (コメント・返信・btw の問答、届いたか分からないもの) を出す。外すと未送信のもの (未送信のコメントと `queued` の下書き) だけが残る
  - `comment`: コメントとその返信 (`comment_reply` の応答を含む。応答は開いたスレッドでだけ見える) を出す
  - `btw`: btw の問答を出す
  - `resolved`: 解決済みのスレッドを出す (§6)。隠す単位はスレッドで、スレッドの記録はどれも同じ解決の状態を持つ
  - FAB の下書きはコメントでも btw でもないので、`comment` / `btw` の入り切りに依らず出る
  - 絞り方は他のフィルタと同じく DOM を作り直さず CSS で隠す: 行の列の `data-comment-show` が入っているチェックボックスの語を持ち、各吹き出しが種類 (`data-comment-kind`: `comment` / `btw` / `draft`)・未送信 (`data-unsent`)・解決済み (`data-resolved`) の印を持つ。隠すかの決まりは webui の 1 つの純関数 (`commentItemShown`) にも持ち、「コメントはありません」の判定に使う
- **全部送信** (kawaz 2026-11-24): 押すと溜めたもの全部 (§11 の「全部送る」: 未送信のコメントと FAB の下書き、書いた時点の順) を `queue_send` で送る。チェックボックスで隠れているものも送る (FAB とコメントのフォームの「送る」と同じものを送る)。btw のフラグの付いた未送信のコメントは本体のプロンプトに入らないので含めない。送るものが無い時は押せない。ボタンの字の件数は送るものの数。入らなかったものがあれば、その理由をボタンの下に出す。同じ理由のものは 1 行にまとめて「N 件: <理由>」とし (1 件なら件数を添えない)、理由が違えば理由ごとに 1 行 (kawaz 2026-11-24)
- **元の場所へ**: 個別のコメントから、コメントした場所 (uuid の項目、ファイル、返信先のコメント) へ飛べる (項目は DR-0058 §6 の移動、ファイルは Files のその箇所を開く)。返信先のコメントへは、その吹き出しが TL に描かれている所へ移る: 届いた人のコメントはその行、エージェントの返信はその `comment_reply` の呼び出しの行、btw の質問と答え (transcript に行を持たない) と届く前の送ったコメントはその項目が後ろに描かれる行 (送った時点、無ければ書いた時点の行、P21) (kawaz 2026-11-24)。移る先の行が無い (消した、時点が行を名指さない) 時はボタンを出さない。ボタンは、TL の中の移動は button、Files を開くのは遷移なので a だが、どちらも同じ枠のボタンの見た目にする。ファイルは Files でそのファイルを付けた表示 (ソースかプレビュー) で開き、探し直した箇所を見える所へ短い smooth で寄せる。範囲選択のコメントの探し直しが外れたものには「元の場所が見つからない」、ファイルの箇所の探し直しが外れたものには「元の場所が無くなった」と出す (§2、P20)
- **窓の外**: 窓の外の届いたコメントとエージェントの返信は daemon の記録から時刻の位置に出す (返信の本文は記録の `body_start`)。未送信のコメントと下書きは、置き場の行が窓に無く窓より古いものも出す (見えている所から送るので、見えない所に置かない。並びの上では一番下)
- 項目の 💬 や範囲の後ろの 💬 を押してこの画面に来た時は、その項目のコメント全部、またはそのコメント 1 件を選んだ状態にする (§12)

### 14. btw のフラグと btw モードの吸収

- btw の付いたコメントはエージェントの context に足さず、daemon がセッションの hooks module に 1 件ずつ fork を頼んで答えさせ ([DR-0060](./DR-0060-btw-mode.md) §1、§2)、答えを webui に送って同じように混ぜて表示する。プロンプトは DR-0060 §3 の前置きの後にコメントのブロック (§4) を置いたもの。添付は送る時に `[FILE<N>:<name>](<path>)` に置き換える。fork は本体の model と effort で走る (DR-0060 §6)。FAB で btw を入れている間は effort を選べない
- まとめて聞かない (btw 同士の文脈が混ざるため)。cache の読み込みの重複は気にしない
- **すぐ走らせる**: 送った btw はどれもすぐ fork を起こし、空きを待つ列を持たない。同時に走る数は数えず、全部送るで何件送っても断らない (DR-0060 §7)
- **btw の未送信**: フォームでも FAB でも btw は今すぐ聞くもので、btw の未送信を作る入口は無い (§3、§15)。`draft` の btw は、daemon が fork を頼めなかった btw を `draft` に戻したものと、送る途中で daemon が止まって戻したもの (下の質問の状態) で、人は 💬 のフィルタの吹き出しの「送る」で聞き直し、「直す」で直し、「消す」で片付ける。「全部送信」には入らない (§13)
- **質問の状態**: `draft` → (送る) → `sending` (fork を頼んでいる) → `sent` (fork を頼んだ、送った時点 `sent` を書く)。daemon がそのセッションの場所 (cwd) を知らずに頼めなかった時は `draft` に戻して `send_error` に `session_not_found` を書き、`queue_send` の結果は `not_delivered` にその語を添える。頼む時に例外が出た時の語は `btw_launch_unavailable`。`sending` のまま daemon が止まった質問は、次の daemon が `draft` に戻す (人の操作なしに起動の後で fork を起こさない)
- **答えの記録**: fork を頼んだ時に daemon が答えの記録 (`author: "btw"`、アンカーは質問の cid、`status: "running"`、本文は空) を作って cid を振り、fork が終わったら全文の `body` と終わり (`done` / `failed` / `canceled`) を書く。module の無いセッション・古い module・`/compact` と `/clear` の直後等で fork が答えなかった時は `failed` で、`error` に理由と次にすることを書く (DR-0060 §1、§2)。答えの「返信」と答えの中の範囲選択は、終わった (`done`) 答えにだけ出す (失敗・取り消しの答えは「もう一度聞く」の対象)
- **取り消し**: `comment_btw_cancel` で答えを `canceled` にし、セッションの fork も止める (DR-0060 §5)
- **もう一度聞く**: 最後の答えが `failed` / `canceled` の質問は `comment_btw_retry` でもう一度聞ける。同じ質問から新しい答えの記録を作る (P30)
- **btw の答えへの返信** (kawaz 2026-11-23): btw の答えに直接付けた返信のコメントは、`on` を `btw:<その答えの cid>` にし、その btw の質問の文を `btw_req`、答えの全文を `btw_res` に付ける (§4)。本体に渡す時も btw の fork に渡す時も答えは全文で、何に対する返信かはこの組で読む (本体はその btw を見ていないため)。`reply_to` のような別の返信先のキーは持たない (`on` の cid が返信先)。btw は質問 1 つに答え 1 つで、付けるのは常にその 1 組だけ (前の段を辿って渡さない)。組を付けるのは btw の答えに直接付けた返信だけで、そのコメントには cid が付くので、以降のやり取り (エージェントの `comment_reply`、それへの人の返信) は普段どおり `comment:<cid>` で辿り、組は繰り返さない
- **btw の中では `comment_reply` を使わせない**。fork は本体の tool を継ぐので呼べるが、module が btw の fork の agentId からの呼び出しを断り、答えは本文に書かせる (§5 の btw の fork)。止めるための settings の `permissions.deny` は付けない (fork は本体の権限を継ぎ、本体からは使える tool のため)
- btw の答えは「本体の context に入っていない」ことがひと目で分かる見た目にする (質問と答えの頭の「btw」のバッジ、§12。kawaz 2026-11-24)
- **btw モード (DR-0060) を吸収する** (裁定 1): FAB の 3 分割のボタンの btw で送るものは、アンカーがタイミングの btw コメントにする。FAB の btw の添付と取り消しは落とさない。btw の記録・保存・配り方・表示の部品はコメントのものを使う:

  | btw の部品 | コメントの仕組みの側 |
  |---|---|
  | 聞く | `comment_add` (アンカーはタイミング、`btw: true`、`attachments`、`send_now`)。btw・後で・送る は 1 つの 3 分割のボタンで、選ばれるのは 1 つ (2026-11-24 の裁定 2) |
  | 取り消す | `comment_btw_cancel` |
  | 質問 | 質問のコメントの記録 (`author: "user"`) |
  | 答え (`body`、`status`、`model`、`effort`、`ended_at`、`error`、`usage`) | 答えの記録 (`author: "btw"`、P24) |
  | 聞いた時点 (アンカー) | 質問の記録の送った時点 (`sent`) |
  | 保存 | `<sid>.comments.jsonl` (§8) |
  | 配り方 | `ev:"comments"` / `ev:"comment"` (§10) |
  | TL の項目 | `BtwCommentBubble` (質問の側をコメントの見た目で描く、§12) |

- **既にある `<sid>.btw.jsonl` の記録の写し** (P25): daemon がそのセッションの記録を初めて読む時に、1 つの btw を質問のコメント (`author: "user"`、アンカーはタイミング、`btw: true`、`status: "sent"`、書いた時点と送った時点は btw の聞いた時刻とその時点の最後の行) と答え (`author: "btw"`、アンカーは質問の cid、`model` / `effort` / `ended_at` / `error` / `usage` はそのまま) の 2 つの記録にして、1 回の追記で書く。質問にも答えにも元の btw の id (`btw_id`) を持たせ、どちらかに同じ `btw_id` の記録が既にあれば写さない (途中で止まって読み直しても二重にしない)。`running` のまま残っていた btw の答えは `failed` (「daemon が止まった」)。全部写したら `<sid>.btw.jsonl` を消す。書けなければファイルを残し、次に読む時に写す。古い行を読むスキーマは写し専用に daemon の側に置き、読めない行は捨てて daemon.log に残す

### 15. FAB のキュー

- FAB の送信もキューに置ける。キューは単に送るタイミングを後ろにずらすだけで、エージェントには通常のプロンプトが複数届いたように見える (comment の形で包まない)。btw でない FAB の下書きはコメントにせず、アンカーを持たない (送る前は TL のどこにも出ず、送った後は transcript の人の行として出るので、位置を決めるアンカーが要らない。時点の記録 `written` / `sent` は持つ)
- まとめて送る時も 1 件ずつ別のプロンプトとして送る (§11)。transcript では 1 件 1 行になり、model には同じ turn に並んで届く。並んで届くことは、人が 💬 のフィルタで未送信のものを並びの中で読んでから送る形で扱う (§13)
- 未送信の FAB の下書きの数は FAB 自身に出す (TL の 💬 はコメントの数だけ)。パネルを開いている間は、通常の送る (3 分割のボタンで送るが選ばれていて、下書きを直していない) の時だけ、今の文より先に送る溜めたもの (下の「通常の送るは溜めたものも送る」) の件数を、同じ見た目で送るの区画の右上に重ねる (裁定 15)
- **入力欄のフォーカス** (kawaz 2026-11-24): FAB の入力のパネルの 3 分割のボタンの区画、📎、添付のチップの × も、コメントのフォームと同じ部品で同じ決まり (§3 の「入力欄のフォーカス」)。パネルの頭の入力先のエージェントの `select` と `--effort` の選択は、選択の画面を開くのでこの決まりの外
- **通常の送るは溜めたものも送る** (裁定 15、kawaz 2026-11-24): 通常の送るは、溜めたもの (FAB の下書きと未送信のコメント、§11 の「全部送る」) を書いた時点の古い順に `queue_send` で先に送り、その返事を待ってから今の文を `user_prompt` で送る。送信の列 (§11) に溜めたもの → 今の文の順で入る。返事を待つのは、`queue_send` が記録の列で記録を読み書きしてから送信の列に並ぶのに対して `user_prompt` はすぐ送信の列に並ぶので、続けて投げると今の文が先に入りうるから。溜めたもののどれか (コメントも下書きも) が `not_delivered` になったら、残りと同じく今の文も送らず入力欄に残し、理由は今の文の送信が届かなかった時と同じ注記で出す。`queue_send` の返事が得られなかった時も今の文は送らない。`unconfirmed` や `refused` のものは今の文を止めない (残りを止めないのと同じ)。届いたか分からない・送信中のものは送らない。宛先が subagent の時、btw か「後で」が入っている時、下書きを直している間はまとめて送らない。1 件だけ送るのは、「後で」で溜めてから 💬 のフィルタの吹き出しの「送る」で送る。送信のボタンに重ねる数とボタンの title が言う件数は、どちらも先に送る溜めたものの件数で同じ (kawaz 2026-11-24)
- **下書きの記録** (`PromptDraftRecordSchema`): `{ kind: "draft", id, session_id, written, sent?, updated_at, text, attachments: [{ n, name, path }], status: "queued" | "sending" | "sent" | "unconfirmed", send_error? }`。`id` は daemon が振る UUIDv4 (エージェントに見せないので cid にしない)
- **送り終えた下書きは記録ごと消す** (裁定 3)。「送信済み」の印で残さない (残す意味が無い)。状態の移り方:
  - `queued` → (送る) → `sending` → `sent` (入れた) / `unconfirmed` / `queued` (`not_delivered`、`send_error` 付き)
  - `sent` / `unconfirmed` → 送った文が transcript の人の行として届いたのを確かめた時 (§11) に記録を消す。届くまでは `sending` / `sent` で持つ (未確認になった時に下書きに戻す・送り直すために要る)
  - `unconfirmed` → 人の操作「下書きに戻す」で `queued`、「送った扱いにする」で記録を消す
  - `queued` → 人の操作「消す」(`prompt_queue_delete`) で記録を消す
- **消すのは記録だけで、添付のファイルは消さない** (コメントを消した・送った時も同じ)。送った本文の `[FILE<N>:<name>](<path>)` が添付のパスを指していて、エージェントが後から読むため。添付は `<stateDir>/sessions/` の 30 日の掃除に任せる
- **添付の置き場**: 下書きとコメントの添付は、キューに置いた (コメントは保存した) 時点で daemon が state dir の下に移す (OS の TMPDIR は OS が消しうるため。置き場は P29)。移す先の名前の `<uuid><ext>` はアップロードのファイルの名前のまま。新しい添付として受けるのは `POST /attachment` が置いたファイル (アップロードの置き場の `<uuid><ext>`) だけで、それ以外のパスは `invalid_args` で断る (任意のファイルを daemon に移させない)。移せなかった (アップロードのファイルが無い) 時は `not_found` で断り、移した分を戻す。送る時 (送信の列で順番が来た時) に添付が在るかを確かめ、無ければ送らずに `attachment_missing` を返し、下書きは `queued` のまま残す
- **添付の番号**: 添付の番号は daemon がセッションごとに 1 から順に振る `[FILE<n>]` (下書きごとに 1 から数え直さない。人が読むものなので連番にする)。コメントの添付も同じ 1 本の列で振る (コメントと FAB の下書きの `[FILE<n>]` が同じ会話の中で重ならないため)。読み戻しの時は、`file_seq` に加えて下書きとコメントが持つ番号の次より前を振らない。キューに置く時 (`prompt_queue_add`) は全ての添付に、直した時 (`prompt_queue_update`) は記録にまだ無い添付 (パスで見分ける) にだけ、セッションの続きの番号を振り、本文の `[FILE<N>]` も同じ対応で書き換える。記録に既にある添付は番号を変えない。本文にあって添付の無い `[FILE<n>]` (消した添付の残り等) の番号は飛ばして振る (振った番号のリンクが 2 つできて、送る時に両方が同じファイルに置き換わるのを防ぐ)。書き換えは 1 回の置き換えで行う (1→3 と 3→5 が続けて当たらない)。番号を振るのは sid ごとの列の中 (§11)。番号の続きは daemon のセッションごとの状態に保存する (P12)
- **op**: `prompt_queue_add { session_id, text, attachments }` → `{ ok: true, draft }`、`prompt_queue_update { session_id, id, seen_updated_at, text, attachments }` → `{ ok: true, draft }`、`prompt_queue_delete { session_id, id, seen_updated_at }` → `{ ok: true }` (記録を消す) (どれも user role、`queued` の記録だけ。`seen_updated_at` が違えば `conflict`)。送るのは `queue_send` (§11)、未確認の扱いは `unconfirmed_settle` (§9)
- FAB の下の行は左から 📎、effort、btw・後で・送る の 3 分割のボタン (2026-11-24 の裁定 2)。3 分割のボタンは 1 つの部品 (コメントのフォームと共有する `SendSplitButton`、§3) で、1 つの枠の中に 3 つの区画を同じ幅で並べ、区画の間は縦線。区画はそれぞれ `<button type="button">` で、`role="group"` (名前「送信の形」) にまとめる。区画の字は「btw」「後で」「送る」で、選択でも送信中でも変えない
  - **選択**: 3 つのうち 1 つが選ばれていて、既定は送る。選ばれている区画は送信のボタンと同じアクセントの地で、`aria-current="true"` を持つ。選ばれていない区画を押すと選択がそこへ移り、何も実行しない。選ばれている区画を押すか ⌘Enter / Ctrl+Enter で、それを実行する。選択は覚えず (P13)、開き直すと送るが選ばれている。btw と後での送信が受け付けられたら送るに戻る
  - **区画の名前** (読み上げ。見える字は変えない): 選ばれている時は実行すること (「btw で聞く」「後で 溜める」「送る」)、選ばれていない時は切り替えること (「btw に切り替える」「後で に切り替える」「送る に切り替える」)。名前は見える字で始める。`aria-pressed` を使わないのは、選ばれている区画をもう一度押しても切れず実行するので、入り切りのボタンの決まり (押すと状態が反転する) に合わないため
  - **実行できない時** (本文が空、送信中、添付の upload の途中): 選ばれている区画は押せない見た目 (`disabled`) で、押しても実行しない。選ばれていない区画への切り替えは、送信中を除いてできる。送信中はどの区画も押せない
  - **当たりの大きさ**: 区画の高さは 📎 と同じ。タッチの端末 (`pointer: coarse`) では幅と高さを 44px 以上にする。390px の幅でも 📎・effort・3 分割のボタンが 1 行に収まる
  - 後での送信はキューに置く (P13)。後での間、effort の選択は出したまま選べなくする (下書きは effort を持たない、U8)。btw の送信は FAB の下書きでなく、アンカーがタイミングの btw コメントになる (§14)。btw の送信は `comment_add` (アンカーがタイミング、`btw: true`、⏱️ の `effort`、`attachments`、`send_now`)。入力欄の placeholder はどの選択でも `⌘+Enter で送信` の 1 つで、選択では変えない (送れない理由は注記に、後での置き先は後での区画の title と閉じた FAB の件数に出る)
  - 宛先が subagent の時と下書きを直している間は btw と後での区画と effort を出さず、送るの区画だけが残る (下書きを直している間の字は「直す」)
- **直す**: 💬 のフィルタの下書きの吹き出しの「直す」は、下書きを FAB の入力欄に読み込む (別の入力欄を作らない)。入力欄に書きかけの文があれば脇に置き、直し終えるか「やめる」で戻す。直している間は 3 分割のボタンの btw と後での区画と effort を出さず、送るの区画だけが「直す」の字で残り、`prompt_queue_update` を開いた時の版で送る

### 16. 既存の DR との関係

- **[DR-0060](./DR-0060-btw-mode.md) (btw モード)**: 吸収する (§14、裁定 1)。fork の起こし方・前置き・答えの受け取り方は DR-0060 のもので、記録・保存・配り方・FAB の入口はコメントの仕組みに置く。btw の答えへの返信は、組を並べた新しい btw で聞く (fork の会話を続けない)
- **[DR-0039](./DR-0039-all-mods-and-typed-tools.md) §3 (typed tool)**: `comment_reply` は typed tool の規約 (valibot の入力、結果を文で返す、`next` を呼ばない、input schema の導き方) に従い、登録の形 (deferred、description は数語) も同じ。使い方の正本は ccmsg の skill の本文に置き、skill の description に返し方の 1 文を足す (§5、裁定 2)。description に tool のフルネームと引数まで書くのは、今の description (tool の名前と読む場面だけ) より一歩踏み込む
- **[DR-0035](./DR-0035-user-input-via-composer-fill.md)**: 送信は `prompt.send` の経路をそのまま使う。§1 の「返信方法の指示行を付けない」に揃え、コメントのブロックにも返し方の指示を付けない (§4)。コメントの送信は人が送るボタンを押した時の人の入力で、エージェントが人の入力を作る経路 (§4) ではない。ブロックにエージェントの書いた文が引用として載ることと、足されるのが引用で許可ではないことは §4
- **DR-0039 §6**: 「足されるのは文脈であって権限ではない」を、コメントのブロックの中の引用にも当てる (§4)
- **[DR-0040](./DR-0040-permit-request-tool.md) §4 / [DR-0045](./DR-0045-say-speaks-in-tool-shown-from-transcript.md) §7**: `comment_reply` の応答の表示の正本は transcript の行で、daemon の記録は本文を持たない (cid・返信先・時点・tool_use の id・本文の冒頭 `body_start` だけ)。本文を記録に持つのは transcript に無い btw の答えだけ
- **[DR-0050](./DR-0050-timeline-notification-badges.md) / [DR-0058](./DR-0058-timeline-bookmarks.md) / [DR-0022](./DR-0022-in-view-search.md)**: ツールバーに 💬 を足し、`TimelineFilter` に `comment` を足す。フィルタの入り方・解除・項目のクリックでの移動は同じ決まり。💬 のフィルタの画面は、窓の行に無い未送信のコメントと FAB の下書きを並びに加え、ヘッダにチェックボックスと「全部送信」を持つ点が他のフィルタと違う (§13)。💬 の字の重なりは U5。範囲選択のツールバーは項目の右上の「jsonl ☆」の組と項目の 💬 の印と重ねず、その下に置く (§3)
- **[DR-0025](./DR-0025-workflow-drilldown.md)**: agent の TL の項目へのコメントはこの DR では付けない (§2)
- **[DR-0015](./DR-0015-composer-attachments.md)**: キューに置いた下書きの添付を state dir の下に移し、番号をセッションごとにする (§15)。キューを通さない FAB の送信の番号は U7
- **[DR-0061](./DR-0061-no-clear-handling.md)**: `/clear` で sid が替わった時の扱いは考えない。コメントもキューも sid のもの

## 裁定 (kawaz 2026-11-22)

1. **DR-0060 の btw モード (FAB の btw のピル) をコメントの仕組みに吸収する** (§14)。FAB の btw は、アンカーがタイミングの btw コメントになる
2. **`comment_reply` で返せという指示は、ccmsg の skill の description に置く** (§5)。コメントのブロックが届いたら `mcp__ccmsg-v1__comment_reply` で返す旨を書く
3. **FAB のキューの下書きは、送信が済んだら「送信済み」の印で残さず、記録そのものを消す** (§15)。消すのは届いたのを確かめた時と「送った扱いにする」を押した時で、添付のファイルは消さない

## 裁定 (kawaz 2026-11-23)

1. **コメントのブロックは JSON の 1 行** (§4)。複数をまとめて送る時は行を改行で並べる (JSONL)。キーは `comment` / `on` / `btw_req` / `btw_res` / `before` / `select` / `after` / `body`
2. **指す先は `on` の 1 つのキーにまとめ、値の頭の語で種類を分ける** (§4): `msg_start_with:<冒頭 30 文字>` (cid を持たないメッセージ)、`comment:<cid>` (cid を持つもの)、`file:<path>[:r1[-r2]]`、`btw:<cid>`。アンカーがタイミングのコメントは `on` を持たない。誰の発言かは載せない
3. **cid を持つものへの返信は `comment:<cid>` だけ**で、返信先の冒頭の文字も `reply_to` のキーも付けない (cid が context にあるのでそれだけで通じる) (§4)
4. **btw の答えへの返信は `on:"btw:<cid>"` に、その btw の質問 (`btw_req`) と答えの全文 (`btw_res`) を付ける** (§14)。本体に渡す時も fork に渡す時も全文。付けるのは btw の答えに直接付けた返信の 1 回だけで、組は常に 1 つ
5. **ブロックは AI に宛てた形で、軸は効率と論理性**。人が素で読む時の見た目は判断に入れない (§4)
6. **コメントを付けられる対象は、エージェントの通常の応答・ccmsg・SendMessage・`comment_reply` の応答・ファイルと、cid を持つもの (送ったコメント、btw の答え)** (§2)。ユーザの発言・say・許可依頼・tool の呼び出し・thinking は対象外で、範囲選択でも付けない。範囲選択は翻訳の表示の上でも作れ、その時の `before` / `select` / `after` は翻訳後の文字
7. **送ったコメント (cid を持つもの) の吹き出しにも「返信」を出す** (§3、§12)。コメントの追記のように使い、届く形は `on:"comment:<そのコメントの cid>"`。返信できるのは本体に送ったコメントで、未送信には出さない
8. **コメントのフォームは TL の項目の並びに差し込まず、TL の上に浮かせる** (§3)。FAB の入力と同じ作りで、コメントする箇所を見たまま書ける。スマホでフォーカスした時に TL を送らず、キーボードに隠れない
9. **範囲選択のツールバーは、バブルの右の外側の余白 (項目の「jsonl ☆」の帯) の、選択範囲の縦の真ん中に置く** (§3)。スマホの OS の選択のメニューは選択範囲の上か下に出るので、同じ高さの横に置けば重ならない。バブルの右上や選択範囲の右上には置かない
10. **FAB の下の行は、チェックボックスでなく入り切りするピルのボタンにし、左から effort、btw、後で、送信のボタンの並びにする** (§15、P13)。「今すぐ送る」のチェックボックスは「後で」のピルに替え、意味の向きは逆 (入れるとキューに置く、既定は切れている)。送信のボタンの字は「送る」「後で」「btw」(下書きを直している間は「直す」)。btw と「後で」は 1 つのピルにまとめ、同時には入らず、どちらも常に押せて、入っている方をもう一度押すと両方切れる (kawaz 2026-11-23。btw・後で・送信のボタンの形は 2026-11-24 の裁定 2)
11. **💬 のフィルタの画面は、送ったものと未送信のものを同じ並びに同じ吹き出しで置く 1 本の並びにする** (§13)。未送信のものは吹き出しの緑の色味を少し変えて分け、状態を言い分ける表示・見出し・セクション・届く形の全文は出さない。ヘッダは `[x] sent` `[x] comment` `[x] btw` `[ ] resolved` のチェックボックスと「全部送信」(kawaz 2026-11-23。全部送信の対象は 2026-11-24 の裁定 1)
12. **💬 のフィルタはスレッドごとに並べ、スレッドの間に区切り線を入れる** (§13)。返信は transcript の行の位置でなく返信先の直後に続く (kawaz 2026-11-23)
13. **FAB の入力欄の placeholder は `⌘+Enter で送信` の 1 つに固定し、btw・「後で」・直している間などの状態で変えない** (§15、kawaz 2026-11-23)
14. **コメントのフォームの下の行も FAB と同じ btw と「後で」の 1 つのピルにする** (§3)。btw と「後で」は排他なので 1 つに合体し、状態は覚えない。既定はどちらも切れている (すぐ送る)。送信のボタンの字は「送る」/「後で」/「btw」で、「今すぐ送る」のチェックボックスは置かない。フォームから btw の未送信は作れない (§14) (kawaz 2026-11-23。btw・後で・送信のボタンの形は 2026-11-24 の裁定 2)
15. **FAB の通常の送るは、「後で」で溜まっている FAB の下書きも古い順に送り、その後に今の文を送る** (§11、§15。溜めたコメントも送るのは 2026-11-24 の裁定 1)。最新だけを送ることはしない (それは「後で」で溜めてから 💬 のフィルタで個別に送る)。パネルを開いている時は送信のボタンに溜まっている数を赤い数で重ねる。btw か「後で」が入っている時は数を出さず、まとめても送らない (kawaz 2026-11-23)

## 裁定 (kawaz 2026-11-24)

1. **「後で」は溜め、「送る」は溜めたものを全部送る。コメントとプロンプトを区別しない** (§3、§11、§13、§15)。FAB の「送る」でもコメントのフォームの「送る」でも、いま書いたものに加えて、溜まっている未送信のコメントと FAB の下書きを全部送る。溜めたものを書いた時刻の順に送り、いま書いたものを最後にする。💬 のフィルタの「全部送信」も同じものを送る。btw は入れない。未送信の吹き出し 1 つずつの「送る」はその 1 件だけを送る
2. **btw・後で・送る は 1 つの 3 分割のボタンにする** (§3、§15)。左から btw、後で、送る で、既定は送るが選ばれている。選ばれていない区画を押すと選択がそこへ移り (実行はしない)、選ばれている区画を押すとそれを実行する。⌘Enter は選ばれているものを実行する。タップの端末で後でにしたい時、後でを押した後に横の送信のボタンへ指を移さず、同じ所を 2 回押せばよい。FAB の入力のパネルとコメントのフォームの両方で同じ部品

## 統括の推し (主素材に無い判断、kawaz の確認待ち)

- **P2: TL の項目のうち「返信」ボタンを持つのは、エージェントの応答・`comment_reply` の応答・ccmsg の項目・subagent / teammate への指示と応答と、本体に送ったコメント (cid を持つもの) だけ** (§3)
- **P4: ツールバーの 💬 の位置は 👤 と 🔍 の間** (統括案、kawaz の異論なし)。DR-0058 §11 と同じく今の並びの位置を動かさず、数を持つバッジの並びの最後に置く (🔍 は数を持たない)
- **P6: subagent / teammate からの `comment_reply` は断る** (`permit` と同じ形、DR-0040 §9)。コメントは本体に届くもので、subagent が cid を知る経路が無い
- **P7: まとめて送る時に `not_delivered` が出たら、残り (コメントも FAB の下書きも) を送らずに未送信に残す**。順序を保ち、届かない理由 (ダイアログ中等) の間に後ろの件が先に入るのを避ける
- **P8: 項目の 💬 の印は吹き出しの外に置き、数はそのバブルをアンカー (メッセージ・選択範囲・コメント) にした人のコメント (未送信も含む、`deleted` を除く) の数** (置き場は kawaz 2026-11-24)。項目の右上の「jsonl ☆」の組 (関心の薄い道具、hover で出る) には入れず、関心の高いコメントの印として常に出す。左寄せの吹き出し (エージェントの応答等) はすぐ右の外側、右寄せの吹き出し (人の発言、送ったコメント) はすぐ左の外側に置き、上端を吹き出しの上端に揃える。吹き出しは「返信」の行を持つ本文の枠。左寄せの右の余白には「jsonl ☆」の組が居るので、組と重ならない所に置く: 右の外側に組の左端まで入らなければ組の下の段 (右の外側)、それも入らなければ (狭い幅で右の余白が無い) 吹き出しの右上の角の内側の組の下の段に重ねる。右寄せで左の余白が無ければ、吹き出しの上の外側の左端 (組と同じ段の反対の端) に置く。☆⭐ と同じく項目の高さに入れない。押した時の動き (§12) は置き場に依らない。置き方は CSS の anchor positioning で、anchor-scope を持たないブラウザでは組の中 (jsonl と ☆ の間) に置く
- **P9: Files の範囲選択のツールバーは、表示の文の領域 (ソースの行の並び、md プレビュー) の右端の内側の、選択範囲の縦の真ん中に置く** (Files には吹き出しが無く、外側の余白が無いため)。TL と同じく、スマホの OS の選択のメニューは選択範囲の上か下に出るので、同じ高さの横なら縦に重ならない。文の上に重ねるので、選んだ文字とも重ねない: 選択範囲がその列 (右端) まで届く時 (行の端まで選んだ時、スマホの狭いプレビュー) は、その列の空いている所のうち真ん中に最も近い所 (選択範囲のすぐ上か下) に置く。FAB・入力のパネル・コメントのフォームとも重ねない (TL と同じ `choiceButtonPlace`)
- **P10: 💬 のフィルタの TL の位置**: スレッドの始まりと 1 件で立つものの並び (§13 のスレッドごとの並びの土台) は TL の位置で決める。届いたコメントのバブルと `comment_reply` の応答は transcript の行の位置に、行が出る前の送ったコメントと btw のコメントと答えは送った時点の位置 (§12) に、未送信のコメントは、アンカーがメッセージ・選択範囲ならその項目の直後、コメントなら返信先の直後、タイミングなら書いた時点の位置、ファイルの箇所なら書いた時刻の位置 (`slotsByTime`) に置く。FAB の下書きは位置を持たないので、送った時点 (未送信なら書いた時点) の位置に置く。未送信のもの (未送信のコメントと FAB の下書き) は §13 のとおり並びの一番下にまとめるので、ここで決める位置は項目の DOM の置き場にだけ効く。窓の外のものは daemon の記録から時刻の位置に合流させる (DR-0058 §5 と同じく過去分は読まない)
- **P12: FAB の下書きの添付の番号の続きは `<sid>.queue.jsonl` の中に持つ** (別のファイルを持たない)。下書きの記録は消えるので記録の最大からは導けず、番号を振るたびに `{ kind: "file_seq", next }` の行を足す (読む時は最後の行が勝つ)。P34 の書き直しでもこの行は残す
- **P13: FAB の 3 分割のボタンの選択は覚えず、component の state だけに持つ**。開き直す・セッションを切り替える・読み込み直すと送るが選ばれている (すぐ送る)。キューに置けたら btw と同じく送るに戻る
- **P14: 解決のボタン (「✔️解決済み」/「✅解決済み」) の置き場は、スレッドの各バブルの内側の下端の行の右端で、「返信」のすぐ左** (kawaz 2026-11-24: 人のコメント・btw・アシスタントの返信のどれにもあってよい。置き場は「内側の 返信 の左」): 人のコメント (届いたもの。未送信のものにも出るが、解決にできないスレッドでは押せない、§6)、btw の質問と答え、`comment_reply` の応答 (窓の外の記録から描くものも)。「返信」を持たない吹き出し (未送信・送信の順番待ちのコメント、btw の質問、終わっていない btw の答え (走っている・失敗した・取り消した)) では、同じ行の右端にボタンだけを置く。行の並びは左から「↓続きへ↓」(行の真ん中、§12)、解決のボタン、「返信」(右端) で、解決のボタンと「返信」は折り返さない組にする。行が狭く組と「↓続きへ↓」を真ん中に並べられない時は、組を右端に保ち「↓続きへ↓」が左へ寄る。押して断られた時の文は組の下の段に、行の幅いっぱいで出す。吹き出しの外の足元には置かない。hover を待たず常に見せる。💬 のフィルタの中でも同じ吹き出しの同じ行で、スレッドの頭に別の置き場は持たない。どれを押してもそのスレッドに効く
- **P20: ファイルの箇所のアンカーは「選んだ文字 + 前後の少しの文字 + コメントした時点の行」で持ち、表示の時は今の内容の中から文字で探し直す**。裁定待ちの問いの md のように、エージェントが答えた問いの節を消す・直すファイルでは、行番号だけだとすぐずれるため。探す順は「前後の文字と選んだ文字の並び」→「選んだ文字だけ (1 か所だけ当たる時)」。プレビューは描画された文字の中で探す。何か所にも当たる時は元の位置 (ソースは元の行と列、プレビューは元の行以降で最初の md の塊) に近い方。見つからなければ「元の場所が無くなった」と出し、コメントと引用は残す (スレッドは読める)
- **P21: 時点の記録 (`written` / `sent`、それぞれ時刻とその時点の transcript の最後の行の uuid) をアンカーとは別の field で全ての記録に持つ**。タイミングのアンカーは自分では値を持たず、位置は送ったものは `sent`、未送信は `written` で決める。btw の答えの位置もどのアンカーでも `sent` で決まるので、アンカーの中に時点を持つと、他の種類のアンカーにも同じ値を重ねて持つことになるため
- **P24: btw の答えの走っている状態 (`status`、`model`、`effort`、`tool`、`ended_at`、`error`) は答えの記録 (`author: "btw"`) に持つ**。質問は人のコメントの記録で、答えはその返信の記録なので、DR-0060 の 1 つの記録の質問の側と答えの側を 2 つの記録に分けて持つ
- **P25: 既にある `<sid>.btw.jsonl` の記録は、daemon がそのセッションの記録を初めて読む時にコメントの記録 (質問と答えの 2 つ、cid を振る) に写し、写し終えたら `<sid>.btw.jsonl` を消す**。読める間に写さないと、FAB で聞いた btw が TL から消えるため
- **P26: md プレビューの `file` の行の範囲は、md の描画が塊の要素に持たせた元の文の行から読む** (kawaz 2026-11-23 の案)。Files の md プレビューの描画 (mdast の walker、DR-0010) は、段落・見出し・箇条書きの項目 (入れ子の項目はその項目自身の行)・表の行・引用・コードブロックの要素に、mdast の節点の `position.start.line` / `position.end.line` を `data-md-line` / `data-md-end-line` で持たせる。コードブロックはコードの始まりの行 (`data-md-code-line`。囲みのフェンスがあればその次の行) も持ち、行ごとに描かれたコードの中では 1 行の単位まで決まる。選択の始まりを含む最も内側の塊の始まりの行を `line` (r1)、終わりを含む最も内側の塊の終わりの行を `end_line` (r2、r1 と同じなら持たない) にし、ブロックは `file:<path>:r1-r2`。行の範囲は塊の粗さで、正確な箇所は `before` / `select` / `after` が持つ (インラインの節点には位置を持たせない)。コメントした時点の行で、送る時に探し直さない。表示の時の探し直しは文字で行い、行は同じ文字が何か所にもある時に元の行に近い方を取る手掛かりに使う。行を持たせるのは Files のプレビューだけで (MarkdownView の `sourceLines`)、TL の吹き出しの md には付けない (TL は使わず、属性を持てない部品 (囲みの図・コード) を包む箱が文書の頭と末尾の余白の決まり (`.md > :first-child` 等) から外れるため)
- **P27: キューを通さない FAB の送信 (`user_prompt`) も、同じ sid ごとの列に並べる**。module の `prompt.send` は 1 つずつ処理されるので、列の外から入ると、列の中の送信の 12 秒の期限を同じ理由で食う
- **P28: コメント・キュー・解決の push は `session_status_subscribe` (Files / Status / Timeline のタブの間に張られている) に載せる**。専用の subscribe を増やさず、FAB を出すタブの組と購読の張られるタブの組が同じなので、どのタブでも FAB の数が出る。transcript の無いセッション (`SessionView` が status を購読しない) ではコメントを付ける項目も無い
- **P29: 添付の置き場は `<stateDir>/sessions/<sid>.att-<uuid><ext>` の平らなファイル**。`<stateDir>/sessions/` の掃除 (30 日) がディレクトリを消さないので、ディレクトリを作らずに同じ掃除に乗せる。送った後もエージェントが読むので、送っても消さない。webui が送った本文の添付 (送ったコメントの吹き出し、届いた FAB の下書きの人の行) を画像・リンクで出せるよう、daemon はその名前の形のファイルだけを `GET /attachment/<sid>.att-<uuid><ext>` で配り、webui はパスの末尾がその形のリンクをその URL に写す (DR-0015 §2.6、§2.7。名前の形は protocol の `isKeptAttachmentName` 1 つ)
- **P30: もう一度聞く時は、質問の送った時点 (`sent`) を聞き直した時点に書き換え、新しい答えの記録 (新しい cid) を作る**。前の失敗・取り消しの答えの記録は残し、`BtwCommentBubble` は最後の答えを出して、前の試みは理由の 1 行で畳む。fork は聞き直した時点までの会話を読むので、位置もそこに移す
- **P31: 範囲のハイライトは CSS Custom Highlight で塗り (検索のハイライトと同じ仕組み、名前は `ccmsg-comment`)、範囲の後ろの 💬 は本文の DOM に差し込まず、範囲の最後の矩形の右上の角に重ねて置く** (描画された文字・検索・選択を変えない)。ハイライトは accent の色の地と下線で、地は light / dark のどちらでも、応答・送ったコメント・btw の答えの吹き出しの地の上で見て分かる濃さにする (kawaz 2026-11-24)。下線があるので、検索の原色の地と重なっても見分けが付く。重ねる層なので字を押しのけられず、続く字を隠さないよう、上付きの印の大きさで行間に置く (印の下端を行の上端に、左端を範囲の右端に揃える)。押せる当たりは見た目より広い透明の箱。💬 は吹き出しの本文の箱 (「返信」の行の親) の中に置く絶対配置の層にあり、文字を持たず aria-label だけを持つ。箱の大きさの変化と描画の変化 (翻訳の切り替え、遅れて描かれる図) で探し直して置き直す。探し直せなければ印を出さない
- **P32: コメントの「送った扱いにする」は記録を `sent` (入れた) にする**。`delivered` にはせず、行が見つかれば後から `delivered` になる。行が出るまでは記録から描く (§11)。FAB の下書きの「送った扱いにする」は裁定 3 のとおり記録を消す
- **P35: 送ったコメントと FAB の下書きが `sent` のまま、そのセッションの turn が終わって idle になった時 (送った後の最初の turn の終わり) にまだ届いたと照合できていなければ、`unconfirmed` に落とす**。turn の終わりは module の事実の `turn` が responding から idle に変わったこと (DR-0035 §3) で知る。落ちた下書きは `ev:"comments"` の drafts に入って人の目に出、そこからは今の `unconfirmed` の操作 (下書きに戻す / 送った扱い、`unconfirmed_settle`) で片付ける。時間 (タイマー) では落とさない。届いていればその turn の中で transcript の行が出ているはずで、turn が終わっても無ければ、連結や文の書き換えで照合できなかったか、届いていない。daemon が既に知っている turn の終わりを使えば、待つ時間の根拠を持たずに済む。「送った後の最初の turn」は送った後に始まった最初の turn で、turn の途中で送ったもの (その行は turn の終わりに出る) はその turn の終わりでは落とさず、次の turn の終わりで落とす。落とすのはその 1 回だけで、それより前に始まった turn の後に送ったものに限る (人が「送った扱いにする」で `sent` に戻したものは、以後の turn の終わりでは落とさない)。前の turn がいつ始まったかは daemon のメモリにだけ持ち、daemon の起動の後に最初に終わる turn は、それより前に送った全てにとって最初の turn として扱う
- **P34: `<sid>.queue.jsonl` は、daemon がそのセッションのキューを初めて読んだ時に、消えた下書き (`draft_removed` の付いたもの) の行と古い版の行を捨てて書き直す (compaction)**。今ある下書きの最新の行と最後の `file_seq` の行だけを一時ファイルに書いて rename で置き換える。読み戻しはそのセッションの最初の op より前に 1 回だけ走り、終わるまでそのセッションの op は始まらないので、書き直しの間に追記は入らない。下書きは送るたびに消えて行が溜まる一方なので、読み戻しの時に縮めないとファイルが膨らみ続ける。書き直しは読み戻しの時だけにし、追記の途中では行わない (書き込みの経路を 1 つに保つ)
- **P33: 「コメントを送った時に `comment_reply` で返すか」を測る項目に足し、実装の段階 2 の終わりに測る** (「測ること」3)。裁定 2 は model が skill の description に従う前提に立ち、外れると返信がスレッドに結ばれない (§5 の弱点) ので、前提を観測で確かめる。段階 2 に置くのは、測るのに `comment_reply` と skill の文が要り、先に測るには使い捨ての plugin を別に作ることになるため。段階 1 は返信が本文でも使えるので、段階 2 の結果を待たずに進められる

## 未決 (kawaz の判断を待つ)

- **U3: Files のコメントの位置がファイルの変更でずれた時の扱い**。統括の推しは P20。段階 3 は推しのとおり仮に P20 で入れた
- **U5: 💬 の字が DR-0022 の検索対象のトグル 💬 (ccmsg 経由のメッセージ) と重なる**。🔍 のフィルタの画面とツールバーで同じ字が別の意味になる。どちらかの字を変えるか、そのままにするか
- **U7: キューを通さない FAB の送信の添付の番号**。§15 はキューの下書きだけをセッションの番号にする。直送の下書きが今のまま下書きごとに 1 から数えると、キューの下書きと同じ番号の `[FILE<n>]` が同じ会話に並ぶ。直送もセッションの番号にするか。段階 4 は統括の推しで仮に「直送は今のまま (下書きごとに 1 から)」で入れた
- **U8: キューに置いた FAB の下書きの effort**。今の FAB の ⏱️ / 📌🏛️ の選択 ([DR-0041](./DR-0041-request-model-effort-override.md) §6.3) を下書きに持たせるか。統括の推しは「持たせない」(送る時点のセッションの通しで走る。キューは送る時機をずらすもので、選んだ時と送る時で通しが変わりうるため)。段階 4 は推しのとおり仮に「持たせない」で入れた
- **U11: エージェントが解決にできるか** (`comment_reply` に解決の印を付けられるようにするか)。統括の推しは「しない」(解決は読んだ人が決める)
- **U12: 解決済みのスレッドの TL の上の 💬 と選択範囲のハイライト**。統括の推しは「出したまま薄くする」

## 測ること

1 と 2 は受理の前に測った ([findings 2026-11-22-dr62-btw-cache-and-prompt-concat](../findings/2026-11-22-dr62-btw-cache-and-prompt-concat.md))。3 は実装の段階 2 の終わりに測り、§5 に反映した (P33)。4 は module の試験で確かめ、実物の fork では測っていない。5 は実環境で観測した (範囲は項目 5 に書いた)。

1. **対話のセッションからの btw の fork で cache が当たるか** (測った): 別プロセスの fork (`claude -p --resume --fork-session`) では、fork に ccmsg の tool が無いことは cache を切らなかった (tool の読み込みの前後とも)。module が起こす fork の subagent は本体が最後に送った request の prefix を全部読む ([findings 2026-11-23-btw-via-agent-fork](../findings/2026-11-23-btw-via-agent-fork.md) §2、DR-0060 Context)。長い Opus のセッションでの cache は daemon.log の `comment_btw_end` の token 数と `comment_btw_cache_miss` の warn で見る (DR-0060 §4)
2. **turn の実行中に続けて送ったプロンプトが連結されて届くか** (測った): 連結されず 1 件 1 行で、行の形は 3 通り。model には同じ turn に並んで届く。§11・§13・§15 に反映した
3. **対話のセッションでコメントを送った時に `comment_reply` で返すか** (測った、[findings 2026-11-22-dr62-comment-reply-measure](../findings/2026-11-22-dr62-comment-reply-measure.md)): ccmsg の tool が未ロードのセッション (opus) で、コメント 1 つ・3 つを 1 つのプロンプト (エージェントの返信への返信を含む)・compact の後の 1 つの全部に、コメントごとに `comment_reply` を 1 回ずつ呼んだ。skill の本文は読まれず、description の 1 文だけで呼んだ。compact の後も skill の一覧にその 1 文が載っていた。呼んだ後に毎回、同じ内容の要約を応答の本文にも書いたので、description の 1 文に「同じ内容を応答の本文に書き直さない」を足した (§5)
4. **btw の fork が `comment_reply` を呼んだ時に何が起きるか**: fork は本体の tool を継ぐので呼べる。module が btw の fork の agentId からの呼び出しを daemon に送らずに断り、答えを本文に書く旨の文を返す (§5)。断ること・daemon に何も送らないことは module の試験で確かめた。実物の fork がどれくらい呼ぶか、断られた後に本文で答えるかは測っていない
5. **ブロックが JSON の 1 行 (§4) の時に、3 と同じく `comment_reply` で返すか**。3 を測った時のブロックは XML 調のタグと属性の形で、skill の description の 1 文の合図もそれに合わせていた。今の形のブロックと description の 1 文で、3 と同じ組 (コメント 1 つ、3 つを 1 つのプロンプト、compact の後) を測り直す (実環境で観測した、[findings 2026-11-23-dr62-comment-json-in-real-use](../findings/2026-11-23-dr62-comment-json-in-real-use.md)): 仕様を context に持つ統括のセッションで、3 件まとめたメッセージ全体へのコメントと、エージェントの返信への返信が、1 件 1 行の JSON で届き (改行を含む本文も 1 行)、4 件の全部に `comment_reply` が 1 回ずつ呼ばれて返信の吹き出しとして描かれた。何も知らないセッションでの測定と、範囲選択・`file:`・送ったコメントへの返信・compact の後・長い本文・tool の実行中に送った場合の組み合わせは、測っていない

## 実装の段階分け

1. **コメントの保存と送信と 💬 のフィルタ**: `CommentRecordSchema` / `ThreadStateSchema` (アンカーはメッセージとコメント)、`<sid>.comments.jsonl`、sid ごとの列、`comment_add` / `comment_update` / `comment_delete` / `comment_resolve` / `queue_send` (コメントだけ)、届いたの確定、`ev:"comments"` / `ev:"comment"` / `ev:"comment_thread"` (`session_status_subscribe` に載せる)、`commentBlockText` / `parseCommentBlocks`、バブルの「返信」ボタン、`CommentForm` と送る・溜めるの選び方、`CommentBubble` (記録からの描画を含む)、項目の 💬 の印、ツールバーの 💬、`?filter=comment` の並びとヘッダ (§13)
2. **`comment_reply`**: tool の登録 (deferred)、ccmsg の skill の description の 1 文と本文の節、op `comment_reply`、`commentReplyRecorded`、`CommentReplyBubble`、返信の返信。終わりに「測ること」3 を測る
3. **範囲選択とハイライト**: `SelectionToolbar`、アンカーの選択範囲・ファイルの箇所・コメントの中の引用、文字での探し直し、ハイライトと範囲の後ろの 💬、`select` の上限、Files のソースと md プレビューのコメント (アンカーがファイルの箇所、`file:` の行の範囲の検査)。済み (U3 は P20 で仮に入れた)
4. **FAB のキュー**: `PromptDraftRecordSchema`、`<sid>.queue.jsonl` と読み戻しの時の書き直し、`prompt_queue_*`、`queue_send` / `unconfirmed_settle` の下書き、添付の移し替えと番号の振り直し、届いたの確定と turn の終わりの未確認、FAB の「後で」のピルと数、💬 のフィルタの下書きの吹き出し (1 件ずつの送信・直す・消す・未確認の操作) と全部送信、直す時の FAB の入力欄への読み込み
5. **btw のフラグと btw モードの吸収**: §14 (コメントの btw ともう一度聞く、FAB の btw の付け替え、既存の記録の写し)

各段階はその前の段階だけに依る。1 だけでも、バブル全体へのコメントを溜めて送る機能として使える。

## 実装の時に確かめること

- `tool.call` の handler で呼び出しの tool_use の id が取れるか (§5 の二重の記録を防ぐのに使う)。取れなければ、daemon が module の push した `comment_reply` の行の tool_use の id と入力で記録を結ぶ形に替える

## Alternatives Considered

| 案 | 採らない理由 |
|---|---|
| コメントの対象を uuid で渡す | エージェントは uuid も時刻も知覚できない。人が読むのと同じ手掛かり (冒頭の文字と選んだ文字) なら、compact の後も文だけで指す所が分かる |
| コメントを XML 調のタグ (`<comment cid="…">`) と属性で渡す | 属性の値と入れ子の本文にエスケープの規則が要り、読み取りが正規表現になる。JSON の 1 行なら書きと読みが `JSON.stringify` / `JSON.parse` とスキーマで済み、1 件が常に 1 行に収まる (裁定 2026-11-23) |
| ブロックに誰の発言か・項目の種類 (応答・ユーザの発言・tool の呼び出し等) を載せる | 指す先の見つけ方 (冒頭の文字・cid・ファイル・btw) が分かれば足り、項目の種類を言い分ける必要が無い (裁定 2026-11-23) |
| 指す先を種類ごとに別のキー (`msg_start_with` / `file` / `reply_to`) で持つ | 指す先は常に 1 つで、別のキーにするとキーの組み合わせ (2 つ持つ・どれも持たない) を別に検査することになる。`on` の 1 つにまとめ、値の頭の語で種類を分ける (裁定 2026-11-23) |
| cid を持つものへの返信に、返信先の冒頭の文字も付ける | cid が context に入っているのでそれだけで通じる (裁定 2026-11-23) |
| btw の答えへの返信で、btw の問答の段を辿って全部渡す | btw は質問 1 つに答え 1 つで、返信は直接付けたものの 1 組で足りる。以降は cid で辿れる (裁定 2026-11-23) |
| メッセージを指す文と選択範囲を 1 つの欄 (引用) で兼ねる | メッセージの中の範囲選択で、どのメッセージかとどの部分かを両方言えない。`on` と `before` / `select` / `after` を独立に持つ (裁定 2026-11-23) |
| daemon が「このセッションに返信の指示を付けたか」を覚え、初回のコメントにだけ指示を付ける | compact で指示が消え、daemon の印とエージェントの context が食い違う。覚える状態も増える |
| `comment_reply` だけ deferred にせず登録し、tool の説明文に返し方を書く | 説明文と input schema が毎 request (subagent の request も) の context に載る。(裁定 2) |
| コメントのブロックに返し方の一言を毎回付ける | DR-0035 §1 (返信方法の指示行を付けない) と当たる。指示は daemon の版で届き tool は module の版なので、tool を持たないセッションにも指示が届き、btw の fork にも届く。未ロードの tool を呼ばせるにはフルネームと引数が要り、ブロックが長くなる (裁定 2) |
| DR-0039 §5 の案内 (compact の後に足し直される) に返し方を 1 行足す | 案内は skill への誘導に留める規約 (DR-0039 §5) から外れる (裁定 2) |
| btw のフラグの付いたコメントをまとめて 1 つの btw で聞く | btw 同士の文脈が混ざる |
| FAB の下書きをまとめて送る時に空行で連結して 1 つのプロンプトにする | 短いプロンプトが連結されて別の意味になる。1 件ずつ送れば transcript の人の行と 1 対 1 で照合でき、model には同じ turn に並んで届く |
| コメントを webui の localStorage に溜める | 別のデバイスで見えず、送る前のコメントを他のデバイスから送れない |
| 保存を全セッション 1 ファイル (`bookmarks.json` と同じ形) にする | コメントは本文を持ち、1 件ごとに全セッション分を書き直すことになる (§8 の Design rationale) |
| 返信を `send` (ccmsg の別セッション宛ての送信) や普通の応答の本文で返させる | どのコメントへの返信かが構造で分からず、webui でコメントと結べない。返信にも cid を振れない |
| btw の中の `comment_reply` を settings の `permissions.deny` で止める | fork は本体の権限を継ぐので、本体の側でも止まる。module が btw の fork からの呼び出しだけを断る (§5) |
| cid をセッションごとの連番にする | ファイルが掃除で消えた後に振り直した番号が、会話に残る古い cid と重なる |
| エージェントの返信の本文も daemon の記録に持つ | transcript の行と二重の正本になる (DR-0040 §4 の「中身を貯めない」) |
| コメントの push を `transcript_subscribe` に載せる | TL を表示していない間 (Files / Status) に届かず、FAB の数も出ない |
| 返信のアンカーをタイミングにし、返信先は別の field で持つ | 返信の中の範囲選択 (返信先のバブルの中の引用) を表せない。アンカーの種類にコメントを足せば、結び付く先が 1 つの field で済む |
| FAB の btw を DR-0060 の btw のまま残し、コメントの btw と並べる | btw の入口・記録・保存・push が 2 組になり、FAB で聞いた btw には返信 (スレッド) が付けられない (裁定 1) |
| TL の位置 (タイミング) と指す先 (メッセージ・引用・ファイル) を 2 つの概念に分ける | 全てのコメントが 1 つの結び付く先を持つ形の方が、記録と表示の分け方が 1 つの表で済む (kawaz 2026-11-22: タイミングもアンカーの 1 つの種類) |
| 選択範囲・ファイルの箇所を位置 (描画された文字の中の位置、行番号) だけで持つ | 翻訳・描画の変更・ファイルの書き換えですぐずれる (§2、P20) |

## Consequences

- protocol: `CommentRecordSchema` (アンカーの 5 つの種類、時点の記録、届いたの確定、btw の答えの状態)、`ThreadStateSchema`、`PromptDraftRecordSchema`、op `comment_add` / `comment_update` / `comment_delete` / `comment_resolve` / `comment_btw_cancel` / `comment_btw_retry` / `queue_send` / `prompt_queue_add` / `prompt_queue_update` / `prompt_queue_delete` / `unconfirmed_settle` / `comment_reply`、ErrorCode `conflict` / `state_not_writable`、`ev:"comments"` / `ev:"comment"` / `ev:"comment_thread"` / `ev:"prompt_draft"` / `ev:"prompt_draft_removed"`、`<sid>.queue.jsonl` の行の種類 (`draft` / `draft_removed` / `file_seq`)、`CommentBlockSchema` / `commentBlockText` / `parseCommentBlocks` / `commentReplyRecorded`、`TimelineFilter` の `comment`
- module: tool `comment_reply` の登録 (deferred) と handler。tool の一覧が変わるので、走っているセッションには再起動まで届かない (DR-0039 Consequences の hot reload と同じ)。その間に届いたコメントには、skill の「tool が無ければ本文で返す」で本文の返信になる
- skill: ccmsg の skill の description に返し方の 1 文を足し、本文にコメントのブロックの読み方と `comment_reply` の使い方の節を足す
- daemon: `<stateDir>/sessions/<sid>.comments.jsonl` と `<sid>.queue.jsonl` と添付のファイル、sid ごとの列、送信の組み立てと `userPrompt` での送信、push された人の行での届いたの確定、コメントの btw の fork の頼み方 (DR-0060)、返信の記録、解決の状態、`<sid>.btw.jsonl` の写しと削除
- webui: `SelectionToolbar`、`CommentForm`、バブルの「返信」ボタン、`CommentBubble`、`CommentReplyBubble`、コメントの記録で描く `BtwCommentBubble`、項目の 💬 の印、範囲のハイライトと探し直し、Files の箇所のハイライトと探し直し、ツールバーの 💬、💬 のフィルタの並びとヘッダ (チェックボックスと全部送信)、解決の印、未確認の操作、FAB のキューとその数、FAB の btw の付け替え
- 未送信のコメントとキューの下書きと添付は、最後の書き込みから 30 日で消える (§8)
- daemon に溜めるのは人が置いたもので、届かなかった直送を daemon が預かる形 ([DR-0036](./DR-0036-retire-rooms-for-p2p.md) §3) ではない
- 「持たない」ことを壊す変更を止める試験の観点:
  - user role 以外のコメントの op は断り、何も保存しない
  - コメントの送信は `prompt.send` 以外の経路でセッションに入らない
  - 同じセッションへの送信は 1 本の列で順に走り、`draft` / `queued` でない項目と見ていた版の違う項目は送らずに項目ごとに断る
  - まとめて送ったコメントは 1 つのプロンプトにブロックの行を改行で並べて (JSONL) 入り、FAB の下書きは 1 件ずつ別のプロンプトで入る。`queue_send` は渡された順に送り、続いて並ぶコメントだけを 1 つのプロンプトにする。どのプロンプトでも入らなければ後ろの項目は送らずに未送信に戻る
  - `parseCommentBlocks(commentBlockText(x))` が `x` に戻る (本文や選んだ文字に改行・`"`・`\`・`</comment>`・JSON に見える文字列を含むものも)。1 つのブロックは改行を含まない
  - コメントでない JSON の行 (キーが足りない・多い、cid の形でない、`on` の種類が無い・知らない、`btw:` の `on` と `btw_req` / `btw_res` が揃わない) と壊れた JSON の行はコメントとして読まない。人の行の本文にコメントでない行が混ざれば、その行はコメントのバブルで描かない
  - 範囲選択の無いコメントのブロックは `before` / `select` / `after` を持たない。アンカーがタイミングのコメントのブロックは `comment` と `body` だけ。cid を持つものへの返信のブロックは `on` = `comment:<cid>` で、返信先の冒頭の文字を持たない。btw の答えへの返信のブロックは btw の質問と答えの全文を持つ
  - コメントのブロックとそれを並べたプロンプトに、返し方の指示行が入らない
  - 送ったコメントは、push された人の行の本文がブロックの行だけでできていて、送ったのと全部のキーで同じブロックが見えたら `delivered` になり (cid が同じで本文や `on` の違う行、ブロックの行に普通の文が混ざった行では `delivered` にならない)、行が出るまでは記録から描かれる (💬 のフィルタからも TL からも消えない)
  - btw のフラグの付いたコメントは本体のプロンプトに入らず、1 件ずつ btw になり、どれもすぐ fork を頼む (空きを待たない)。FAB の btw も同じ記録 (アンカーがタイミングの btw コメント) になり、添付を保つ
  - エージェントに送る文に uuid・時刻・描画の位置が入らない。`select` は 2000 文字を超えない
  - `comment_reply` は本体に届いていない cid (未送信・btw・削除) を断り、記録した返信に新しい cid を振ってその cid と返信先の引用を結果の文で返す。同じ tool_use の id では 2 つ目の記録を作らない
  - `send_now` の無いコメントは `comment_add` ではどのセッションにも何も送らない
  - 未送信を持つスレッドと、見ていた後に記録が足されたスレッドは解決にできない。解決の付け外しはエージェントに何も送らない。💬 のフィルタは既定で解決済みのスレッドを出さない
  - 💬 のフィルタは未送信のコメントと FAB の下書きを、送ったものと同じ並びに同じ吹き出しで出し、未送信の印を付ける。並びはスレッドごとで、返信 (返信の返信を含む) は返信先の直後に続き、未送信のもの (スレッドへの未送信の返信を含む) は時刻やスレッドに関係なく一番下に書いた時刻の順でまとまり、スレッドの間と未送信のかたまりの手前にだけ線が立ち、隠れたスレッドの線は残らない。フィルタの無い TL は transcript の順のまま。ヘッダのチェックボックスの既定は `sent` / `comment` / `btw` が入り `resolved` が切れていて、`sent` を外すと未送信だけが、`comment` / `btw` を外すとその種類が隠れ、FAB の下書きはその 2 つに依らない。「全部送信」・FAB の「送る」・コメントのフォームの「送る」は、溜めた未送信のコメントと FAB の下書きの全部を書いた時刻の順に送り (隠れている未送信も送る)、フォームと FAB ではいま書いたものを最後にする。送るものが無ければ「全部送信」は押せない
  - Files / Status / Timeline のどのタブを見ていても `ev:"comment"` が届き、別の接続 (別のデバイス) にも届く。購読の始まりに `ev:"comments"` で保存された記録が届く
  - 選択範囲・ファイルの箇所のアンカーは、位置がずれても選んだ文字で同じ箇所に出る。選んだ文字が消えたら「元の場所が無くなった」になり、コメントは残る。同じ文字が何か所にもある時は前後の文字で、前後も同じなら元の行に近い方に出る
  - Files のソースで選んだ時のアンカーは、cwd の中なら cwd からの相対・外なら絶対のパス、`source`、選んだ文字と前後の文字、始まりの行と列、終わりの行 (同じ行なら持たない)、始まりの行の文。md プレビューで選んだ時は `preview` で、行は選択の始まりと終わりを含む最も内側の md の塊の元の行 (入れ子の項目はその項目自身、表は行、行ごとに描かれたコードはその 1 行)、列は持たない。TL の吹き出しの md は元の行を持たない。行番号だけの選択と編集のモードではボタンを出さない
  - `file:` の値の末尾の行は 1 から数え、r1 <= r2 (`file:a.md:0`、`file:a.md:5-3` はコメントのブロックとして読まない)。`comment_add` はファイルの箇所のアンカーを受けて保存する
  - daemon は `sessions/` のうち `<sid>.att-<uuid><ext>` の形の名前のファイルだけを配り、`sessions/` の他のファイル・形に合わない名前・外を指す名前は配らない。webui はその形の添付のパスを配る URL に写し、送ったコメントと届いた FAB の下書きの添付の画像を出す
  - キューの下書きの `[FILE<n>]` はセッションの中で重ならず、直した時に既にある添付の番号は変わらない。下書きの記録が消えて書き直された後も番号は戻らない。添付が無くなった下書きは送らずに残る
  - 送ったコメントと下書きが照合できないまま送った後の最初の turn が終わったら `unconfirmed` に落ち、下書きは ev の drafts に出る
  - 送った下書きは、届いた人の行を見るまで `sent` / `unconfirmed` で残り、見たら記録が消える。添付のファイルは記録が消えても残る。`ev:"comments"` の drafts に `sent` の下書きは入らない
  - btw の記録の写しは、途中で止まって読み直しても二重にならない

## 関連

- [DR-0060](./DR-0060-btw-mode.md) — btw の fork の起こし方・前置き・答えの受け取り方
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
