# webui の Timeline の live を module の push 起点にした形 (DR-0045 の段階 1) を実機で確かめた

- Date: 2026-10-28
- 対象: Claude Code 2.1.312、ccmsg の作業コピー (v0.206.0 の上の段階 1)
- 動機: [DR-0045](../decisions/DR-0045-say-speaks-in-tool-shown-from-transcript.md) の段階 1 を本物の claude で通して、次の 3 点を見る
  - 開いた Timeline に新しい行が live で出ること
  - 行の源が push を合図にした読みであること (fs.watch ではない)
  - 書き込みから送りまでの遅れ
- 方法:
  - daemon: 自分用 workspace の `packages/daemon/src/index.ts --foreground` を起動した。`CCMSG_STATE_DIR` / `CCMSG_CONFIG_DIR` / `CCMSG_DATA_DIR` / `HOME` は一時ディレクトリに向け、`CCMSG_CLAUDE_CONFIG_DIRS` には試験用の config home だけを名指した (verify skill の手順)
  - 試験セッション: 一時ディレクトリの config home で 2 つ起動した (`--model sonnet --permission-mode default`、tmux の中)
    - `--plugin-dir <自分用 workspace>` を付けた `🤖ccmsg-verify-stage1`
    - 付けない `🤖ccmsg-verify-stage1-nomod`
    - model の応答は Messages API の代役 (reference `claude-mods/lab-setup`) が返した
  - webui: daemon の HTTP を `playwright-cli` で開き、`🤖ccmsg-verify-stage1` の Timeline を開いたまま、TUI から prompt を 2 つ入れた。2 つ目は Bash を 1 回使う turn
  - 観測: daemon の `trace.jsonl` を見た。`transcript_read` の `source` は、`push` / `retry` が relay の読み、`fs_watch` が daemon の fold 用の Watch の読み

## 判明した事実

| 場面 | 結果 |
|---|---|
| Timeline を開いた後に打った prompt (`second live prompt`) | 再読み込みせずに Timeline に出た |
| 続く Bash の turn (`TOOLRUN third` → `Ran 1 shell command` → `done`) | 同じく出た |
| relay の読み | 3 回の turn で `push` が 1 回、`retry` が 2 回。retry は、push の時に行がまだ書かれていなかった分 |
| 送りの遅れ (`wire_write` の時刻 − 読んだ行の最後の `timestamp`) | 39 ms / 126 ms / 96 ms |
| 同じ範囲の fold 用 Watch の読み (`fs_watch`) | relay の読みと同じ byte 範囲で、時刻もほぼ同じ (同じ ms〜数 ms 差) |
| module の無いセッション | daemon に繋がっていないので `transcript_subscribe` は今までどおり `session_not_found`。Timeline は履歴の読みだけ (段階 1 の前と同じ) |

- relay の読みと fold 用の Watch の読みは、同じ byte 範囲を別々に読んでいる。Watch は段階 2 で削る
- `ev:"transcript"` の形 (byte offset の `start` / `end` / `size`) は変えていないので、webui は変更なしで動いた

## 未検証

- 上限 (5 秒) まで行が書かれない場面と、その後の push での拾い直し。daemon の単体テスト (`packages/daemon/test/transcript-relay.test.ts`) でだけ確かめた
- 長い turn、大きな行 (画像を含む行、長い tool の出力) での遅れ
- 同じセッションを複数のタブで開いた時
