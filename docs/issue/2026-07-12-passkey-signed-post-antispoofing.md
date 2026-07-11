---
title: Passkey 署名による post のなりすまし対策強化
status: open
category: design
created: 2026-07-12T01:42:22+09:00
last_read:
open_entered: 2026-07-12T01:42:22+09:00
wip_entered:
blocked_entered:
pending_entered:
discarded_entered:
resolved_entered:
discard_reason:
pending_reason:
close_reason:
blocked_by:
origin: 自リポ TODO
---

# Passkey 署名による post のなりすまし対策強化

## 概要

kawaz 発案 (2026-07-12): Passkey 登録機能を活用し、`from:"u2"` のような自己申告フィールドだけに頼らない post のなりすまし対策を導入する。post 時に `{自分のID}:{ポストするメッセージBODY}` の UTF8 文字列をチャレンジとした Passkey 署名を一緒に送信し、daemon が署名検証をして登録済み Passkey なら jsonl に `sig:""`, `sigkey:"k1"` を付与する。署名検証の責任は daemon が持ち、jsonl の 1 行を渡せば検証できる CLI サブコマンドも用意する。

kawaz 原文:

> Passkey登録も早めにやりたいところだね。活用方法なんだけど、from:"u2" とかだけだとちょい弱い気がするのですよね。そこで `{自分のID}:{ポストするメッセージBODY}` のUTF8文字列をチャレンジとしたPasskey署名を一緒に送信するのはどうだろうか？daemonは署名検証をして登録済みのPasskeyならsig:"", sigkey:"k1" とjsonlに付けといて署名検証の責任はdaemonが持ってて署名確認したければそのjsonlを1行放り込む形で署名検証できるようなCLIサブコマンドも用意しておけばだいたい安心できるか？

## 背景

現状の `from:` フィールドは自己申告であり、post の送信元詐称を防ぐ仕組みがない。関連 issue `2026-07-12-prevent-u1-masquerade-on-missing-sid` (CCMSG_SID 未設定投稿が u1 名義に化ける問題) が示すように、なりすまし・誤帰属のリスクは既に顕在化している。Passkey (WebAuthn) はブラウザ/OS 標準の署名済み認証手段であり、これを post 単位の署名に転用できれば「誰が本当に送ったか」を暗号学的に検証可能にできる。

AI 評価 (条件付き賛成 + 技術的懸念):

1. **WebAuthn 署名対象の仕様**: 署名対象は challenge 単体ではなく `authenticatorData + SHA-256(clientDataJSON)` の連結。challenge は `clientDataJSON` 内に埋め込まれる値なので、検証には `sig` に加えて `clientDataJSON` と `authenticatorData` の保存が必要 (jsonl に 3 点セットまたはその base64 を付与する形になる)。
2. **リプレイ対策**: challenge を `{id}:{body}` だけで構成すると、同一 body の再送 (リプレイ) が同じ署名で通ってしまう。`ts` か `nonce` を challenge に含めるべき。`mid` は post 前に採番されないため challenge には使えない。
3. **UX 面の検討**: post のたびに Touch ID 等の認証ジェスチャが必要になる。post 頻度次第で煩わしさが出るため、「署名付き post は opt-in (重要指示のみ)」または「post 単位でなくセッション単位 (hello/接続時に一度) の署名」も比較検討の価値がある。
4. **daemon 側の検証責任分離**: daemon が検証責任を持ち `sig`/`sigkey` を jsonl に刻む設計、および jsonl 1 行を stdin に入れて検証できる CLI サブコマンドの提供は、検証可能性の設計として妥当 (賛成)。
5. **関連 issue との関係**: `2026-07-12-prevent-u1-masquerade-on-missing-sid` (SID 無し post の u1 化) は本提案の下位互換的な安価対策であり、本提案はその上位対策に相当する。まず masquerade 側の安価な対策を先行させる価値もある。

## 受け入れ条件

- [ ] kawaz と (2) のリプレイ対策 (challenge 構成: `ts` or `nonce` の採用方式) をすり合わせる
- [ ] kawaz と (3) の署名粒度 (post 単位 vs セッション単位) をすり合わせる
- [ ] WebAuthn 検証に必要な保存フィールド (`clientDataJSON` / `authenticatorData` / `sig` / `sigkey`) の jsonl スキーマを確定する
- [ ] daemon 側の署名検証ロジックと、jsonl 1 行を渡して検証する CLI サブコマンドを実装する
- [ ] `2026-07-12-prevent-u1-masquerade-on-missing-sid` との関係 (先行実施するか、本issueに統合するか) を整理する
