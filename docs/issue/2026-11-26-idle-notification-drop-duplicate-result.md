---
title: "teammate の待機通知の result を、報告が別に届いている時は落とす"
status: open
category: idea
created: 2026-11-26
origin: "kawaz の案 (2026-11-26)"
---

# teammate の待機通知の result を、報告が別に届いている時は落とす

teammate の待機通知 (`idle_notification`) は、その turn の最後に teammate が本文として書いた文を `result` に載せて統括に届く。teammate が SendMessage で報告を送ってから止まると、統括は同じ話を 2 回読む (SendMessage の報告と、待機通知の `result`)。`result` は長く、context を食う。

通知そのものは届かせ、中身をほぼ空にする (kawaz 2026-11-26)。

## 分かっていること

- SendMessage の報告と `result` は同じ話だが、文は別物 (`result` は SendMessage の後の締めの文で、言い回しを変えた要約になっている)。文字の一致では判定できない
- 待機通知が届く event (`session.receive`) で `text` を書き換えると、書き換えた文が teammate の封筒の中身として会話に入る ([findings](../findings/2026-11-26-idle-notification-events.md))

## 案

中身の比較でなく出来事で決める。その teammate が、前の待機通知より後に統括へ SendMessage を 1 通でも送っていたら、待機通知の `result` を落とす (`from`・`idleReason` 等は残す)。送っていなければ `result` はそのまま (唯一の報告なので)。

## 悪い面

- SendMessage で途中経過だけ送り、結論を本文にだけ書いて止まった teammate の結論が落ちる (本文は teammate の transcript に残る)

## 着手の前に確かめること

- `session.receive` で `result` を落とした時に、通知の turn が今までどおり起きるか
- TUI と webui の描き方 (「Teammate finished」の表示) が変わらないか
- teammate ごとに「前の待機通知より後に SendMessage が届いたか」を module が判定できるか
