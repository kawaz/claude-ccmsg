---
title: btw を module の fork に替えた後に残った小さい後片付け
status: open
category: task
created: 2026-11-23
---

# btw を module の fork に替えた後に残った小さい後片付け

v0.352.0〜v0.359.0 で btw の fork を、セッションの module が Claude Code の `$.agent.spawn` の fork を起こす形に替え、古い別プロセスの経路を消した (DR-0060)。その時に、動きか protocol が変わるので残したもの。

## 残っているもの

- **`btw_launch_unavailable` の語**: `BtwStartReason` に残っている。fork を頼む時に例外が出た場合だけ出る語で、「起動コマンド」の意味はもう無い。webui の文は「btw の fork を起こせなかった」で、次にすることが書かれていない。語を中身に合う名前に変え、文に次にすることを足す
- **使われなくなった欄**: `UserComment.effort` (`comment_add` は btw の effort を受けて保存するが、fork は使わない。FAB は btw の間 effort を選べなくしてある) と `BtwAnswer.tool` (逐次の読みが無くなったので立たない)。欄と、それを受ける・出す所を消す
- **`btwTargetOf` の cwd の確かめ**: セッションの cwd を realpath で確かめ、分からなければ `session_not_found` で断る。`fork.ask` には cwd が要らない。要らない確かめなら外す
- **`BtwBubble.tsx` のファイル名**: 中身は `BtwCommentBubble` だけになった。中身に合う名前に変える
- **DR-0062 の Status**: 実装の段階 1〜5 は済んだ。未決の U と「測ること」の残りを見て、状態を決める

## 実環境で確かめること (2026-11-23 の時点で未確認)

実物の Claude Code では、module の fork の経路をまだ動かしていない (偽の module を使ったテストと、使い捨てのセッションでの測定 findings 2026-11-23-btw-via-agent-fork の範囲)。

- btw の答えが返り、親への報告でなく直接の答えの文になっているか
- fork が tool を使えるか (ファイルを読む・直す)
- 本体の TL と会話に、fork の終わりの知らせが残らないか
- 長いセッション (Opus / Fable) で、吹き出しの足元の usage の cache の書き込みが小さいか。daemon.log に `comment_btw_cache_miss` が出ないか
- 取り消しで fork が止まるか
- `/compact` と `/clear` の直後の btw が「本体が次に応答した後にもう一度」で止まるか
- module が読み込み直された後、走っていた fork の終わりの知らせが本体に流れないか (`$.agent.list()` の `spawnedBy` を当てにした作りで、型定義だけが根拠)
- 既にある `<sid>.btw.jsonl` が、そのセッションを開いた時にコメントの記録に写り、過去の問答が TL に出るか
