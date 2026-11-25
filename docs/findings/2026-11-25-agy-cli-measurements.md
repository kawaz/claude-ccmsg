# agy 1.5.15 の stream-json の実測 (DR-0066 の M1〜M9・M11・M15〜M17)

- Date: 2026-11-25 (18:11〜18:26、JST)
- 対象: agy 1.5.15 (`agy --version` の出力)、macOS (Darwin 25.5.0)。`agy` は Homebrew の cask のラッパで、`AGY_CLI_DISABLE_AUTO_UPDATE="true"` を付けて本体 `antigravity` を exec する
- 出どころ: agy を調べている別のセッションの実測
- 動機: [DR-0066](../decisions/DR-0066-agy-conversation-tool.md) の「要る実測」のうち agy の側のもの
- 方法:
  - 断りの無い限り、起こし方は DR-0066 §5 に合わせた形: daemon 役のプロセスが fork/exec し、子は自分の process group を持ち、標準入力は daemon 役からの pipe、標準出力と標準エラーはそれぞれ別のファイルへ直接。`stream-json` の入出力。依頼の行は `{"event":"user","message":{"content":"…"}}`
  - 時刻は、別のプロセスがファイルを 50 ms ごとに読み、新しい行を見た時刻。ms の桁は ±50 ms の幅を持つ
  - 実験台はセッションの `$TMPDIR` の中に置いた。各回の名前 (a1、b1 等) は実験台の回の名前

## 結論の一覧

| M | 結論 | 確度 |
|---|---|---|
| M1 | ファイルへ直接向けても行は逐次に書かれる。init は依頼を書く前に、起動から約 3.5〜5 秒で出る | 高 (11 プロセス、逐次の時刻は a1 で詳しく) |
| M2 | 親を SIGKILL しても正常終了させても、走っていたターンを書き切り、書いてあって始まっていなかった依頼も全部処理して、正常に終わる | 高 (2 通り各 1 回、依頼は各 4 件) |
| M3 | 本体 pid と process group への SIGINT で、数十 ms で `interrupted` の result が出て終了コード 1 で終わる。exec しない bash の pid に送っても届かず、process group に送れば届く | 高 (3 回) |
| M4 | result は書いた順に出る。依頼を見分ける欄は無い。SIGINT の時、書いてあって始まっていない依頼に result は出ない | 高 (順: 3 プロセス 13 件、SIGINT: 2 回) |
| M5 | 未サインインは、init の前に標準出力へ `status:"ERROR"` の result 行が 1 つ、標準エラーに文、約 0.2 秒、終了コード 1。利用枠切れは取れなかった | 未サインイン: 中 (1 回)。利用枠: 未取得 |
| M6 | 強さ付きのモデル名と違う `--effort` はエラー (どちらも効かない)。強さの無い系列名 + `--effort` は通る。知らないモデル名もエラー。どれも init の前に終了コード 1 | 高 (食い違い 4 通り各 2 回) |
| M7 | `--conversation <ID>` で再開した時の init の conversation_id は、渡した ID と同じ。今回 12 回すべて同じ (既に取った 7 回と合わせて 19 回) | 高 |
| M8 | 2 種の裏の処理 (裏で走らせたコマンド、`schedule` のタイマー) は、どれも result の前に終わりを待たれた。result の後に出力もプロセスも残らなかった | 中 (裏のコマンド 2 回、`schedule` を明示 1 回、agy が自分で裏の task にした 3 回) |
| M9 | ターン中も標準入力を読み進める。150 KB と 1.2 MB の 1 行が即座に書き切れ、処理された | 高 (各 1 回) |
| M11 | stream-json の result に `structured_output` が入る。最後の result だけでなく、各 result に入った | 中 (2 モデル各 1 回、依頼 2 件) |
| M15 | シェル 1 回 + 300 語の文章の 1 ターンで 16,816 bytes (init 1,391 / step_update 39 行 12,513 / result 2,912) | 中 (1 回) |
| M16 | ps で本体の引数全体と起動時刻 (秒) が読める。`proc_pidinfo` ならマイクロ秒。`--conversation` の無いプロセスの会話の ID は lsof で開いているファイルの名前から分かる | 高 (ps・lsof とも複数回) |
| M17 | 同じ会話を 2 つのプロセスで開いて両方が書くと、閉じる順に関わらず、後から依頼を書いた方 (今回は C) の履歴が残り、先に書いた方 (B) の依頼は会話から消えた。後から開いて依頼の前に SIGINT した C は何も消さず、残した方の書き込みも残った。C が書いた後に SIGINT しても C の書き込みは残る (B が先に書いていた分は消える) | 中 (4 通り各 1 回、モデル 1 種) |

