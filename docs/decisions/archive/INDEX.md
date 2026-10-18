# 退避した Decision Records

後続の DR に置き換えられた DR。各ファイルの `Status: Superseded by DR-NNNN` が正本で、現役の文書からはここも各ファイルも名指ししない (置き換え先を指す)。

| DR | 説明 | 置き換え先 |
|---|---|---|
| [DR-0011](DR-0011-to-delivery-filter.md) | room の msg の `to` を配信フィルタにする + セッションの drag & drop による room への招待 | [DR-0036](../DR-0036-retire-rooms-for-p2p.md) §2 |
| [DR-0012](DR-0012-room-archive-and-kick.md) | room のアーカイブ (表示整理フラグ) と、admin による member の強制退出 (kick) | [DR-0036](../DR-0036-retire-rooms-for-p2p.md) §2 |
| [DR-0013](DR-0013-broadcast-room.md) | 全セッションが自動で参加する broadcast room | [DR-0036](../DR-0036-retire-rooms-for-p2p.md) §2 |
| [DR-0014](DR-0014-1on1-room-and-reply-via.md) | 人とセッションの 1on1 room と、msg の応答経路の指示 (`reply_via`) | [DR-0035](../DR-0035-user-input-via-composer-fill.md) §2 / [DR-0036](../DR-0036-retire-rooms-for-p2p.md) §2 |
| [DR-0016](DR-0016-storage-event-seq.md) | room の全 event 型をまたぐ per-room の連番 `seq` (subscribe の再接続 cursor) | [DR-0036](../DR-0036-retire-rooms-for-p2p.md) §2 |
| [DR-0017](DR-0017-reply-command.md) | daemon が宛先を組み立てる room の返信 `ccmsg reply rNmM` と返信行の指示 | [DR-0036](../DR-0036-retire-rooms-for-p2p.md) §1 / §2 |
| [DR-0037](DR-0037-agent-messages-ride-sendmessage.md) | エージェント間のメッセージを SendMessage に乗せ、`ccmsg:` 宛を hooks module が横取りして peer 注入で届ける | [DR-0039](../DR-0039-all-mods-and-typed-tools.md) §3 / §4 |
