# webui からの model / effort の上書き (DR-0041) を実機で確かめた

- Date: 2026-10-26
- 対象: Claude Code 2.1.310。隔離 `CLAUDE_CONFIG_DIR`、隔離 daemon (`CCMSG_STATE_DIR` / `CCMSG_CONFIG_DIR` / `CCMSG_DATA_DIR`、HTTP は loopback)、Messages API の代役 (`ANTHROPIC_BASE_URL` を手元の HTTP server に向け、request の `model` / `output_config` / `anthropic-beta` を記録)。試験用セッションは hyoui の中で `--name "🤖ccmsg-verify-override"`、`--plugin-dir` にこのリポ、`--model 'opus[1m]' --effort high --permission-mode default --allowedTools Bash Agent` で起動した
- 操作: 通しの上書きは user role の op `session_override` (wire と webui の状態行の picker)、単発の上書きは op `user_prompt` の `model` / `effort` (wire と webui の FAB)。人の入力は `hyoui input` で打った
- 代役は、最後の user の文に `RUN_TOOL` があれば合図のファイルができるまで待つ Bash の tool_use を、`RUN_AGENT` があれば Agent の tool_use を返し、それ以外は短い文を返す

## この記録の範囲

下のマトリクスは、kawaz の裁定 (DR-0041 の「裁定」の節) の**前**の実装で取った。当時との違い:

- 変更の op: 当時は通しが op `session_override`。今は `request_override` (target 無し、通しだけ)。単発は当時も今も `user_prompt` の `model` / `effort` に乗る
- subagent: 当時は上書きを subagent の request にも効かせた。今は素通し
- 通しの変更: 当時は効いている単発を更新しなかった。今は通しで変わった field を単発からも外す
- 表示: 当時は status snapshot の欄で状態を持った。今は daemon の `ev: "request_override"` で全タブに配る。picker と FAB は effort を主、model を一段奥に置く

単発の寿命 (その turn の終わりまで) と、通しの差し替え・解除・再送、別名と `[1m]` の解決は当時と同じ。

