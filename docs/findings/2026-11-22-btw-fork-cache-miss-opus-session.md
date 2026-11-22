# btw の fork が長い Opus のセッションの prompt cache を読めなかった原因 (実測)

- Date: 2026-11-22
- 対象: Claude Code 2.1.330、ccmsg 0.323.0 (DR-0064 の後、btw の fork はユーザの起動コマンドの print の起動)、llm-gateway (unstable、ns personal)
- 動機: v0.323.0 の後、Opus 5.5 のセッション S (1M context、起動は `--model opus --effort high`、途中で webui の通しの上書きで effort を medium に pin) で btw を 3 回使った。3 回とも fork が system と tools の分 (15,396) しか cache を読まず、会話の分 (51〜53 万) を書き直した。effort・起動の引数・model の綴りのどれが効いているかを切り分けた
- 方法:
  - S の transcript の `api-request` / `api-request-blob` / `api-request-shape` の行と assistant の行の `usage`、daemon.log、llm-gateway の log と thinking の出所の記録を読んだ。S には何も送っていない
  - **fork の request を upstream に出さずに記録した**: `--settings` で `env.ANTHROPIC_BASE_URL` を 127.0.0.1 の記録用サーバに向け、request の本文と beta のヘッダだけを保存して 400 を返した (user settings の `env` が base URL を決めているので、process の環境変数では向け先が変わらない)。`--no-session-persistence` で transcript は書かない。記録した本文は突き合わせの後に消した
  - `api-request-blob` の行は、本体が送った message のうち、transcript の行から組み立てた形と違うもの (in-memory でしか持たない形) の正確な中身。fork の request の message と blob を 1 件ずつ突き合わせた (`cache_control` を除き、文字列の content は text block 1 つとみなした)
  - 使い捨てのセッション (リポの外の一時ディレクトリを cwd、`--name "🤖ccmsg-verify-btw-cache"`、haiku) で、effort と model の綴りの効き方を、記録と実際の送信の両方で測った
  - 下の「total」は `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`

## 判明した事実

### 1. 原因: fork が transcript から組み立てた履歴が、本体の送った履歴と途中から違う

S の fork (btw と同じ引数、kawaz の起動コマンド経由) の request は 803 message。本体の blob 251 件のうち 246 件は fork の message と一字一句一致し、違ったのは次の 5 件。

| fork の message の位置 | 何が違うか | 本体 | fork |
|---|---|---|---|
| 1 (SessionStart の hook の system message) | `output_config` の有無 | 無し | `{"effort":"medium"}` (fork の per-turn effort の印、§3) |
| **173** (assistant、ccmsg の permit tool の tool_use) | tool_use の `input` の形 | model が出したまま (配列の field が **JSON の文字列**) | 配列に直した形 |
| 297 (同上、2 回目の permit) | 同上 | 同上 | 同上 |
| 583 (user、turn の最中に届いた人の入力) | text block の数と末尾 | 3 block | 4 block (後から届いた入力が同じ message に入り、前の block の末尾に `\n` が付く) |
| 785 (user、ToolSearch の結果) | block の数 | 1 block | 2 block (`Tool loaded.` の text が足される) |

- transcript の assistant の行は、tool_use の `input` を直した形で持ち、model が出したままの形を別の欄 `wireToolInputs` に持っている。本体は後者を送り続け、fork (`--resume`) は前者で組み立てた。173 の tool_use は、model が tool の schema を読み込まずに permit を呼び、配列の field を文字列で渡した回 (直前の thinking に「ToolSearch で schema を読むか迷う」とある)
- **最初の実質的な違いは 173 番目** (1 番目の印の扱いは §3)。fork の cache の区切りは末尾の近くにしかなく、173 番目は末尾から 600 以上前なので、lookback (20 block) では本体の書いた entry に届かず、read は system の区切りまで (15,396) になる
- これは effort に依らない。kawaz の 3 回の btw (12:51 medium、12:59 medium、13:00 high) は 3 回とも read 15,396 で、この説明と合う。high の回は、本体が 12:48 より前に書いた high の cache が 1h でまだ残っていたはずの時刻だった

### 2. 起動の引数は効いていない

S の fork を、引数の組を変えて記録した。どれも基本の形は `-p --resume S --fork-session --no-session-persistence --output-format stream-json --verbose --include-partial-messages --permission-prompts none --model claude-opus-5-5[1m] --effort medium`。