## 全体に効く発見: result の `usage`・`duration_seconds`・`num_turns` は会話の累計

### 観測したこと

- 1 プロセスに 5 件の依頼を流すと、result の `num_turns` が 1, 2, 3, 4, 5、`duration_seconds` が 37.6, 39.5, 40.7, 42.0, 43.5、`usage.input_tokens` が 9,932, 10,204, 10,401, 10,780, 11,070 と増えていった (claude-sonnet-5-5-low、b1)。2 件目以降は「Reply only: ONE」程度の依頼で、`output_tokens` も 787, 797, 802, 807, 812 と前の値に足されていく
- プロセスをまたいでも累計が続く (gemini-3.8-flash-low): 新しい会話の result は `input_tokens` 8,909・`num_turns` 1・`duration_seconds` 3.0。42 分後に `--conversation` で再開したプロセスの result は `input_tokens` 18,039・`num_turns` 2・`duration_seconds` 2,520.6。再開したターンの `agent_response` の step の `usage.input_tokens` は 9,130 で、18,039 = 8,909 + 9,130。`duration_seconds` の 2,520 秒は会話の始まりからの経過時間 (42 分) に合う。2 分後に再開した別の会話も `num_turns` 2・`duration_seconds` 120.7
- ターンごとの使用量は、`step_update` の `step_type:"agent_response"` で `state:"DONE"` の行の `usage` にある (その step の 1 回のモデル呼び出しの分。1 ターンに何回も出る)
- 例外: SIGINT で止めた時の `duration_seconds` は、依頼を書いてから 9 秒で止めたのに 2.2 だった (d1)。何を測っているかは分からない

### 取れなかったこと

- 依頼 1 件の分を「その result と、同じ会話の 1 つ前の result との差」で取った値と、そのターンの `agent_response` の step の `usage` の和が一致するか
- DR-0066 の A11 の Claude の数字が result の値 (累計) かどうか (元の記録を見ていない)

## M1: 標準出力をファイルに向けた時に行が逐次に書かれるか

### 観測したこと

- a1 (claude-sonnet-5-5-low、`--effort low --dangerously-skip-permissions`): 依頼「`echo STEP1; sleep 15; echo STEP2` を走らせて待ち、300 語の文章を書く」を 1 件
  - 18:12:06.9 起動 → 18:12:12.1 init (依頼はまだ書いていない) → 18:12:15.9 依頼を書く → 15.94 `user_input` の step → 18.30 `run_command` の ACTIVE → 33.34 その DONE (15 秒の sleep の後) → 43.72・49.45 にそれぞれ数行ずつ → 50.31〜50.80 に `text_delta` の断片が 50 ms 前後の間隔で 16 行 → 50.805 result → 標準入力を閉じて 51.6 に終了コード 0
  - 行は step が終わるたびに数行ずつまとまって書かれ、最後の応答の step だけは `state:"ACTIVE"` の断片が逐次に出る。ターンの最後にまとめて出ることは無かった
- init が依頼より先に出ることは、ファイルに向けて起こして init を待った 11 プロセス (a1, b1, b2, c1, c2, d1, d2, d3, g1, g2, g3) のすべてで同じ。起動から init まで 3.5〜5.2 秒
- lsof で見ると、agy 本体は fd 1 と 2 を自分のログ (`~/.gemini/antigravity-cli/log/cli-<日時>.log`) に付け替え、受け取った標準出力と標準エラーのファイルを fd 5 と 6 で持っていた。stream-json の行は fd 5 側に書かれる (ファイルの大きさが行と合う)

