# 再起動のフォーム (`session_restart` の `prompt`) の実機確認

- Date: 2026-11-02
- 対象: Claude Code 2.1.316、ccmsg v0.210.0 の上の未 push の変更 (再起動のフォームと `session_restart` の `prompt`)
- 動機: [DR-0028](../decisions/DR-0028-session-kill.md) の「restart」で、Status タブの「再起動」がその場にフォームを開き、既定文入りの textarea の内容が resume したセッションの最初の prompt になることを、本物の claude と組み込みの起動コマンドで見る。フォームの見た目をデスクトップと 390px 幅で見る
- 方法:
  - daemon は作業コピーの `packages/daemon/src/index.ts --foreground` を、`CCMSG_STATE_DIR` / `CCMSG_CONFIG_DIR` / `CCMSG_DATA_DIR` / `HOME` を一時ベースに向けて起動した (verify skill の手順)。`CLAUDE_CONFIG_DIR` は試験セッションと同じ実 config dir のまま。config は `session_launcher` に `root_dirs` だけを書いた (組み込みの起動コマンド)
  - 試験セッションは一時ベースの空ディレクトリで `--name "🤖ccmsg-verify-restart-form" --model haiku --effort low` と daemon と同じ `CCMSG_*` を付けて hyoui の下で起動した (継いだセッションの変数は落とした)。1 turn 走らせると daemon に登録され、Status タブに「再起動」が出た
  - webui は `playwright-cli` で 1280×900 と 390×844 で開いた
  - Session Search を実 config dir から離すために daemon の `HOME` を一時ベースに向けた方を取った。そのため resume した claude は認証できない (下の「試験の環境に由来すること」)

## 判明した事実

| 確かめたこと | 結果 |
|---|---|
| 押した時 | 危険ゾーンのボタン行の下にフォームが開いた。textarea の値は既定文そのまま (117 文字)、focus は textarea、選択は無く caret は末尾 (`selectionStart` = `selectionEnd` = 117)。ボタン行の「再起動」は disabled、`aria-expanded="true"` |
| 見た目 (1280px) | textarea は composer と同じ `.session-input-textarea` の見た目 (枠・角丸・7rem の高さ)、幅は危険ゾーンいっぱい (969px)。下に [再起動] [キャンセル] が危険ゾーンのボタンと同じ見た目で並ぶ |
| 見た目 (390px) | textarea は 366px で横にはみ出さない (`scrollWidth` 390)。Status タブの末尾まで送ると、右下の composer FAB が textarea の右下 (resize のつまみ) に重なっていた。`.status-view` の下の余白を FAB の大きさと位置の分だけ取るように直し、直した後は末尾まで送るとフォームの下端 (754px) が FAB の上端 (774px) より上に来た |
| Esc | フォームが閉じ、ボタン行の「再起動」が押せる状態に戻った |
| 内容を足して送る | 既定文の末尾に改行と `検証: フォームから足した行` を足して [再起動] を押した。daemon.log は `session_launch: by=user … resume=<sid> prompt_bytes=230 exit_code=0 …` と `session_restart: session_id=<sid> pid=<旧 pid> terminated=true exit_code=0` |
| resume | 旧 pid は居なくなり、同じ sid の `sessions/<pid>.json` が新しい pid で現れた。新しいプロセスの argv は `claude --model haiku --effort low --name 🤖ccmsg-verify-restart-form --resume <sid>` (prompt は argv に無く stdin で渡る) |
| prompt | transcript の末尾の user 行の本文は、既定文 + 改行 + 足した行 (+ 末尾の改行) で、フォームで送った内容そのものだった |

## 試験の環境に由来すること

- daemon の `HOME` を一時ベースに向けたので、組み込みの起動コマンドが起こした claude も同じ `HOME` を継ぎ、resume した turn は `Your apiKeyHelper script is failing` の synthetic な assistant 行で終わった。resume と prompt の確認には影響しない
- resume した claude の環境 (`ps -E`) には `CCMSG_*` が無く `HOME` は一時ベースのもので、隔離 daemon には戻ってこなかった (daemon.log にその後の sidecar の行が無い)。結果の文 (「再起動しました」) が戻ったパネルに出ることは [findings 2026-10-25-session-restart-verify](./2026-10-25-session-restart-verify.md) と DOM のテストで見ている

## 未検証

- 押している間 (フォームの中が disabled で、ボタン行が「再起動中…」) の表示は、restart の間に Status のパネル自体が一度消えるので実ブラウザでは見えなかった。DOM のテスト (`packages/webui/test/status-restart.dom.test.ts`) で固定した
