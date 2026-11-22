# 対話のセッションで `<comment>` を送った時に `comment_reply` で返すか (実測)

- Date: 2026-11-22
- 対象: Claude Code 2.1.330、ccmsg の plugin は DR-0062 段階 2 の作業コピー (`comment_reply` の tool と ccmsg の skill の description の 1 文を入れたもの)、model は opus (`opus[1m]`、effort は既定の medium)
- 動機: [DR-0062](../decisions/DR-0062-comments.md) の「測ること」3 (P33)。裁定 2 は「`comment_reply` で返せという指示を ccmsg の skill の description に置く」で、model が description に従う前提に立つ。外れると返信がコメントのスレッドに結ばれない (§5 の弱点)
- 方法:
  - 隔離 daemon: 作業コピーの `packages/daemon/src/index.ts --foreground`、`CCMSG_STATE_DIR` / `CCMSG_CONFIG_DIR` / `CCMSG_DATA_DIR` / `HOME` / `TMPDIR` を一時ディレクトリに。`CCMSG_CLAUDE_CONFIG_DIRS` は付けない
  - 試験用セッション `🤖ccmsg-verify-comment-reply`: 実 config dir (model の応答が要るため)、cwd は `scripts/verify-cwd.ts acquire` の信頼済みの空ディレクトリ、継承の `CLAUDE_CODE_*` と `HYOUI_SESSION_ID` を外し、`hyoui run --detached` の中で `claude --plugin-dir <作業コピー> --settings '{"enabledPlugins":{"ccmsg-v1@ccmsg-v1":false}}' --model opus`。ccmsg の tool は deferred で、セッションの中で ToolSearch するまで読み込まれていない
  - 人の入力: 隔離 daemon に user role で繋ぐ使い捨てのスクリプトから、webui と同じ op を送った。最初の応答は `user_prompt`、コメントは `comment_add` (今すぐ送る) と `queue_send` (daemon が `commentBlockText` でブロックを作り composer に fill する、DR-0062 §11)。compact は端末に `/compact` を打った
  - 数えたもの: transcript の `comment_reply` の tool_use の数と cid、daemon.log の `comment_reply:` の行、`<sid>.comments.jsonl` の記録、compact の後の `skill_listing` の添付

## 判明した事実

### 1. コメントごとに `comment_reply` を 1 回ずつ呼んだ

| # | 送ったもの | `comment_reply` の呼び出し | ToolSearch |
|---|---|---|---|
| a | 応答へのコメント 1 つ (今すぐ送る) | 1 回 (返信先 = そのコメントの cid) | 呼ぶ前に 1 回 (`select:mcp__ccmsg-v1__comment_reply`) |
| b | 1 つのプロンプトに 3 ブロック: 応答へのコメント 2 つと、(a) のエージェントの返信 (`reply_to` 付き、`on="エージェントの返信"`) への返信 1 つ | 3 回、ブロックの順に、それぞれのブロックの cid に | 無し (a で読み込み済み) |
| c | `/compact` の後に、応答へのコメント 1 つ (今すぐ送る) | 1 回 | 呼ぶ前に 1 回 (compact で読み込みが外れた) |

- 5 つのコメントの全部が、エージェントの返信の記録 (`author: "agent"`、新しい cid、tool_use の id) になり、送ったコメントは全部 `delivered` になった。本文で返しただけのコメントは無い
- 返信への返信 (b の 3 つ目) も、そのブロックの cid に `comment_reply` で返した
- `comment_reply` の結果の文 (新しい cid を含む) は 5 回とも「記録した」で、断られた呼び出しは無い
- skill の本文 (`skills/ccmsg/SKILL.md`) は 1 度も読まれなかった (Read / Skill の呼び出しが無い)。description の 1 文だけで tool のフルネームと引数を書いて呼んだ
- tool のフルネームを description に書いても、model は名前で直接呼ばずに先に ToolSearch で読み込んだ (a と c)。DR-0062 §5 の「ToolSearch なしに名前で呼ばせる」ねらいは、この 2 回では当たっていない。読み込みの 1 往復が増えるだけで、返信は結ばれた

### 2. `comment_reply` の後に、同じ内容を本文にもう一度書いた

- a・b・c の 3 つの turn の全部で、`comment_reply` の呼び出しの後に、返信の中身を短くまとめた応答の本文 (「コメントのスレッドに返信しました。」に続けて各返信の要約) を書いた。webui では、返信の吹き出し (CommentReplyBubble) の後に、同じ話の応答の吹き出しがもう 1 つ並ぶ
- skill の本文にも description にも、本文に書き直すかどうかの決まりは無い (DR-0062 に無いので入れていない)

### 3. compact の後も skill の一覧に返し方の 1 文が載る

- `/compact` の直後の添付 `skill_listing` に、ccmsg の skill の description が返し方の 1 文 (`<comment cid="…"> が届いたら、コメントごとに mcp__ccmsg-v1__comment_reply { cid, body } で返す (この tool が無ければ本文で返す)。`) ごと載っていた
- compact の要約にも「コメントには mcp__ccmsg-v1__comment_reply { cid, body } で返信する運用」と書かれていた。c の結果は、description と要約の両方が効いた状態のもので、どちらが効いたかはこの 1 回では分けられない

### 4. 試験の手順で踏んだこと

- 試験用セッションに `HYOUI_SESSION_ID` が継承されていると、composer への fill の後の Enter (`hyoui input <id> key:Enter`) が、継承元の端末に送られる。tmux の中に立てた最初の試行で起き、試験用セッション側の結果は `not_submitted` になった。`hyoui run --detached` の中で、継承の `HYOUI_SESSION_ID` を外して立て直したら `accepted` になった (verify skill の手順に反映済み)

## 未検証

- opus 以外の model (sonnet / haiku / fable) での振る舞い
- 1 回の compact だけで、description と compact の要約のどちらが効いたかの切り分け
- 「この tool が無ければ本文で返す」の側 (tool を持たないセッション、btw の fork)