| # | 足した引数 | system | tools | beta | messages (fork 自身が末尾に足す 1 件を除く 802 件) | 他 |
|---|---|---|---|---|---|---|
| 1 | なし | 基準 | 基準 | 基準 | 基準 | |
| 2 | `--session-id <新>` | 同じ | 同じ | 同じ | 同じ (末尾の 1 件も同じ) | |
| 3 | `--allow-dangerously-skip-permissions --permission-mode auto` | 同じ | 同じ | 同じ | 同じ (末尾の 1 件も同じ) | |
| 4 | `--add-dir <本体の一時置き場>` | 同じ | 同じ | 同じ | 同じ | 末尾の 1 件から「Additional working directories removed」が消える。top-level の `safeguards` (server の classifier の文脈) が違う |
| 5 | kawaz の起動コマンド (print の入力) | 同じ | 同じ | 同じ | 同じ | 4 と同じ |

- 作業ディレクトリの一覧は、会話の 2 番目の message (SessionStart の hook の system message) の中の環境の節にある。fork でも本体と同じ文で、重複も順序の違いも無い。`--add-dir` の有無で変わるのは、fork が末尾に足す 1 件だけ
- `--permission-mode auto` は user settings の既定でもあり、1 の `safeguards` にも `permission_mode: auto` が入っていた
- tools と system は、S の最新の `api-request-shape` (13:13、TaskStop が足された後) と一致した

### 3. model の綴りと effort の運び方

kawaz の環境には `ANTHROPIC_DEFAULT_OPUS_MODEL=opus[1m]` (sonnet / fable も `[1m]`) が入っていて、`--model opus` は Claude Code にとって**認識されない model** (`opus[1m]`) になる。

| `--model` | request の `model` | per-turn-control-2026-07-01 | context-1m-2025-08-07 | `max_tokens` | `unrecognized_model` | fork の履歴の thinking |
|---|---|---|---|---|---|---|
| `claude-opus-5-5[1m]` (btw が渡す) | `claude-opus-5-5` | あり | なし | 128000 | 出ない | 残る |
| `opus` / `opus[1m]` (本体と同じ) | `opus` | なし | あり | 32000 | 出る | **全部落ちる** |
| `claude-haiku-5-5` | `claude-haiku-5-5` | あり | なし | 128000 | 出ない | 残る |

- S の `api-request` の行も `model: "opus"`、per-turn-control 無し、`max_tokens: 32000`。transcript の `perTurnEffort` は全部 null
- per-turn-control が付く fork は、履歴の最初の role:system の message に `output_config: {effort}` の印を載せる。値は transcript の `perTurnEffort` があればその値、null なら fork 自身の effort。effort を変えた時は、末尾に effort だけの system message を足す
- 本体と同じ綴り (`opus`) で fork すると、履歴の thinking が全部落ちる (記録で 0 件)。前回の A-a (`sonnet[1m]` で外れた件) と同じで、DR-0060 §2 が正式な id を渡す理由になっている

### 4. effort の変更と cache (「同じ model なら effort が違っても効く」か)

| 形 | 観測 | 結果 |
|---|---|---|
| per-turn なし (S 本体、opus) | 12:48:34、通しの上書きで top-level の effort が high → medium | **read 15,396 / create 541,931** (会話の分を全部書き直し) |
| per-turn あり (使い捨て、haiku) | 本体が high の履歴を `--effort medium` で fork (先頭の印は high のまま、末尾に medium の印) | 全部読んだ (83,888 / 0) |
| per-turn あり (使い捨て、haiku) | 先頭の印の値を medium に変えた fork | read 55,997 / create 27,891 (会話の分が外れた) |
| per-turn の有無が違う (前回の A-m、sonnet) | 本体 `sonnet[1m]` (per-turn なし、low)、fork `claude-sonnet-5-5` (per-turn、先頭の印 low) | ほぼ全部読んだ (84,958 / 84,960) |

- **kawaz の認識は、per-turn effort が効く時 (Claude Code が認識する model の id で走る時) だけ正しい**。この時は effort の変更が末尾の印になり、前方一致が保たれる。認識されない別名で走るセッション (S) は top-level の effort で運ぶので、変えると会話の分が外れる
- 印の値と本体の top-level の effort が同じなら、per-turn の有無が違っても当たった (sonnet で 1 件)。S の fork の 1 番目の印 (medium) は本体の effort (medium) と同じなので、外れの原因は §1 の 173 番目と読む (Opus での確認はしていない)

