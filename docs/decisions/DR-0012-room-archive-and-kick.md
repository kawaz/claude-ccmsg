# DR-0012: room アーカイブ + 強制 leave (kick)

- Status: Accepted
- Date: 2026-07-12
- 起点: kawaz 指示 (2026-07-12、verbatim は §3)

## 1. 決定

1. **archive_room op**: room に ArchiveEvent (`{type:"archive", archived, ts}`) を
   append + broadcast する toggle。last-wins (title と同規則)。権限は set_title と
   同じ (admin User + member session)。**表示整理のためのフラグであって lifecycle
   変更ではない** — アーカイブ済み room も post/配信は従来通り動く。
2. webui: ルームリスト最下部に「アーカイブ」折り畳みセクションを置き、
   `archived: true` の room をそこへ収める。
3. **kick op**: `{op:"kick", room, id}` で member を強制 leave。通常の leave と
   同じ LeaveEvent を append + broadcast。**admin User 専用** (room 内のエージェント
   同士が互いを蹴れる設計は事故源になるため)。再 join / 再 invite の制限は付けない
   (kawaz: 「再joinを制限までは今のとこ不要」)。

## 2. 検討した代替案

- **アーカイブ = 配信停止 / read-only 化**: 却下。用途は「無限に増える room の
  リスト整理」(kawaz) であって room の停止ではない。停止意味論を足すと復帰・
  権限・進行中エージェントへの影響など複雑化する割に、必要になった証拠がない。
- **kick を member session にも許可**: 却下。webui の ✕ ボタン (u1 操作) が用途の
  全てで、エージェント間の強制排除は誤動作・インジェクションの増幅器になる。
  必要になったら権限拡張は互換的にできる。
- **room の物理削除**: 不採用。log は append-only の監査記録 (DR-0003)。

## 3. kawaz 指示 (verbatim)

> ルームのアーカイブができるようにしてください。今だと無限にルームが増える。
> ルームリストの一番下にアーカイブ表示がありクリックでアーカイブ済みがその中に並ぶみたいな感じに。
> ルーム内のエージェントリストですが非アクティブなセッションは打ち消し線やグレー表示するなど。またバツボタンみたいなのでban(強制leave)出来るように際joinを制限までは今のとこ不要、

## 4. 互換性

- ArchiveEvent は StorageEvent の追加 variant。旧 client は未知 type の storage
  イベントを無視する (寛容パース) ため log 互換。旧 daemon には archive_room /
  kick op が無く unknown_op を返すだけ (newer-wins upgrade で収束)。
