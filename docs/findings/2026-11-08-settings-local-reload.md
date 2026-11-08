# 起動中のセッションは `.claude/settings.local.json` の allow の変更を再起動なしで拾う

- Date: 2026-11-08
- 対象: Claude Code 2.1.319 (対話のセッション、tmux の中)
- 動機: permit の `project_permissions` (DR-0040 §12) が書いた rule が、依頼したセッションに再起動なしで効くかで、セッションへの知らせの文が変わる

## 方法

- 実 config dir (`~/.claude-personal`)、cwd は `scripts/verify-cwd.ts` の pool の 1 つ (空の git リポ)、`--permission-mode dontAsk`、`--name "🤖ccmsg-verify-perms"`。dontAsk は allow に無い操作を問わずに断るので、allow の有無がそのまま実行の可否に出る
- 調べる操作は `touch perm-probe-marker` (書き込みなので read-only の自動許可に当たらない)。model に「1 度だけ実行して、通ったか断られたかを 1 行で」と頼み、画面とファイルの有無で確かめた
- 設定ファイルはセッションの外 (別の shell) から書いた

## 結果

| 手順 | 次の指示までの間 | 結果 |
|---|---|---|
| `.claude/` が無い状態で起動し、実行させる | — | 断られた (don't ask mode の denial) |
| `.claude/settings.local.json` を作り `"allow": ["Bash(touch perm-probe-marker)"]` | 5 秒 | 実行された (ファイルができた) |
| `"allow": []` に書き換え | 1 秒 | 断られた |
| 一時ファイルに書いて `mv` で置き換え、allow を戻す | 2 秒 | 実行された |
| ccmsg の経路: `permit` に `project_permissions: [{ add: "Bash(touch perm-probe-marker)" }]` → webui のバブルの「許可する」→ daemon が書き込み (隔離 daemon、`--plugin-dir` に作業コピー) | 5 秒後に diff の知らせが届き、続けて指示 | 実行された |

起動時に `.claude/` 自体が無くても、作られたファイルを拾った。削除 (allow から消す) も同じく効いた。

## 分かっていないこと

- auto mode (classifier) のセッションで同じことが起きるか。allow の照合は classifier の前で、同じ設定の読み直しに乗るはずだが観測していない
- セッションの中で `/cd` した後に、どのディレクトリの `.claude/settings.local.json` を読むか
