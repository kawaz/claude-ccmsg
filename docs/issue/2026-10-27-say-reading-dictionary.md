---
title: say の読み上げ前に辞書 (TSV) で単語を置換する
status: open
category: design
created: 2026-10-27T10:30:43+09:00
last_read:
open_entered: 2026-10-27T10:30:43+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered:
discard_reason:
pending_reason:
close_reason:
blocked_by:
origin: workboard-personal
---

# say の読み上げ前に辞書 (TSV) で単語を置換する

kawaz 2026-10-27 の提案。利用側 (workboard-personal の管理者) からの起票で、採否と実装は当事者側で。

## 背景

音声通知 (`say`) で英単語・頭字語の読みがぶれる。今は claude-rules-personal の reference `say-katakana.md` と rule `notification-tips` で「エージェントがカタカナに直してから渡す」としているが、rule を読んだセッションしか守れず、新しい単語は毎回初出扱いで、同じ誤読を各セッションが別々に踏む。

## 提案

- `say` が読み上げ前に、辞書で単語を置換する。辞書は TSV (`word<TAB>読み`、`#` コメント可) を ccmsg の設定ディレクトリに置き、kawaz かエージェントが都度足す
- 一致は大文字小文字を無視し、単語の両側を `[_\b]` で区切る (kawaz 2026-10-27)。日本語の文中でも英単語の前後は非英数字なので `\b` が効く。`daemonize` の中の `daemon` には当たらない
- 辞書に無い語はそのまま (初出は仕方ない方針)
- 入ったら、claude-rules-personal 側は `say-katakana.md` と `notification-tips` の該当段落を削除する (利用側でやる)

## 初期値 (kawaz 挙げ分 + say-katakana.md の表)

```
1Password	ワンパスワード
daemon	デーモン
sidecar	サイドカー
plugin	プラグイン
OTP	オーティーピー
URL	ユーアールエル
API	エーピーアイ
CI	シーアイ
PR	ピーアール
jj	ジェイジェイ
Kyell	ケイエール
```

(`1Password` は「いちぱすわーど」、`daemon` は「ディーマン」、`sidecar` は「シデカー」、`plugin` は「プルージン」と読まれる実測あり)

## 決めること

- 辞書の置き場 (ccmsg の config dir か、面ごとか)
- 辞書の編集を `ccmsg say-dict add <word> <reading>` のようなコマンドにするか、ファイル直編集か

## 受け入れ条件

- [ ] 辞書の置き場と編集方法が決まっている
- [ ] say が読み上げ前に辞書置換する
