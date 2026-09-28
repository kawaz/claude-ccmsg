---
title: plugin を v1 daemon を起こすだけの hook に削る (SKILL・案内・subscribe 誘導を全部消す)
status: open
category: task
created: 2026-09-28T16:18:55+09:00
last_read:
open_entered: 2026-09-28T16:18:55+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered:
discard_reason:
pending_reason:
close_reason:
blocked_by:
origin: kawaz/ccmsg (v2, クロスプロジェクト起票)
---

# plugin を v1 daemon を起こすだけの hook に削る (SKILL・案内・subscribe 誘導を全部消す)

## 概要

kawaz 裁定 2026-09-28 (ccmsg 統括との会話): v1 (claude-ccmsg) の SKILL や hook 類はもう不要で、v1 は webui のために daemon が生きていればよい。daemon の起動は launchd でなく hook (ユーザスペース) のままにする。理由は launchd 系譜からの起動だと TCC / FDA の確認ダイアログ等が面倒になるため。hook は「daemon を起こすだけ、コンテキストはゼロで勝手にやる」。

やること:

1. SessionStart hook は ensure-daemon (接続失敗 → spawn) だけを行い、stdout に何も出さない (additionalContext / 案内文を消す)
2. UserPromptSubmit hook を外す (subscribe の催促・未読案内が役目だった)
3. skills/ccmsg (SKILL) を削除。CLI の `subscribe` サブコマンドも案内先が無くなるので削除候補
4. hooks.json を SessionStart だけにする
5. README / docs の「セッション間メッセージ」の説明を「v1 daemon は webui のためだけに常駐する、セッション間の配送は kawaz/ccmsg (v2) が担う」に改める

## 背景

ccmsg 統括が 2026-09-28 に観測した事実:

- personal 面で `claude-ccmsg@claude-ccmsg` と `ccmsg@ccmsg` (v2 daemon 生成) の 2 plugin が有効で hook が二重に走る
- v1 の hooks.json は SessionStart / UserPromptSubmit のみで SessionEnd は無い
- v2 は v1 daemon を起動する経路を持たない (src に claude-ccmsg 参照なし) ので、v1 plugin を丸ごと外すと v1 daemon の起動元が無くなる
- v1 CLI に daemon / service サブコマンドは無い (内部の `daemon run` のみ)
- 今日 webui に 3 日間 waiting のまま残った sid ad29515c は、v1 の `ccmsg subscribe` を Monitor で張った turn の途中で死んだセッションで、古い案内が残骸を作った例

## 受け入れ条件

- [ ] 新しいセッションを開いても plugin 由来の文言がコンテキストに 1 行も入らない
- [ ] v1 daemon が落ちている状態でセッションを開くと daemon が起きる
- [ ] hooks.json に SessionStart 以外が無い

## TODO

<!-- wip 時のみ -->
