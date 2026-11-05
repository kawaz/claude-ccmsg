# daemon の transcript relay が `gave up waiting` を出す原因と、webui の TL がライブ更新されない件の調べ

- Date: 2026-11-05
- 対象: Claude Code 2.1.318、ccmsg v0.212.0 (daemon と module)
- 動機: kawaz 2026-11-05 の報告。module のあるセッションの Timeline で、新しい prompt もその返事も、別の URL へ移って戻るか reload するまで出ない。実 daemon の `daemon.log` には `transcript relay: gave up waiting sid=<sid> rows=N after 5000ms` が 11-05 の 05:40 までに 5 セッション 67 回出ていた (push で受けた uuid の行が 5 秒待っても jsonl に現れない)
- 方法:
  - 実データ: 実 daemon の `daemon.log` と `trace.jsonl` (読むだけ) を、gave up したセッションの jsonl と突き合わせた
  - 再現: 作業コピーの daemon を隔離して起動し (verify skill の手順)、`transcript_push` の受け口で受けた行の `uuid` / `door` / `message` の先頭を、gave up の log に待った uuid を書く一時的な計装を入れた (確認の後に戻した)。試験セッションは 2 種
    - 隔離した config home と Messages API の代役 (reference `claude-mods/lab-setup`)。代役は prompt の印で、block の間に 0.5 秒おきの delta を 16 回 (約 8 秒) 挟んだ応答を返す。settings の hook に、出力のある PreToolUse / PostToolUse / UserPromptSubmit と、出力の無い PreToolUse / Stop を置いた
    - 実 config home (信頼済み cwd のプール) と実 model (sonnet、auto mode)。installed の ccmsg / ccmsg-v1 は `--settings` で切り、`--plugin-dir` で作業コピーの module を載せた
  - jsonl の各行がファイルに書かれた時刻は `fs.watch` で見た

## 判明した事実

### 1. append と書き込みの時機 (gave up の原因)

Claude Code は、assistant の応答 (1 つの API response) の content block を、block が完了するたびに `session.append` に流す。jsonl への書き込みは、response の stream が終わった時に、その response の行をまとめて行う。

| 応答の形 (代役) | 先の block の append | その行の書き込み | gave up した uuid |
|---|---|---|---|
| thinking → 8 秒かけて stream する text | 05:56:17.917 (thinking) | 05:56:26.058 (後の text と同時) | thinking の行 |
| 短い text → 8 秒かけて stream する text | 05:56:43.8 頃 (先の text) | 05:56:51.988 (後の text と同時) | 先の text の行 |
| 短い text → 8 秒かけて入力を stream する tool_use | 05:56:57.920 (text) | 05:57:04.597 (tool_use と同時) | text の行 |

- 応答の最後の block は、完了 (= stream の終わり) とほぼ同時に append されて書かれるので待たない
- 段階 0 の観測 ([2026-10-28-session-append-vs-jsonl](2026-10-28-session-append-vs-jsonl.md) §3「200 ms 後には全部」) は、代役が応答を一度に返していたので block の間に時間が無く、この差が出なかった
- 瞬時に返す応答、出力のある hook (`hook_success` / `hook_additional_context`)、実 config と実 model の短い turn (thinking + Bash + text) では、push の uuid は全部 jsonl にあり、gave up は 0 件だった

### 2. 実データとの一致

個人面のセッション 69e680c7 (opus、effort high) の 1 件:

| 時刻 | 出来事 |
|---|---|
| 01:05:14.085 | thinking の行の `timestamp` (= append の時刻) |
| 01:05:19.110 | `gave up waiting ... rows=1` (= push + 5.03 秒) |
| 01:05:23.105 | 同じ response の text の行の `timestamp` |
| 01:05:23.289 | daemon の `transcript_read` (offset 2431776 → 2446009、4 行)。thinking の行はここで初めて読まれた |

gave up の 4.9〜5.3 秒前に `timestamp` を持つ assistant の行の種類 (11-05、4 セッション):

