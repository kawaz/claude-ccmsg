# セッションの名前の変更を module の `$.command.run` (`/rename`) で行う (DR-0047) を実機で確かめた

- Date: 2026-11-02
- 対象: Claude Code 2.1.316、ccmsg の作業コピー (v0.210.1 の上の DR-0047 の実装)
- 動機: [DR-0047](../decisions/DR-0047-session-rename-via-command-run.md) の経路 (webui のタイトルの ✎ → op `session_rename` → サイドカーの依頼 `session.rename` → module の `$.command.run({ command: "rename", args })`) を本物の claude で通し、idle の時に名前が変わること、応答中は turn の後に変わること、module の無いセッションが `no_module` になることを見る
- 方法:
  - daemon は作業コピーの `packages/daemon/src/index.ts --foreground` を、`CCMSG_STATE_DIR` / `CCMSG_CONFIG_DIR` / `CCMSG_DATA_DIR` / `HOME` を一時ディレクトリに向け、`CCMSG_CLAUDE_CONFIG_DIRS` に試験用の config home だけを名指して起動した (verify skill の手順)。state dir はサイドカーの socket のパスが sun_path の上限を超えないよう、`mktemp -d /tmp/rnm.XXXXXX` の短いパスにした
  - 試験セッションは 2 つ、どちらも一時ディレクトリの config home (`CLAUDE_CONFIG_DIR`) と空の作業ディレクトリで、`env -i` で継いだ変数を落とし、daemon と同じ `CCMSG_*` を渡して専用 socket の tmux の中で起動した
    - module 付き: `--name "🤖ccmsg-verify-rename" --plugin-dir <作業コピー> --model sonnet --permission-mode default`
    - module 無し: 同じ config home で `--plugin-dir` を付けずに `--name "🤖ccmsg-verify-rename-nomod"`
  - model の応答は Messages API の代役 (`ANTHROPIC_BASE_URL` を手元の HTTP server に向けた、reference `claude-mods/lab-setup`) が返した。会話に `COUNT` があれば `1\n` から `200\n` を 200 ms ごとに 1 行ずつ stream し (約 40 秒の応答)、無ければ短い固定の文を返す
  - webui は daemon の HTTP を `playwright-cli` で開き、Sessions 一覧の ✎ から操作した。op だけを見る場合は daemon の socket に user role で繋ぐ小さな client から送った
  - 名前は、Claude Code の state file (`<config home>/sessions/<pid>.json` の `name`)、webui の Sessions 一覧の `.session-title`、TUI の画面で見た

## 判明した事実

| 場面 | 操作 | 結果 |
|---|---|---|
| idle | webui の ✎ → 名前を入力 → Enter | daemon.log `session_rename: … result=renamed tries=[… renamed]`。TUI に `❯ /rename 🤖ccmsg-verify-rename-改名1` と `⎿ Session renamed to: 🤖ccmsg-verify-rename-改名1`、下の枠の名前も変わった。state file の `name` と Sessions 一覧のタイトルが新しい名前になった |
| idle (2 回目) | 同上 | `renamed`。行の注記は「名前を変更: 🤖ccmsg-verify-rename-改名2」 |
| 応答の stream 中 (`COUNT`) | webui の ✎ → 名前を入力 → Enter | daemon.log `result=queued tries=[… queued]`。行の注記は「応答の後に名前を変更: 🤖ccmsg-verify-rename-改名3」。この時点の state file の `name` は前の名前のまま |
| 応答の stream 中 (別の回、名前は今のまま送った) | 同上 | `queued`。応答中の TUI の入力欄の上に `❯ /rename 🤖ccmsg-verify-rename-改名2` が待ちとして出て、turn の後に `⎿ Session renamed to: …` が出た |
| 同上の turn の後 | — | turn の終わり (「Churned for 40s · done」) の直後に `⎿ Session renamed to: 🤖ccmsg-verify-rename-改名3`。state file の `name` と Sessions 一覧のタイトルが新しい名前になった |
| idle | op を直接 | `{ ok: true, title: "🤖ccmsg-verify-rename-改名5", outcome: "renamed" }`、所要 26 ms |
| module の無いセッション | op を直接 | `no_module` (`session … has no hooks module to rename it; rename it from its terminal (/rename)`)、`tries=[]`、所要 1 ms。そのセッションの TUI には何も入らなかった |
| module の無いセッション | webui | その行には ✎ が出ない (Shift+クリックの案内も出ない)。module 付きの行には出る |
| 知らない sid | op を直接 | `session_not_found`、`tries=[]` |
| 名前に改行 | op を直接 | `invalid_args` (`… must not contain control characters …`)。module に何も送らない |
| session role の接続から | op を直接 | `bad_request` (`op 'session_rename' requires user role`) |

debug log (`--debug`) の該当行 (module の `$.command.run` と、それが起こした `command.run` で ccmsg 自身の hook が飛ばされた行):

```text
08:24:51.955Z [DEBUG] $.command.run (ccmsg-v1): 33 chars queued
08:24:51.966Z [DEBUG] hooks module ccmsg-v1@inline command.run skipped: re-entry (the plugin's own code raised it; origin ccmsg-v1)
08:25:46.638Z [DEBUG] $.command.run (ccmsg-v1): 33 chars queued
08:26:11.354Z [DEBUG] hooks module ccmsg-v1@inline command.run skipped: re-entry (the plugin's own code raised it; origin ccmsg-v1)
```

2 つ目の組は応答中に頼んだもので、`queued` (08:25:46) から turn の後に走る (08:26:11) まで 25 秒の間がある。

`session_rename` の daemon.log (sid と request id は一部を伏せた):

```text
session_rename: session_id=<sid> result=renamed tries=[e095bfec… <sid>.<run>.sock renamed]
session_rename: session_id=<sid> result=renamed tries=[44176247… <sid>.<run>.sock renamed]
session_rename: session_id=<sid> result=queued tries=[90a60c9a… <sid>.<run>.sock queued]
session_rename: session_id=<sid> result=queued tries=[7772527e… <sid>.<run>.sock queued]
session_rename: session_id=<no module の sid> result=no_module tries=[]
session_rename: session_id=00000000-0000-4000-8000-00000000abcd result=session_not_found tries=[]
session_rename: session_id=<sid> result=renamed tries=[d8cd9208… <sid>.<run>.sock renamed]
```

## 気づいたこと

- module の `command.run` hook (/clear・/resume でサイドカーを起こし直す) は、module 自身の `$.command.run` が起こした `command.run` では engine に飛ばされる (findings 2026-10-26 の「再入の扱い」と同じ)。`rename` はその hook の対象ではないので影響は無い
- 応答中に頼んだ `/rename` は、TUI では人が応答中に打った prompt と同じく入力欄の上に待ちとして出る。turn の後に走るのは人の打鍵と同じ

## 試験の環境に由来すること

- model は代役。`/rename` は名前を引数で渡すと model を呼ばない (代役の記録に `/rename` の時の request は無かった)
- 試験セッションの config home は一時ディレクトリで、実際の config home の settings・plugin は載っていない

## 未検証

- `$.command.run` が `RENAME_WAIT_MS` (2 秒) で resolve しない場合 (module が読み込まれる前から走っている turn、ダイアログが開いている時) の `queued`。module の unit test でだけ確認
- permission のダイアログが開いている間の改名
- 同じ sid の 2 つの run (daemon の unit test でだけ確認)
- `queued` と答えた後に engine が `/rename` を拒む場合 (module の unit test でだけ確認)