### 取れなかったこと

- pipe に向けた時との比較は取っていない (前の実験台は pipe を時刻付きで読み、逐次だった)

## M2: 起こした親が終わって標準入力が閉じた後

### 観測したこと

- c1 (claude-sonnet-5-5-low、全許可): 依頼「`sleep 20; echo S1-DONE` を走らせて出力を返す」と「Reply only: ONE / TWO / THREE」の 3 件を続けて書き、4 秒後に daemon 役を SIGKILL。1 秒後の ps で本体の ppid が 1 になり、シェルの子 (`zsh -c sleep 20…`) は生きていた。23 秒後から S1-DONE・ONE・TWO・THREE の result が順に出て、最後の result の 2.4 秒後にプロセスが消えた
- c2 (gemini-3.8-flash-low、全許可): 同じ 4 件を書き、4 秒後に daemon 役を正常に終わらせた (子を待たない)。同じく 4 件の result が順に出て、最後の result の 4.6 秒後にプロセスが消えた
- 標準エラーはどちらも 0 bytes

### 取れなかったこと

- 親が居ない時の終了コード

## M3: SIGINT が本体に届く条件

### 観測したこと

| 回 | モデル | 起こし方 | 送り先 | 結果 |
|---|---|---|---|---|
| d1 | claude-sonnet-5-5-low | 直接 exec (pid = 本体) | pid | 36 ms 後に `{"status":"ERROR","error":"interrupted","finished_reason":"interrupted",…}` の result。標準エラーに `error: interrupted`。終了コード 1 |
| d2 | gemini-3.8-flash-low | `bash -c '"$@"; echo …'` (exec しない bash を挟む) | bash の pid | 8 秒間、何も出ず、本体もシェルの子も生きたまま |
| d2 | 同上 | 同上 | process group | 46 ms 後に interrupted の result。本体の終了コードは 1 (bash の標準エラーに `child exited 1`)。bash 自身は後ろの `echo` を走らせて終了コード 0 |
| d3 | gemini-3.8-flash-low | 直接 exec | process group | 45 ms 後に interrupted の result。終了コード 1 |

- agy が走らせたシェルのコマンド (`zsh -c …` と `sleep`) は、本体と別の process group (pgid = zsh の pid) に居る。process group に送った信号はそれに直接は届かないが、3 回とも本体が終わった 2 秒後の ps にシェルの子は残っていなかった (agy が後始末している)
- 標準入力を閉じた正常な終わりは終了コード 0 (a1, b1, b2, g1, g2)。SIGINT の終わりは 1

## M4: result の順と、依頼を見分ける欄

### 観測したこと

- b1 (claude-sonnet-5-5-low): 「sleep 20 のシェル」をターンとして走らせ、その 4 秒後に 150 KB の依頼 1 件と ONE/TWO/THREE の 3 件を書いた。result は S1-DONE、BIG100K-OK、ONE、TWO、THREE の順。c1・c2 でも S1-DONE、ONE、TWO、THREE の順 (合わせて 3 プロセス 13 件、順が崩れたことは無い)
- result の欄は `conversation_id`・`status`・`response`・`duration_seconds`・`num_turns`・`usage` (失敗時は `error`・`finished_reason`、`--json-schema` の時は `structured_output`・`json_schema`)。依頼を見分ける欄は無い。`num_turns` は会話の累計のターン数で、1 件ごとに 1 増える (前のプロセスの分も含む)
- SIGINT の時: d1 は「sleep 30」のターン中に ONE/TWO/THREE を書いてから SIGINT、d3 は同じく書いてから process group に SIGINT。どちらも result は interrupted の 1 行だけで、書いてあった 3 件には result が出なかった
- `response` は、そのターンの `agent_response` の文を全部つなげたもの。途中の「まだ走っています」等の文や、裏のコマンドの終わりの知らせへの返事も入る (b1 の 1 件目は `"The task is still running…\nStill running; waiting for the timer.\nS1-DONE\nS1-DONE\n"`)

## M5: サインインしていない時と利用枠切れの時の出方

### 観測したこと

