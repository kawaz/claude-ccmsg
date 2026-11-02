# 試験用 claude の信頼ダイアログを `.claude.json` の事前 seed で避ける

隔離 `CLAUDE_CONFIG_DIR` + 初めての一時 cwd で `claude --model haiku` を tmux (`tmux -L <name> new-session -d -x 120 -y 30`) で起動し、`capture-pane` で観測した (claude v2.1.316、2026-11-02)。cwd は `mktemp -d` 配下 (`/var/folders/...`、realpath は `/private/var/folders/...`)。

## 観測

| # | `.claude.json` の seed | 結果 |
|---|---|---|
| 1 | 無し | 起動直後にテーマ選択 (`Let's get started.` / `Choose the text style`) で止まる |
| 2 | `projects[<realpath>].hasTrustDialogAccepted = true` のみ | 同上 (テーマ選択で止まる。onboarding 未完了) |
| 3 | `theme:"dark"` + `hasCompletedOnboarding:true` のみ (projects 無し) | `Quick safety check` の信頼ダイアログが出る (`Yes, I trust this folder` 待ち) |
| 4 | #3 + `projects[<realpath>].hasTrustDialogAccepted = true` | ダイアログが出ず prompt 待ち (`❯`) |
| 5 | #3 + `projects["/var/..." (symlink 側のパス)]` | ダイアログが出る (効かない) |

## 分かったこと

- 信頼の key は cwd の realpath。claude 自身が workspace を `/private/var/...` として扱い (起動画面の cwd 表示もこちら)、`/var/...` で書いた seed は一致しない
- 信頼ダイアログの前にテーマ選択の onboarding がある。`theme` と `hasCompletedOnboarding: true` も seed に要る
- 隔離 config dir は keychain も別なので seed 後の prompt には `Not logged in` が出る。ダイアログは出ない (モデル応答が要る検証は別途)

## seed

```bash
cwd=$(cd "$cwd" && pwd -P)
jq -n --arg p "$cwd" '{theme:"dark",hasCompletedOnboarding:true,projects:{($p):{hasTrustDialogAccepted:true}}}' > "$config_dir/.claude.json"
```

testkit に claude を起動する helper は無いため、手順は verify skill にのみ入れた。
