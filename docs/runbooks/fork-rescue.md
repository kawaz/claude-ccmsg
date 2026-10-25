# Runbook: fork によるコンテキスト切れの救出 / 任意の地点からのやり直し

- Last Updated: 2026-10-25

## 適用ケース

- セッションのコンテキストが尽きかけていて、`/compact` で要約されると困る作業の記憶を、余裕のあった時点の会話から引き継ぎたい
- 会話のある地点から先を無かったことにして、そこからやり直したい

どちらも起動の `fork` で、元のセッションの履歴を指定した地点まで写した新しいセッションを起動する ([DR-0018](../decisions/DR-0018-session-launcher.md))。元のセッションは変わらない。

## 前提

- daemon に `session_launcher` が設定されていること ([session-launcher-setup](./session-launcher-setup.md))。webui の Timeline のアクションに「daemon にセッション起動 (launcher) が設定されていません」と出る時は未設定
- 起動コマンドが `fork` の `resume_at` を [launch-command](../design/launch-command.md) の二段の起動で扱うこと (`--resume-session-at` は対話の起動では黙って無視され、先端まで写される)

## fork で残るもの / 失うもの

- 残る: 会話の履歴 (fork 地点まで)。worker の完了報告など、会話に書かれた知識
- 失う: チームメート / subagent への SendMessage の宛先、バックグラウンドのタスク、Monitor、TODO リスト (どれもセッションのプロセスの中の状態)
- ファイルは戻らない (ディスクは今のまま)

## 手順: webui から

1. webui でそのセッションの Timeline を開き、fork 地点にする項目をクリックして選ぶ。放棄された分岐上の項目は fork 地点にできない (アクションにその旨が出る)
2. フロートパネルのアクションで、どちらかを押す
   - 「この項目まで残して fork」: 選んだ項目までが新しいセッションに残る
   - 「この項目から消して fork」: 選んだ項目より前までが残る (直前の項目が読み込まれていない時は出ない。older を読み込むと出る)
3. 新規セッションのフォームが type `fork` で開き、`resume_session_id` (元のセッション) と `resume_at` (fork 地点) が埋まっている。cwd・model / effort・name も、webui が元のセッションについて知っている分だけ埋まる (知らない欄は空なので埋める)。prompt に「pre-clear を実行して状態を保存して」等を書いて起動する
4. 結果パネルの `exit_code` が 0 なら、`session_id` のリンクが新しいセッションを指す。セッションが立ち上がって daemon に名乗ると中身が出る
5. 新しいセッションはコンテキストに余裕のある状態で始まるので、そこで状態を書き出し、以後は通常の `/clear` からの復帰の流れに乗る

## 手順: エージェントから (tool `launch`)

セッション自身や統括のエージェントが、tool `launch` を `type: "fork"` で呼ぶ。

```json
{
  "type": "fork",
  "cwd": "<元のセッションの cwd>",
  "resume_session_id": "<元のセッションの id>",
  "resume_at": "<fork 地点の transcript の record の uuid>",
  "prompt": "pre-clear を実行して状態を保存して"
}
```

- `resume_at` を書かなければ先端まで写す
- 結果の `exit_code` が 0 なら起動コマンドが正常に終わったということで、`session_id` が新しいセッションの id。立ち上がったかは `peers` に載ったことで確かめる
- `resume_at` の uuid は Timeline で選んだ項目の URL (`/timeline/<uuid>`) から取れる

## 手順: 元のセッションと両方生きている場合の引き継ぎ

元と fork 先は同じ workspace を共有するので、fork の直後に ccmsg の `send` で元のセッションと認識を合わせる。

- どちらが主担当か決める (人が話しかけている側が自然)
- 主担当でない側はリポへの書き込みを控える (パス指定の commit でも @ の取り合いになる)
- 元のセッションの worker への操作が要るなら、元のセッションに代わりに頼む

## 関連

- [DR-0018](../decisions/DR-0018-session-launcher.md) — 起動の入力 (`fork` と `resume_at`)、tool `launch`、webui のフォーム
- [launch-command](../design/launch-command.md) — `fork` の二段の起動
- [session-launcher-setup](./session-launcher-setup.md) — launcher の設定
- [findings 2026-10-25-fork-with-session-id](../findings/2026-10-25-fork-with-session-id.md) — `--fork-session` と `--session-id` / `--resume-session-at` の併用の実測