| sid | gave up | thinking | tool_use | text |
|---|---|---|---|---|
| 69e680c7 | 23 | 19/75 | 5/114 | 0/25 |
| 05aa030f | 16 | 3/20 | 10/72 | 3/14 |
| 7ab56c6d | 16 | 8/26 | 8/66 | 0/21 |
| 1989c09d | 11 | 8/25 | 1/55 | 3/26 |

gave up の手前には、後ろに block が続く行 (thinking、並列 tool_use の先のもの) が多い。

### 3. gave up の後の行の扱い

- gave up は待ちを止めるだけで、行は捨てない。response の最後の block の push で daemon は続きを読み、先の block の行も一緒に relay される (§2 の 01:05:23.289 の read)
- なので行が webui に届くのは、ファイルに書かれた時 (response の終わり) と同じ。隔離環境の playwright でも、§1 の 3 つの応答を TL を開いたまま流し、全部 reload なしで出た

### 4. TL がライブ更新されない件 (原因は未特定)

隔離環境で、TL を開いたまま新しい prompt を入れて、reload なしで prompt と返事が出たかを見た。

| 条件 | 結果 |
|---|---|
| 単純な turn / §1 の 3 つの応答 | 出た |
| 行の位置の URL (`/s/<sid>/timeline/<uuid>`) で開いた TL | 出た |
| 別のセッションへ SPA で移動して戻った後 | 出た |
| 隔離 daemon を再起動した後 (module と webui が繋ぎ直した後) | 出た |
| 58 MB の transcript を resume したセッションで、older を 3 回読んだ後 | 出た |
| 同じセッションで、turn の stream 中に older を続けて押した後 | 出た |

実 daemon の trace で分かったこと:

- 購読しているタブがある間、daemon は読んだ行を全部、連続した byte 範囲で送っていた (7ab56c6d / 69e680c7 / 1989c09d の 11-05 の `wire_write` に、購読中の欠けは無い。欠けは購読者の居ない区間だけ)
- 7ab56c6d では、05:27:44〜05:28:45 に `transcript_read` が 13 回あるのに `wire_write` が 0 (購読者が 0)。その webui の接続 (c20) は閉じておらず、05:29:50 に kawaz がその TL を reload した (`GET /s/7ab56c6d…/timeline/<uuid>`、`nav=reload`)。reload の後の 05:35 の読み 4 回にも `wire_write` が無い
- タブが受け取って描かなかった push は、後で描かれた時に `elapsed_ms` の大きい client trace として残る (trace.ts は `dom_commit` で end までの保留を全部報告する)。11-02 以降の `dom_commit` で `elapsed_ms` が 1 秒を超えるのは 1 件だけ。= タブが受け取って落としたのではなく、daemon が送っていない (そのタブの購読が無い) 側を示す
- daemon は `transcript_subscribe` / `transcript_unsubscribe` を log に書かないので、購読が無かった間にタブが TL を見ていたのか、別の画面にいたのかは区別できない

## 結論

- gave up は Claude Code の書き込みの時機 (response の終わり) によるもので、TL に影響しない。行は response の最後の block の push で読まれ、欠けも重複も無く届く
- TL がライブ更新されなかったのは、module が 0.211 より前で push の無いセッション (kawaz 2026-11-05 裁定。新 module のセッションでは即時に反映されることを kawaz が確認)。daemon の relay の側 (読むファイル、offset、uuid の照合、gave up の後の拾い) に原因は無い

## 未検証

- 7ab56c6d の購読者 0 の区間に、kawaz のタブが何をしていたか (older の後の固まりと reload の可能性。[older の計測](2026-11-05-older-tab-freeze.md))
- `transcript_subscribe` が失敗する場面 (webui は失敗を握りつぶして再試行しない。`session_not_found` / `not_found` が返るのは、セッションが daemon に登録されていない時と transcript を名乗っていない時)
- interrupt (Esc) や API error で途中で終わった response の、append 済みの block の行が書かれるか