### 5. 一次資料

- prompt caching (`platform.claude.com/docs/en/build-with-claude/prompt-caching`、「What invalidates the cache」の表の **Effort setting**): 「Changing the `output_config.effort` value can invalidate message blocks, and on some models tool and system caches too … Setting effort explicitly to the model's default is equivalent to omitting it and does not invalidate. On models that support per-message effort, an effort change carried in a `role: "system"` message inside `messages` leaves the cached prefix intact.」
- 同じ表の **Thinking parameters**: 「The thinking configuration (mode, and `budget_tokens` in extended mode) is rendered into the prompt, so changing it always invalidates message blocks; tool and system caches are also invalidated on models that render the configuration ahead of them.」
- thinking (`…/build-with-claude/thinking`、「Thinking and prompt caching」): 「The thinking configuration and the resolved `effort` level are rendered into the prompt itself, so changing any of them changes the prompt. … Changing the effort value can invalidate message-level breakpoints on any model. On Claude Opus 5, Claude Sonnet 5, Claude Fable 5, Claude Mythos 5, and earlier models that support effort, changing the effort value can invalidate tool and system-prompt breakpoints too. Treat any thinking or top-level effort change as invalidating the whole cache. On models that support per-message effort, an effort change carried in a `role: "system"` message inside `messages` leaves the cached prefix intact.」
- prompt caching の「Cache storage and sharing」: 「Cache hits require 100 percent identical prompt segments, including all text and images up to and including the block marked with cache control.」。lookback は 20 block (同じ文書の「How automatic prefix checking works」)
- preserved thinking の prefix check (`…/preserved-thinking/prefix-checks`): 「Changing, inserting, moving, or deleting an earlier message counts, whatever its role.」「The prefix check looks only at content, not at sessions, IDs, or users. The same content in a new request or a fork passes it.」。比べるのは `system` / `tools` / messages で、`model` / `effort` / `metadata` 等の parameter は含まない

### 6. 他に効いていないもの

- gateway:
  - S と fork は同じ経路 (`claude-zunsystem`)、同じ解決後の model (`claude-opus-5-5`) に送られた
  - thinking の跨ぎの変換 (llm-gateway DR-0035) はどちらにも当たっていない
  - cache の寿命の書き換え (llm-gateway DR-0024) は、本体 (main) が `ttl: "1h"`、fork (`claude -p`) が ttl 無し。ttl 無しは 1h の entry も読む (前回の B-d が同じ組で全部読んでいる)
  - `thinking.display` は gateway が summarized に揃える
- effort の出どころ: daemon が btw に渡した `medium` は S の通しの上書き (`spelledRunsAs` が、通しの上書き → セッション自身 → transcript の順に取る)。DR-0060 §2 のとおり

## 分かっていないこと

- **fork の total が本体の直前より約 3 万少ない理由**。173 番目より後に thinking が 157 件ある (前は 60 件)。173 番目の違いで prefix check に外れた thinking を API が数えていない、と読めば数は合うが、確かめていない。一次資料では Opus 5.5 の不一致は「400 か、そのまま読ませる」で、落とすのは `drop_block` を送った時だけ。外れた thinking が model に届いたかどうかも分からない
- 1 番目の印 (`output_config`) が Opus でも cache に効かないか (確かめたのは sonnet の A-m 1 件だけ)
- `--resume` が `wireToolInputs` を使わないのが意図か不具合か。583 / 785 の違いが何から来るか
- 使い捨ての Opus / Sonnet のセッションでの実測はしていない。どの cwd でも user の instruction 群で 1 request が 6〜8 万 token になり、許された量 (2 万 token 程度) に収まらなかった。代わりに、S 自身の fork を記録して request の形を直接比べた

## 実用的な示唆

- btw の fork は、`--resume` が transcript から組み立てる履歴に頼っている。組み立てが本体の送った形を再現しない message が 1 つでもあると、その手前までしか cache を読めない。そういう message が出やすい場面: tool の schema を読まずに呼んだ MCP の tool、turn の最中の入力、ToolSearch の結果。長いセッションほど当たりにくい
- effort・model の綴り・起動の引数を変えても、この外れは直らない。model は正式な id のままが正しい (本体と同じ別名にすると thinking が全部落ちる)
- 認識されない別名 (`opus[1m]`) で走るセッションは、webui の effort の通しの上書き 1 回ごとに、本体自身が会話の cache を全部書き直す (今回は 541,931 token を 1h で)
