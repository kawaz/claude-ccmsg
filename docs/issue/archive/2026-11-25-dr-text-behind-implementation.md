---
title: "DR の本文が今の実装より古いままの所 (classic hook・subscribe・ensure-daemon の前提)"
status: resolved
category: task
created: 2026-11-25
origin: "自リポ TODO (DR-0066 の起草の時に実装と照らして見つけたもの)"
close_reason: documented
---

# DR の本文が今の実装より古いままの所

DR-0066 の起草で今の作りを実装と照らした時に見つかった、DR の本文が実装より古いままの所。文書の側を今の実装に合わせる (実装の側が決まりから外れていると分かったものは、文書を直さずに不具合の候補として挙げる)。

## 対象

- **DR-0002 §2「起動経路」**: 「CLI / sidecar は接続前に ensure-daemon」「SessionStart hook・ターン毎 hook も同じ ensure を叩く」と書く。今、daemon を起こすのはセッションの開始 (`ccmsg sidecar begin`) と人の CLI だけ。サイドカーは起こさずに繋ぎ直し、tool も起こさない (DR-0035 §3、DR-0046 §6)。command hook は無い (DR-0039 §1)
- **DR-0002 §5「Crash 回復」**: 「次のクライアント接触 (ターン毎 hook 含む) で再 spawn」「hook の try/catch」と書く。ターン毎の hook は無い
- **DR-0002 §4 の Version mismatch**: 「plugin update 直後の『新 CLI vs 旧常駐 daemon』はこれで自動解消する」と書く。置き換えるのはセッションの開始だけ (DR-0046 §6) なので、次のセッションが始まるまで古い daemon が残る
- **DR-0029 の追補「subscribe 経路の互換を切る意図的な変更」**: session の `subscribe` を前提にした節のまま (「`PROTOCOL_VERSION` は 1 のまま」「稼働中の subscribe client」)。今の major は 2 で、session の subscribe は無い
- **DR-0035 §3・§5**: classic の event を前提にした記述が残る (`classic.UserPromptSubmit` で受け付けを確かめる、effort は `classic.Stop`、`classic.SessionStart` の後に読み直す、「既存の SessionStart command hook はそのまま動く」、API error は module のものだけを使う)。hooks に `classic.` は 1 つも無い
- **DR-0039 §4**: 「`ccmsg sidecar send` は…新しい op (`send_message`) に置き換える」の項目が、CLI のコマンドとして書かれたまま。`send` は `POST /op` で、CLI の `sidecar send-message` は無い (DR-0046 §7)
- **DR-0039 §3 の「名前と引数」**: tool を `send` / `say` / `peers` / `launch` の 4 つと書く。実装が登録するのは 6 つ (`permit`、`comment_reply` はそれぞれ DR-0040・DR-0062 が正本)
- **DR-0039 の Consequences**: 「実装時に決める」のまま残る項目がある (state file の名乗りの渡し方、要る Claude Code の最低版の示し方)。今の実装がどうしているかは確かめていない