- e1 (gemini-3.8-flash-low、全許可なし): `HOME` を `$TMPDIR` 内の空ディレクトリにして起こした (本物の `~/.gemini/` には触れていない。agy は空の HOME の下に `.gemini/` の一式を作った)
  - 起動 0.17 秒後に標準出力へ 1 行: `{"event":"result","result":{"conversation_id":"","status":"ERROR","response":"","error":"authentication failed or timed out","duration_seconds":0,"num_turns":0,"usage":{…全部 0},"finished_reason":"error"}}`。init は出ない
  - 標準エラー: `Error: authentication required. Run 'antigravity' to log in, then retry.` と `error: authentication failed or timed out`
  - 0.41 秒で終わり、終了コード 1。依頼を書く前に終わっていた (後で書いた依頼は Broken pipe)
  - ブラウザは開かなかった (画面は見ていないが、プロセスの一覧に別のものは出なかった)

### 読んだだけのこと

- 利用枠切れの出方は DR-0066 の A13 (`Individual quota reached … Resets in <時間>` と `AGY_ERROR: {…"error_code":429…}`、終了コード 3) と reference の `agy/headless` にある。どちらも `-p` か json の時のもので、stream-json でどこに出るかは書かれていない

### 取れなかったこと

- 利用枠切れ: 枠が残っていて起こせない
- 未サインインで `-p` の時の 60 秒待ち (DR-0066 の A14) との違いが、標準入力が端末でないためか、stream-json のためかは切り分けていない

## M6: モデル名の強さと `--effort` が食い違う時

### 観測したこと

依頼は同じ算数の問題 1 件 (答えは 6)。

| 指定 | 結果 (回数) |
|---|---|
| `--model gemini-3.8-flash-low` | 成功。thinking_tokens 436, 672 (2) |
| `--model gemini-3.8-flash-high` | 成功。thinking_tokens 1,163, 949 (2) |
| `--model gemini-3.8-flash-low --effort high` | 失敗 (2) |
| `--model gemini-3.8-flash-high --effort low` | 失敗 (2) |
| `--model claude-sonnet-5-5-low` / `-high` | 成功 (各 2)。thinking_tokens はどちらも 0 (Claude では出ない)。high は答えだけ、low は途中の式も書いた |
| `--model claude-sonnet-5-5-low --effort high` / `-high --effort low` | 失敗 (各 2) |
| `--model gemini-3.8-flash --effort high` | 成功。init の `model` は `gemini-3.8-flash`。thinking_tokens 1,144 (1) |
| `--model gemini-3.8-flash --effort low` | 成功。thinking_tokens 747 (1) |
| `--model gemini-3.8-flash --effort max` | 失敗: `gemini-3.8-flash has no "max" effort (available: low, medium, high)` (1) |
| `--model claude-sonnet-5-5 --effort low` | 成功。init の `model` は `claude-sonnet-5-5` (1) |
| `--model gemini-3.8-flash-medium --effort medium` | 成功 (1)。強さと同じ effort は通る (a1 等の `-low --effort low` も同じ) |
| `--effort low` (モデル無し) | 成功。init に `model` の欄が無い (1) |
| `--model gemini-9-nonexistent-low` | 失敗: `model gemini-9-nonexistent-low is not recognized as a known model or custom model in settings` と、使えるモデルの表示名の一覧 (1) |
| `--effort bogus` | 失敗: `invalid --effort "bogus" (valid: low, medium, high, xhigh, max)` (1) |

- 失敗の出方はどれも同じ形: init の前に、`error: invalid model selection (--model "<m>" --effort "<e>"): --model <m> conflicts with --effort=<e>` の行と、`{"event":"result","result":{"conversation_id":"","status":"ERROR","response":"","error":"invalid model selection …","finished_reason":"error",…}}` の行。終了コード 1。標準出力と標準エラーを混ぜて取ったので、`error:` の行がどちらに出たかは分けていない (M5 と同じなら標準エラー。推測)
- 通る組み合わせは「強さ付きの名前 + 同じ effort」「強さ付きの名前だけ」「強さの無い系列名 + effort」「effort だけ」
- 強さの無い系列名 (`gemini-3.8-flash`、`claude-sonnet-5-5`) は `agy models` の一覧 (reference の表) に無いが通る
- thinking_tokens は同じ指定でもばらつきが大きく (flash-low で 436 と 672)、1〜2 回では「系列名 + `--effort low`」と「`-low`」が同じ強さかは言えない

