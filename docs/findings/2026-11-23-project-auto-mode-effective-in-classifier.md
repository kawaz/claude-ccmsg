# プロジェクトの autoMode が対話のセッションの classifier の判定に効くか (実機の観測)

- Date: 2026-11-23
- 対象: ccmsg v0.334.0、Claude Code 2.1.330
- 動機: [DR-0063](../decisions/DR-0063-project-auto-mode.md) §10 の実機の確かめのうち、足した `soft_deny` / `allow` が対話のセッションの classifier の判定に効くか。Context では `auto-mode config` の出力で確かめただけで、classifier が実際の判定に使うかは未検証だった
- 方法:
  - auto mode の対話のセッション (このリポの統括、cwd はリポの main) で、webui の Status タブの「autoMode の調整」から kawaz がこのリポ (`repo:github.com/kawaz/claude-ccmsg`) の項目を足し、セッションを再起動 (resume) して、同じ操作を試した
  - ユーザの settings の autoMode は 4 つのセクションとも `$defaults` 入り
  - 再起動したことは、プロセスの起動時刻と `--settings` の引数で確かめた。resume での再起動は会話の文脈に何も残さない

## 判明した事実

- **`allow` の項目が効いた** (観測 1): `jj workspace forget ws-comment-json` が、設定を足す前は auto mode の classifier に止められ (同じコマンドを形を変えずに 3 回: 他のコマンドと並べた 1 回、単独で 2 回。止めた文は `Blocked by fast classifier`)、このリポの allow に「jj workspace forget を main 以外のwsに対して許可する。」を足して再起動した後は、同じコマンドが止められずに通った (`Removed Git worktree for …`)
- **`soft_deny` の項目が効いた** (観測 2): このリポの soft_deny に「$HOMEのls」を足し (`project-auto-mode.json` の更新は 12:37:18)、再起動した後 (claude のプロセスの起動は 12:37:43)、`ls ~ | head -5` が止められた。止めた文は `The server-side auto mode classifier judged this action dangerous (it gave no explanation)`
- 再起動したプロセスの引数の `--settings` は `<stateDir>/launch-settings/<内容の hash>.json` で、中身は次のとおり。項目のあるセクションだけが書かれ、先頭に `$defaults` が入り、`environment` と `hard_deny` は無い

```json
{"autoMode":{"allow":["$defaults","jj workspace forget を main 以外のwsに対して許可する。"],"soft_deny":["$defaults","$HOMEのls"]}}
```

- allow と soft_deny の 2 種類で、プロジェクトの autoMode の項目が対話のセッションの classifier の判定を変えるのを 1 件ずつ観測した

## 切り分けていないこと

- classifier は会話のユーザの発言も読む。観測 2 では kawaz が「HOME の ls を soft_deny に入れてみた」と会話で述べた後に試したので、発言が判定に影響した可能性は消していない
- 観測 1 では、設定を足した後・試す前の kawaz の発言は「autoMode 設定調整してみました」だけで、何を足したかは述べていない
- 発言で触れずに項目だけを足した時の判定は未確認

## 未確認のまま残るもの

- 走っているセッションが settings のファイルを起動の後に読み直すか
- btw の fork が元のセッションの prompt cache を読めるか

## 実用的な示唆

- DR-0063 の §10 のうち「足した soft_deny / allow が classifier の判定に効くこと」は、上の範囲で観測済みとして扱う
- 項目の反映は再起動の後 (DR-0063 §6 の注釈どおり)

## 検証の詳細

| # | セクション | 足した項目 | 試した操作 | 足す前 | 再起動の後 |
|---|---|---|---|---|---|
| 1 | allow | jj workspace forget を main 以外のwsに対して許可する。 | `jj workspace forget ws-comment-json` | 3 回とも止められた (`Blocked by fast classifier`) | 通った |
| 2 | soft_deny | $HOMEのls | `ls ~ \| head -5` | 試していない | 止められた (`judged this action dangerous`) |
