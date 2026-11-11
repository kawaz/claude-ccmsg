---
title: tool の send / peers の入力を絞る (send の宛先は session_id だけ、peers の絞り込みは cwd_prefix だけ)
status: open
category: task
created: 2026-11-11T21:01:16+09:00
last_read:
open_entered: 2026-11-11T21:01:16+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered:
discard_reason:
pending_reason:
close_reason:
blocked_by:
origin: kawaz の指示 (2026-11-11)
---

# tool の send / peers の入力を絞る (send の宛先は session_id だけ、peers の絞り込みは cwd_prefix だけ)

## 概要

エージェントが使う tool の `send` と `peers` から、使われていない引数を消す。kawaz の裁定 (2026-11-11): `peers` の `name`、`send` の `name` と `pid`、`send` の `cwd` をスキーマから削除する。`peers` の出力の `pid` の表示も消す。

## 背景

過去の transcript の集計 ([findings 2026-11-11-peers-tool-usage](../findings/2026-11-11-peers-tool-usage.md)): `send` 387 回のうち `session_id` 宛てが 381 回、`cwd` が 5 回、`name` が 1 回、`pid` が 0 回。`peers` 64 回のうち `cwd_prefix` が 40 回、引数なしが 18 回、`name` が 3 回。`cwd` 宛ては同じ cwd の全セッションに届くので、届く相手を見ないまま送ることになる。`peers` を `cwd_prefix` で引いてから `session_id` で送れば、届く相手を見てから送れる。CLI に cwd 宛ての送信は無い (`ccmsg notify` の宛先は `--self` と `--sid` だけ)。CLI のスクリプトから cwd で宛てる用途が要るようになったら、その時に CLI の側に足す。

## やること

- tool `send` の入力を `session_id` / `text` / `agent_id` だけにする (`name` / `pid` / `cwd` を消す)
- tool `peers` の入力を `cwd_prefix` だけにする (`name` を消す)。消すのは入力 (絞り込みの引数) だけで、出力の各行の `name: "…"` と `cwd: "…"` は残す (どのセッションかを見分ける手がかり)
- `peers` の出力から `, pid: 123 / 456` の表示を消す (`send` の `pid` 宛てのための表示だった)
- `peers` の出力の先頭の文「送れる相手のセッション (send には session_id・name・cwd をこのまま書く):」を、`session_id` で宛てる形に直す。`send` の結果の文で `name` / `cwd` で宛てる前提のもの (`sendResultText` の「相手の session_id・name・cwd を peers で確かめて送り直す」等) も合わせる
- daemon の op `send_message` / `peer_list` の宛先の解決からも `cwd` / `name` / `pid` を外す (使う側が tool だけなので op にも残さない)。消す前に、ほかに使っている所が無いかを確かめる
- 消した引数を渡された時の断り方 (`refusesFieldsOf` の文) を今の形に合わせる
- skill (`skills/ccmsg/SKILL.md`) の `send` と `peers` の節を書き直す
- `docs/decisions/DR-0039-all-mods-and-typed-tools.md` §3 の「宛先は部分指定で解決する」の記述を今の形に書き直す (経緯は書かない)
- tool の入力が変わって hooks の bundle が変わるので、PROTOCOL_VERSION の minor を上げる

## こちらでは触らないもの

claude-rules-personal の `reference/session-state/handoff.md` に「`send` は新の `session_id` で宛てる (`cwd` で宛てると旧以外の同 cwd のセッションにも届く)」等、cwd 宛てに触れた文がある。rules のリポなので触らず、kawaz に文案を出す。

## 受け入れ条件

- [ ] `send` に `name` / `pid` / `cwd` を渡すと、何もせずに断られる。`session_id` (と `agent_id`) では今までどおり届く
- [ ] `peers` に `name` を渡すと断られる。`cwd_prefix` と引数なしは今までどおり。出力の各行は `session_id` / `name` / `cwd` と、送れない時の注記
- [ ] skill と DR-0039 §3 が今の形と合っている
- [ ] 全テストと lint が通り、PROTOCOL_VERSION の minor が上がっている