- 今の実装でも成り立つ行: subagent の行以外のすべて (op の名と経路は変わったが、request に載る値は同じになるはず)
- 今の実装で変わる行: 「その subagent の request」(通し sonnet / low → 今は subagent 自身の値のまま渡るはず)。単発が効いている最中に通しを変える場合と、変更のイベントの配送は、この表に無い
- **今の実装での実機の取り直しは未実施**。試験用の claude を起動するコマンドが auto mode の classifier に止められたため。取り直しの手順は委譲元が持つ。今の振る舞いは unit test (`hooks/register.test.ts` の「the overrides of the session's requests」、`packages/daemon/test/request-override.test.ts`、`packages/daemon/test/user-prompt.test.ts` の「request_override over the wire」) で確かめている

## 結論

- 通し・単発・両方・解除のどれも、代役が受けた request の `model` と `output_config.effort` が DR-0041 §1・§4 のとおりに変わった。settings も `/model` の表示も変わらない (DR の前提の findings と同じ)
- tool の連鎖の途中で通しの effort を low にすると、次の request (tool_result を運ぶもの) から low になった
- subagent の request にも通しの上書きが載った
- `sonnet[1m]` / `haiku[1m]` のような別名は engine が `claude-sonnet-5-5` / `claude-haiku-5-5` に解決し、`anthropic-beta` に `context-1m-…` が付いた
- 同じ session id で起動し直す (`--resume`) と、名乗り直した run に daemon が通しの上書きを送り直し、次の request から効いた

## マトリクス

代役が受けた main thread の request (subagent は印を付けた)。effort / model は `output_config.effort` と `model`。

| 手順 | 上書き (daemon が持つ通し / 送信に付けた単発) | request の model | request の effort |
|---|---|---|---|
| 人の入力 (上書き無し) | なし | `claude-opus-5-5` | `high` |
| 通しを `{ model: sonnet, effort: low }` にして人の入力 | 通し sonnet / low | `claude-sonnet-5-5` | `low` |
| 通しを解除し、人の入力 `RUN_TOOL` の 1 つ目の request | なし | `claude-opus-5-5` | `high` |
| tool の実行中に通しを effort low にし、合図で tool を終わらせた次の request | 通し low | `claude-opus-5-5` | `low` |
| `user_prompt` に単発 `{ model: haiku, effort: max }` を付けて `RUN_TOOL` (1 つ目) | 通し low、単発 haiku / max | `claude-haiku-5-5` | `max` |
| 同じ turn の tool の後の request | 同上 | `claude-haiku-5-5` | `max` |
| その turn の後の人の入力 | 通し low (単発は消えた) | `claude-opus-5-5` | `low` |
| 通しに model sonnet を足し、単発 `{ effort: max }` で送信 | 通し sonnet / low、単発 max | `claude-sonnet-5-5` | `max` |
| 人の入力 `RUN_AGENT` (main) | 通し sonnet / low | `claude-sonnet-5-5` | `low` |
| その subagent の request | 同上 | `claude-sonnet-5-5` | `low` |
| 通しを両方 null で解除して人の入力 | なし | `claude-opus-5-5` | `high` |
| webui の FAB で単発 `model: haiku` / `effort: low` を選んで送信 | 通し high、単発 haiku / low | `claude-haiku-5-5` | `low` |
| 通しを sonnet / medium にし、`--resume` で起動し直して人の入力 | 通し sonnet / medium (名乗り直しで再送) | `claude-sonnet-5-5` | `medium` |

すべての request で `anthropic-beta` に `context-1m-…` が付いていた。

その他の観測:

- `session_override` の無効値 (`effort: "minimal"`) は `invalid_args` で断られた
- 起動し直す前のプロセスを止めている最中に通しを変えた時の応答は `delivery: "unconfirmed"` で、上書きは daemon に残り、名乗り直した run に `applied` で届いた (daemon の log `session-override -> <sid>.<run> (named): applied`)
- webui: 状態行は `ctx 1k/1M (0%) · opus-5-5[1m] · low⁺ · …` のように上書きの効いた field に `⁺` と警告色が付き、hover は `effort low (通しの上書き。セッション自身は high)。押すと通しの上書きを変える`。押すと状態行の下に model / effort の 2 つの選択が開き、選ぶと `session_override` が送られた。FAB の単発の選択は受け付けの後に「上書きなし」に戻った。Status タブの OVERRIDE 行は daemon が持つ通しを選択に出し、上書きの効いた ctx 行も同じ表記になった

## 本機能の外で見つかったこと

- **webui の session_status の購読が、ページを読み込んだ直後に切れることがある**。Timeline を開いた読み込みで、app は `session_status_subscribe` を 2 回 (q4 / q8) 送り、q4 の応答の後に `session_status_unsubscribe` (q11) を送った (playwright で WS の送受信を記録)。その後の上書きの変更で、daemon は同じページから別に開いて購読した WS には `ev:"session_status"` を push したが、app の接続には 1 件も来ず、状態行と Status タブは読み込み直すまで変わらなかった。daemon は同じ接続の購読を重ねて持たないので、後から届いた解除が 2 つ目の購読ごと消した、と読める (SessionView の購読の effect が `statusSource` の変化で張り直す時の後始末。原因は未確定で、effect の張り直しの順序の確認が要る)。上書きの picker を使った直後の表示が変わらないのはこのためで、上書きそのものは request に効いていた

## 未観測

- 本物の API で、別名 + `[1m]` の request が通るか (特に 1M の context を持たない model)
- `/clear` の後に通しの上書きが新しい session id で消えること (unit test でだけ確認)
- 単発の上書きを付けた文が turn を始めない時 (組み込みの command) の振る舞い