## M7: 再開した時の init の conversation_id

### 観測したこと

- M17 の手順で、`--conversation <ID>` を付けて再開したプロセスを 12 回起こした (claude-sonnet-5-5-low)。init の `conversation_id` はすべて渡した ID と同じで、その後の step_update・result の `conversation_id` も同じ
  - 内訳: 同じ会話を同時に 2 つ開いた (B と C) が 4 組 8 回、確認用の再開 (V) が 4 回
- 既に取っていた 7 回 (Claude Sonnet / Opus、Gemini Flash) と合わせて 19 回、食い違いは 0 回
- 再開しても起動から init まで約 3.5〜4 秒で、新しい会話と同じ

## M8: result の後に agy の中の裏の処理が残るか

### 観測したこと

- g1・g2 (claude-sonnet-5-5-low、全許可): 依頼「`sleep 30 && echo BGDONE > bg-done.txt` を裏のコマンドとして起こし、待たずにすぐ STARTED と返す」
  - どちらも `run_command` の step が 30 秒かかって終わり (agy は終わりを待った)、その後に `STARTED` の応答、終わりの知らせの `system_message`、もう 1 つの応答が出てから result。result はコマンドが終わった後 (起こしてから約 33 秒)
  - result の直後の ps で本体の子は無し。g1 は result の後 45 秒、標準入力を開いたまま待ったが、出力は 1 行も増えなかった。次の依頼は普通に処理された。g2 は result の直後に標準入力を閉じ、1.4 秒で終了コード 0、ファイルは書かれていた
- a1・b1・c1 (「sleep 15〜20 を走らせて待つ」依頼): agy はコマンドを裏の task (`manage_task` で状態を見る) にし、自分で `schedule` のタイマーを掛けて待った。タイマーはどれも result の前に発火し、ターンの中で処理された。b1 では裏の task の終わりの知らせ (`S1-DONE`) がターンの中に 2 度入った
- g3 (claude-sonnet-5-5-low、全許可): 依頼「`schedule` で 40 秒のタイマーを掛け、待たずにすぐ SCHEDULED と返す」。`schedule` の step が ACTIVE のまま 40.3 秒続いてから DONE になり、その後に `SCHEDULED`、`system_message`、`TIMER-FIRED` の応答が続いて、1 つの result (`"response":"SCHEDULED\nTIMER-FIRED\n"`) になった。result の後 60 秒、標準入力を開いたまま待ったが出力は増えず、ps で子も無し。次の依頼は普通に処理され、標準入力を閉じて 0.6 秒で終了コード 0
- 合わせて: 裏のコマンド 2 回 (g1, g2)、`schedule` を明示 1 回 (g3)、agy が自分で裏の task とタイマーにした 3 回 (a1, b1, c1)。どれも result の前に終わりを待たれた

### 取れなかったこと

- result の後に裏の処理が残る例は、試した 3 種では起きなかった。起きない保証ではない (モデルが「待たずに返す」を守らず、待ってしまった可能性がある。g1・g2 は守らなかった)。残る例があった時の出方は取れていない

## M9: ターン中に標準入力を読み進めるか

### 観測したこと

- b1: 「sleep 20」のターンが走っている 4 秒目に、150,064 bytes の 1 行 (JSON の `"event":"user",` の後に空白 150,000 個を挟み、本文は「Reply only: BIG100K-OK」) を書いた。daemon 役の書き込みは同じ ms の内に返った (pipe の 64 KB を超えても止まらなかった)。この依頼は前のターンの後に処理され、`BIG100K-OK` と答えた
- b2 (gemini-3.8-flash-low): 1,200,062 bytes の 1 行 (同じく空白を挟む) を、ターンの無い時に書いた。1 ms で書き終わり、`BIG1M-OK` と答えた。1 行の長さに 64 KB の上限は無い (少なくとも 1.2 MB までは読める)

