---
title: MCP tool send が daemon から `unknown op: peer_send` で拒否される (plugin 0.177.2 のセッション、CLI の post は通る)
status: open
category: bug
created: 2026-10-22T05:19:37+09:00
last_read: 2026-10-23T12:53:15+09:00
open_entered: 2026-10-22T05:19:37+09:00
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

# MCP tool send が daemon から `unknown op: peer_send` で拒否される

利用側 (workboard-personal の管理者セッション) からの報告。フラグ止まりで、裏取りと採否は当事者側で。

## 概要

2026-10-22 00:4x、`mcp__ccmsg-v1__send` (session_id 指定) が 2 回とも次で失敗:

```
ccmsg が送信の結果を返さず、届いたか確かめられなかった: {"ok":false,"error":{"code":"invalid_args","msg":"op: unknown op: peer_send"}}
```

同じ宛先に CLI の `ccmsg post <sid> <text>` は `{"delivered": true}` で通り、相手に届いた (返事あり)。`mcp__ccmsg-v1__peers` は正常に相手を返す。

## 背景

環境:

- このセッションに載っている skill のパス: `~/.claude-personal/plugins/cache/ccmsg-v1/ccmsg-v1/0.177.2/skills/ccmsg` (= plugin 0.177.2)
- plugin cache には 0.192.1 まで並んでいる (セッション起動時の版が古いまま固定されている可能性)
- daemon 側の版は未確認 (`ccmsg version` が plugin の版一覧を出す形だったので読めなかった)

推測 (裏取りしていない): plugin 0.177.2 の `send` が投げる op 名 `peer_send` を、今動いている daemon が知らない (daemon が新しく op 名が変わった、または古くて未対応)。長く生きているセッションほど plugin の版が古いまま取り残される構図なら、互換を daemon 側で持つか、利用側に「plugin が古いので再起動を」と返す案内があると困らない。

利用側のワークアラウンド: `ccmsg post` (CLI) で送る。

## 受け入れ条件

- [ ] 原因 (plugin と daemon の op 名のずれ) を裏取りし、採否を決める
