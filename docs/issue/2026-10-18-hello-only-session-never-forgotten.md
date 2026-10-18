---
title: hello で登録されたが agents poll に一度も出ない sid が忘れられず peers に残り続ける
status: open
category: bug
created: 2026-10-18T16:16:06+09:00
last_read: 2026-10-18T16:21:48+09:00
open_entered: 2026-10-18T16:16:06+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered:
discard_reason:
pending_reason:
close_reason:
blocked_by:
origin: issue-batch-3 (worker、2026-10-18)
---

# hello で登録されたが agents poll に一度も出ない sid が忘れられず peers に残り続ける

## 観測

- daemon の registry (daemon.sessions) から session を消すのは、syncSessionsFromAgents が agentsSeen に載せた sid が poll から消えた時 (forgetSession) と session_kill だけ。hello (role session) で registerSession された sid が一度も agents poll に出なければ agentsSeen に入らず、daemon が生きている限り peers (webui のサイドバー / `ccmsg peers`) に残る。send / peer_list は registry ではなく liveRuns (harness の sessions/*.json と pid) から解決するので、そちらには出ない。
- 実例 (2026-10-18、隔離 daemon): 検証用に架空の sid `00000000-0000-4000-8000-0000000000fe` で `ccmsg sidecar peer-list` を叩いたところ、この sid が peers に `connected_at` 付きで残り続けた。harness の死んだ session を sidecar が再起動後の daemon に名乗り直した時も、同じ経路で `input_readiness: no_module` の行が残った (sidecar 側は stdout の socket の EOF で去るよう直したが、registry 側の性質は残る)。

## 対応候補 (裏取りしてから採否を決める)

- poll で N 回続けて見えない (その config dir が答えた round で) hello 由来の sid を忘れる
- hello の時点で `claude agents` の行に居ることを登録の条件にする (居なければ registry に入れず、要求だけ処理する)
- いずれも、poll が config dir を答えなかった round や、hello 直後で poll がまだ拾っていない新しいセッションを誤って消さない条件が要る
