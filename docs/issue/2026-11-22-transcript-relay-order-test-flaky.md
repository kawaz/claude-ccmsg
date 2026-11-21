---
title: transcript-relay の「同時 CATCH_UP_LIMIT 本まで、小さい順」のテストが全体の実行の中で 1 回だけ順序の assert で落ちた
status: open
category: bug
created: 2026-11-22
---

# transcript-relay の「同時 CATCH_UP_LIMIT 本まで、小さい順」のテストが全体の実行の中で 1 回だけ順序の assert で落ちた

## 観測

- 2026-11-22、別の作業 (webui と docs だけの変更) の worker の `just test` の 1 回目で、`packages/daemon/test/transcript-relay.test.ts` の「runs at most CATCH_UP_LIMIT at once, smallest first」が 473 行の順序の assert で落ちた (期待 `…0004`、実際 `…0003`)
- 同じファイルを単独で 5 回走らせると 5 回とも通り、`just test` の 2 回目も通った
- このテストと実装 (読み直しの queue、小さい順) は v0.300.0 で入った ([DR-0029](../decisions/DR-0029-async-io-principle.md) の追補、[findings](../findings/2026-11-20-catch-up-yield-by-time.md))。テストは gate で止めて決定的に確かめる作りと報告されていた

## 分かっていないこと

- 全体の実行の負荷の下で順序が入れ替わる理由。テストの組み方 (並べ替えの前に走り出す読み直しがある、一緒に頼まれた分を microtask でまとめる所の境界) の穴か、実装の穴 (小さい順が崩れる場合がある) か

## 受け入れ条件

- [ ] 落ちる理由を観測で特定し、実装かテストの穴を直す (期限の延長・skip で緑にしない)
- [ ] 負荷をかけた状態 (全体の実行、または並行に CPU を使う) で繰り返し走らせて落ちないことを確かめる