### 取れなかったこと

- 本文に実際の 100 KB の文章を入れたものは試していない (モデルの利用枠を使うため)。読み込みの経路は同じ行なので、差は出ないと見る (推測)

## M11: stream-json の result に `structured_output` が入るか

### 観測したこと

- `--json-schema '{"type":"object","properties":{"first":…,"second":…},"required":[…]}'` を付け、依頼 2 件 (日本とフランスの首都 / イタリアとスペインの首都) を流した
  - gemini-3.8-flash-low: 2 件の result の両方に `"structured_output":{"first":"Tokyo","second":"Paris"}` / `{"first":"Rome","second":"Madrid"}` と `"json_schema":{…}` が入った。1 件目の `response` は散文の答えと JSON の 2 段 (ターンの中で 2 回応答した)
  - claude-sonnet-5-5-low: 同じく 2 件とも入った。`response` は JSON だけ

### 読んだだけのこと

- help: `--json-schema … (for stream-json, only applicable to the final result)`。観測では最後の result だけでなく、どの result にも入った

## M15: 長めの依頼 1 回で標準出力に書かれる量

### 観測したこと

- a1 (claude-sonnet-5-5-low): シェル 1 回 (15 秒) + 300 語の文章の 1 ターンで、標準出力は 41 行 16,816 bytes。内訳は init 1 行 1,391 bytes、step_update 39 行 12,513 bytes、result 1 行 2,912 bytes。`text_delta` の文字の合計は 2,629
- 同じ形の短いターン: b1 (シェル 1 回 + 短い依頼 4 件) で 47 行 14,475 bytes、g1 (シェル 1 回 + 短い依頼 1 件) で 23 行 6,570 bytes、b2 (返事だけ 1 件) で 5 行 2,322 bytes
- init の 1 行は道具の一覧 (61 個) を含むので約 1.4 KB

### 取れなかったこと

- 数百 KB を読ませる 10〜50 分の依頼は、利用枠を使うので流していない。step_update は道具の呼び出し 1 回で 2 行 (ACTIVE と DONE、DONE は道具の出力を含む) なので、量は道具の出力の大きさで決まる (推測)

## M16: 走っている agy を外から見る

### 観測したこと

- ps (`ps -axww -o pid,ppid,pgid,lstart,etime,command`): 本体の行は `…/antigravity --input-format stream-json … --model … --effort …` で、渡した引数がそのまま読める (ラッパの `agy` の名前は残らない)。`lstart` は秒まで。10 回以上
- `proc_pidinfo(PROC_PIDTBSDINFO)` (Python の ctypes で `/usr/lib/libproc.dylib` を呼んだ) で、同じ uid のプロセスの起動時刻をマイクロ秒で読めた (d1: `start=1795598181.058342`、ps の lstart は 18:16:21)。pid 1 (root) は読めなかった
- lsof (a1、`--conversation` を付けずに起こしたプロセス): 開いているファイルの名前に会話の ID が出る。init の前の段階から、`~/.gemini/antigravity-cli/conversations/<ID>.db` (と `-wal`・`-shm`)、`~/.gemini/antigravity-cli/presence/<ID>.lock` (0 bytes、FD は `83u`)、`~/.gemini/antigravity-cli/brain/<ID>/` が開かれていた。ID は init の `conversation_id` と同じ。ターン中・result の後も同じ
- ログ `~/.gemini/antigravity-cli/log/cli-<日時>.log` にも会話の ID が出る (前のプロセスのログで `Print mode: starting (… conversationID="<ID>")` と `GetConversationDetail: found conversation <ID>`)。本体はこのログを fd 1・2 で開いているので、lsof からログの名前も分かる
- agy が走らせたシェルのコマンドは、本体の子で、別の process group (pgid = その zsh の pid)
- lsof で会話の ID を見る方法はファイルの名前に頼るので、agy の版が変われば崩れうる

### 読んだだけのこと

- `presence/<ID>.lock` が排他のロック (flock 等) に使われているかは分からない。lsof の FD の欄にロックの印は出なかった (macOS の lsof が flock を表示するかは確かめていない)

