# direct-delivery-migration: メッセージ配送を subscribe 常駐から単体 ccmsg の peer socket 注入へ移行

- Date: 2026-09-26

## 何をしていたか

Claude Code の Monitor tool から `persistent` オプションが無くなり、`ccmsg subscribe` を Monitor で常駐させて Claude Code セッションへメッセージを配送する経路が使えなくなった。代替として、単体の ccmsg (別リポ) が Claude Code の peer messaging socket (`<config home>/sessions/<pid>.json` の `messagingSocketPath`) へ auth フレームと user フレームを直接書き込む配送経路に切り替えた。この経路は受け手のプロセス常駐を必要とせず、配送された内容が Claude Code の transcript にそのまま残る。

## ハマり所 → 解決策

### 配送形が subscribe の `<task-notification><event>` と異なる

- 現象: 単体 ccmsg 経由の受信は `type:"user"` 行 (`isMeta:true`, `promptSource:"system"`, `origin.kind:"peer"`) の文字列 content に `<cross-session-message ccmsg-mid=… ccmsg-from=…>` 封筒として載る。TL (transcript viewer) と daemon (session-user-input / session-dump) はこれを room を介さずそのまま描く必要がある
- 原因: 配送経路が変わった以上、受信側の照合パターンも作り直しが要る
- 解決: 照合パターンを `packages/protocol/src/ccmsg-direct-transcript.ts` の 1 モジュールに集約し、webui と daemon の双方がそこを参照する形にした (change id `vxovmvlkppkv`)。詳細な封筒仕様は `docs/decisions/DR-0027.md` §6 Addendum 2026-09-26 参照

### daemon が接続断をセッションの終了と誤認する

- 現象: 常駐前提が崩れたことで、セッション側の接続が切れただけの状態と実際の終了を区別する必要が出た
- 原因: 旧経路では接続の有無 ≒ 生存だったが、新経路では受け手が常駐しないため接続断は普通に起きる
- 解決: 接続の有無をセッションの生存と見なさない設計に変更。切断では entry を消さず、`session_kill` の終了確認でのみ忘れる (change id `pyzsnznxrltq`)

### hooks / SKILL の案内が旧経路のまま

- 現象: `hooks/session-start.ts` と SKILL.md が「subscribe を常駐させて Monitor で受ける」前提の案内・検査を持っていた
- 解決: 送受信の案内を peer 注入経路に切り替え、subscribe 常駐の案内と検査を削除 (change id `ollsvxmwzvzs`)。加えて `say` shim を launcher 絶対パス埋め込みに変更し、SessionStart で daemon 自体も起動するようにした (change id `ptuxutxrpwwz`)

### `hooks/session-start.ts` の doc comment がジョブ数とずれる

- 現象: モジュール冒頭コメントが「Three jobs:」のまま (a)〜(d) の 4 項目に増えていた
- 解決: 「Four jobs:」に修正

## 議論の要点

単体 ccmsg 経由の受信・送信・PushNotification をどう TL / daemon に反映するかは、Bash tool_use の command 文字列パターンマッチ (`ccmsg post|reply|notify` の呼び出し検出) と tool_result の形 (`{}` / `{"delivered":…}` で送信済み、`{"ok":…}` は room CLI 応答として対象外) に依存する設計にした。これは DR-0027 §4 Addendum で既に一度「パターンマッチは壊れやすい」と反省した経緯があるため、照合ロジックを 1 モジュールに集約して「形が変わったらここだけ直す」構造にすることで同じ轍を避けた。

## 続報 2026-09-28

u1 の webui 投稿 (= room msg 一般) を宛先セッションへ届ける注入を daemon 本体に実装した (change id `qwyqnpovmmtp` / `sqmvystxqsyz`)。`deliver` / `deliverNewRoom` が結果を待たずに `peer-inject.ts` の `PeerInjector` を呼び、成否は log にのみ残す。subscribe 配信とは独立した経路として並行に走る。詳細は `docs/decisions/DR-0034-peer-socket-injection.md`。

`say` shim と `bin/say` は復旧せず削除する方針に変更した (change id `vuwqmxlv`)。音声通知は Claude Code の PushNotification を別 plugin の hook が扱う形に統一されたため。既存の `~/.local/bin/say` の旧 shim は用済みで、ユーザが手元で削除する対象。

## 次にやること

- [ ] daemon 再起動までは、kill されずに終わったセッションが一覧に残り続ける

## 関連

- `docs/decisions/DR-0027.md` §6 Addendum 2026-09-26 (受信封筒の正本)
- `docs/decisions/DR-0034-peer-socket-injection.md` (daemon 自身の注入の正本)
- change id `ollsvxmwzvzs` / `ptuxutxrpwwz` / `pyzsnznxrltq` / `vxovmvlkppkv` / `qwyqnpovmmtp` / `sqmvystxqsyz` / `vuwqmxlv`
