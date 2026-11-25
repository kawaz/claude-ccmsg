---
title: "ccmsg dump が、tool の実行中に送った人の発言 (queued_command の行) を出さない"
status: open
category: bug
created: 2026-11-25
origin: "自リポ TODO (TL の同じ行の直しで気づいた)"
---

# ccmsg dump が、tool の実行中に送った人の発言 (queued_command の行) を出さない

## 何が起きるか (コードを読んだだけ。未観測)

エージェントが tool を実行している最中に人が送った文は、transcript に `type:"user"` の行として書かれず、`type:"attachment"` / `attachment.type:"queued_command"` の行 (`origin.kind:"human"`) になる ([DR-0035](../decisions/DR-0035-user-input-via-composer-fill.md) §5)。`packages/daemon/src/session-dump.ts` は `row.type === "user"` の行だけを `isHumanPrompt` に掛けて `kind: "user"` の項目にするので、この行の発言は dump に出ない。

webui の TL は、この行を人の発言として描く ([DR-0058](../decisions/DR-0058-timeline-bookmarks.md) §11。判定は protocol の `queuedPersonPrompt`)。

## やること

- 上を、この行を含む transcript の dump で観測する
- dump も、`queuedPersonPrompt` が文を返す行を人の発言 (`kind: "user"`) として出す。判定を dump の側に別に持たない

## 優先度

低い。`ccmsg dump` は今使われていない (kawaz 2026-11-25)。
