---
title: tool の実行中に送った人の発言 (queued_command の行) が TL の人の発言として描かれず、👤 のフィルタにも出ない
status: open
category: bug
created: 2026-11-22
---

# tool の実行中に送った人の発言 (queued_command の行) が TL の人の発言として描かれず、👤 のフィルタにも出ない

## 観測 (2026-11-22、Claude Code 2.1.330、使い捨てのセッション)

エージェントが tool を実行している最中に FAB (user_prompt の経路) から送った文は、transcript に `type:"user"` の行として書かれない。Enter の時点で `queue-operation` の enqueue の行、tool の結果の後に `type:"attachment"` / `attachment.type:"queued_command"` の行 (`attachment.prompt` が文、`origin.kind:"human"`) が書かれ、続いて `queue-operation` の remove (`reason:"absorbed_mid_turn"`) が書かれる。model には tool_result と同じ user message の中の別の text block として届く。

webui の TL は人の発言を `type:"user"` の行から分類しているので、この行は人の発言の吹き出しとして描かれず、👤 のフィルタ (DR-0058 §11) にも出ない。FAB の未確認の送信の照合 (DR-0035 §5) は、protocol の `queuedPersonPrompt` でこの行からも文を取るようにしてある。

## やること

- TL の分類で、`origin.kind:"human"` の `queued_command` の attachment の行を人の発言として描くか決める (描くなら、吹き出しの位置は行の timestamp = enqueue の時刻か、tool の結果の後か)
- 👤 のフィルタと op `prompt_rows` の分類を同じ判定に揃える (判定を daemon と webui の 2 か所に持たない、DR-0058 §11)
