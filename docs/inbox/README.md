# docs/inbox/ — kawaz の雑メモ・指示置き場 (先行運用)

kawaz がエージェントの作業とは無関係に、**AI に拾ってほしい雑なメモ・指示**を
雑な名前・雑な文面で置くディレクトリ。

## AI 側の運用

- `jj status` / working copy 確認で本ディレクトリの新規ファイルに気づいたら拾い上げる
- 拾ったら: **すぐ対応する** or **正式 issue 化する** (local-issue plugin の write) のどちらか
- 処理後は**ファイルを削除**する (対応記録は commit message / issue / DR 側に残す。
  inbox に残留させない)
- 急ぎの指示はこの経路に置かれない前提 (急ぎは ccmsg / プロンプト直)。
  拾い上げは「手が空いた時」で良い

## 位置づけ

- `docs/issue/` (local-issue plugin 管理、frontmatter + INDEX + archive) とは別物。
  inbox は plugin 管理外の一時置き場で、常に空が定常状態
- ccmsg リポでの先行運用 (kawaz 裁定 2026-07-16)。良さそうなら
  claude-rules-personal でルール化して他リポへ展開する