## M17: 同じ会話を 2 つのプロセスで開いた時

### 観測したこと

- claude-sonnet-5-5-low で各通り 1 回。各通りは、新しい会話に MAPLE-3 を覚えさせて閉じ、同じ会話を B と C の 2 プロセスで開き (B を先に、C を後に起こす。どちらも init は渡した ID、M7)、B に BIRCH-5・C に CEDAR-7 を覚えさせ、閉じ方を変えてから、第 3 のプロセス (V) で再開して「覚えている語を全部」答えさせた
- 2 プロセスが同じ会話を開けること自体は拒まれなかった。どちらも init が出て、依頼に応じ、result の `num_turns` は B も C も 2 (互いの分を知らない)。step_index も B・C とも 2, 3, 4 と同じ番号を使った
- lsof (V1): B が `presence/<ID>.lock` を開いていたのに対し、C の一覧にはそれが無かった (`conversations/<ID>.db` は両方が開いていた)。排他を取っているかは分からない

| 通り | 操作 | V の答え | 残った語 |
|---|---|---|---|
| V1 | B が書く → C が書く → C を先に閉じ、3 秒後に B を閉じる | `MAPLE-3, CEDAR-7` | C |
| V2 | B が書く → C が書く → B を先に閉じ、3 秒後に C を閉じる | `MAPLE-3, CEDAR-7` | C |
| V3 | B が書く → C を開いて依頼の前に SIGINT → B が ASPEN-2 を書いて閉じる | `MAPLE-3, BIRCH-5, ASPEN-2` | B (C は何も書いていない) |
| V4 | B が書く → C が書く → C を SIGINT → B が ASPEN-2 を書いて閉じる | `MAPLE-3, CEDAR-7, ASPEN-2` | C と、SIGINT の後の B の ASPEN-2。B の BIRCH-5 は消えた |

- V1 と V2 は閉じる順を入れ替えたが結果は同じ。残るのは閉じる順ではなく、後から依頼を書いた方 (C)。ただし今回は C が「後に起動」「後に書いた」の両方なので、どちらが決め手かは分けていない
- V3: SIGINT で止めた C (終了コード 1、result は `status:"ERROR"`・`error:"stream input cancelled: context canceled"`・`finished_reason:"interrupted"`、標準エラーに同じ文) は、何も書いていないので B の履歴を壊さなかった。B はその後も ASPEN-2 を処理し、3 件すべてが残った
- V4: C の依頼の result は SIGINT の前に SUCCESS で出ていて、SIGINT 後に出た 2 つ目の result は `status:"ERROR"`・`response:"OK-C\n"`・`finished_reason:"interrupted"` (同じ文を再掲)。止めた C の書き込みは残った。B の SIGINT 後の依頼 (ASPEN-2) も処理されて残ったが、B が先に書いた BIRCH-5 は V に覚えられていなかった。B の ASPEN-2 の result の `num_turns` は 3 で、V の result は 4
- SIGINT した C の `duration_seconds` と `num_turns` は、止めた時点の会話の値 (V3: 7.87 と 2、V4: 13.47 と 2)
- 後から起きた方を SIGINT で止めても、止めた方が依頼を書いていなければ何も壊さない (V3)。止めた方が既に書いていた場合 (V4) は、止めても書き込みは取り消されず、先に起きていた側の既に書いた分が消えたままになる

### 取れなかったこと

- 後から起動した方が、書かずに先に閉じた時の結果 (今回の 4 通りに無い)
- 先に起動した B が後から書き、C が先に書いた時に、B と C のどちらが残るか (「後に書いた方が残る」と「後に起動した方が残る」の切り分け)
- Claude Sonnet 以外のモデル、各通り 2 回目

## 実験の後片付け

- 最後の実行の後、`pgrep -fl 'antigravity|…'` で残りを確かめた: 該当なし。各回の最後の ps にも agy のプロセスは無かった
- 本物の `~/.gemini/` のサインイン状態は変えていない (M5 は `$TMPDIR` 内の空の HOME。その後の実行もサインインしたまま動いた)
