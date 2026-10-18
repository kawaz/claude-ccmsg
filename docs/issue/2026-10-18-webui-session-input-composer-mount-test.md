---
title: SessionInputComposer をマウントして storage event → 入力欄の配線をテストする
status: open
category: task
created: 2026-10-18T13:37:03+09:00
last_read:
open_entered: 2026-10-18T13:37:03+09:00
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

# SessionInputComposer をマウントして storage event → 入力欄の配線をテストする

## 概要

test-suite-review-fixes の high (1) から切り出した残り (出典 docs/findings/2026-10-14-test-suite-review-fresh-eyes.md #1)。happy-dom の DOM 基盤 (packages/webui/test/dom.ts の withDom、render-hook.ts、timeline-harness.ts) と Timeline / その hook のマウントテストは既にあるが、packages/webui/src/client/components/SessionInputComposer.tsx をマウントするテストは無い。session-input-store.test.ts / composer-attachments.test.ts は pure 関数 (otherTabDraft / storedDraftChange 等) だけを見ており、effect の配線 (storage event を受けてどの handler で restoreDraft を呼ぶか、入力中の欄を別タブの書き込みで巻き戻さないこと、下書きの保存) はマウントでしか確かめられない。

## 背景

docs/TESTING.md の webui 節 (component はマウントして effect の配線まで検証する) に沿って、SessionInputComposer をマウントし、別タブ相当の storage event → 入力欄の文、編集中の入力欄は変えない、入力が下書きとして保存される、を固定する。

## 受け入れ条件

- [ ] SessionInputComposer をマウントするテストがある
- [ ] storage event → 入力欄の反映と、編集中は反映しないことを DOM で確かめている
- [ ] 配線を壊すと落ちることを確認している
