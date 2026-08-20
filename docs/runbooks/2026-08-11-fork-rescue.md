# fork によるコンテキスト切れ救出 / 任意地点 rewind

webui の fork 機能 (v0.97.0、DR 相当の調査は findings
`2026-08-11-checkpoint-rewind.md`) を使った復旧手順。

## fork で出来ること / 失うもの

- 会話履歴: **fork 地点まで完全保持** (元セッションも無傷)
- 失うもの: チームメート/サブエージェントへの SendMessage ハンドル、
  バックグラウンドタスク、Monitor、TODO リスト (いずれもセッション
  プロセス内の状態)。ファイル状態は戻らない (現在のディスクのまま)
- worker の完了報告など「知識」は会話履歴に残っているので失われない

## 手順: コンテキストが尽きたセッションの救出

1. webui でそのセッションの TL を開き、余裕があった時点の user turn を
   クリック選択 (👤 nav)
2. 右のフロートパネル「アクション」タブ → 「ここから fork」
3. SessionCreator が fork テンプレート + fork 元/地点が埋まった状態で
   開くので、prompt に「pre-clear を実行して状態を保存して」等を入れて起動
4. fork 先はコンテキストに余裕がある状態で立ち上がるので、そこで
   pre-clear (状態ファイル書き出し) を実行 → 以後は通常の /clear 復帰
   フローに乗る

## 手順: fork 元との引き継ぎ (両方生きている場合)

同一 workspace を共有するため、fork 直後に ccmsg で fork 元と
認識合わせをする (実例: r116):

- どちらが主担当か決める (kawaz が話しかけている側が自然)
- 非担当側はリポへの書き込みを控える (パス指定 commit でも @ の
  取り合いになるため)
- 旧 worker への操作が必要なら fork 元に代理を依頼する

## CLI 直叩き (webui を使わない場合)

```bash
# 1. 切り詰め済みセッションを作る (print mode、API 呼び出しゼロ)
NEW_SID=$(claude -p --resume <元sid> --fork-session \
  --resume-session-at <地点uuid> --output-format json '/exit' | jq -r .session_id)
# 2. その sid を対話で開く
claude --resume "$NEW_SID"
```

`--resume-session-at` は非公開オプション (daemon が起動時 probe で生存
確認し、非対応版では webui の fork 導線ごと隠す)。地点 uuid は「戻りたい
user turn の直前の assistant レコードの uuid」。

**`--resume-session-at` は print mode 専用**で、対話起動 (`claude --resume ...`
に直接付ける形) では黙って無視されて先端 fork になる。上の二段を守ること
(理由と実測は DR-0018 §3.3.1)。
