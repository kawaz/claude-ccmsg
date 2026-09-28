# DR-0027: TL の ccmsg メッセージを daemon 一次情報で完全復元 (断片復元の廃止)

Status: Accepted (kawaz r26 mid=122 が方針を直接指定)
Date: 2026-07-18
Sponsor: kawaz r26 mid=122

## 1. 背景

TL 上の ccmsg メッセージ表示は現在 transcript の断片 (subscribe event の埋め込み JSON) から
復元しており、harness truncation 由来の切り詰め・room 欠落を救済 parse で凌いでいる
(v0.42.1 / v0.53.1 の対症修正)。しかし **daemon が rooms/*.jsonl に一次情報を持っている**
のだから、transcript からは (r, mid) の同定だけ行い、本文は daemon から完全版を引くべき
(kawaz)。

さらに AI 自身の post/reply は tool result に {ok, room, mid} が返っており transcript に
載っているのに、TL 抽出が tool result を拾っていないため **AI の投稿内容が TL で一切
見えない** — 同じ (r, mid) 参照方式で解決できる。

## 2. スコープ

### 2.1 受信側 (u1/他エージェント発)

- transcript 抽出は (r, mid, from, ts) の**同定のみ**に軽量化。本文が truncated でも
  r+mid が取れれば daemon の read (既存 op) で完全版を取得して表示
- 取得は表示時に lazy + キャッシュ (同じ msg を何度も read しない)。r/mid が取れない
  断片は従来の救済 parse を最終フォールバックとして残す
- daemon 側の追加 op は不要 (既存 read で足りる) — webui が user role で read できる
  ことを確認 (できなければ最小の拡張)

### 2.2 送信側 (AI の post/reply)

- TL 抽出に tool result 経路を追加: Bash tool result 内の ccmsg post/reply 応答 JSON
  ({ok:true, room, mid}) を検出 → (r, mid) で daemon read → **AI 発の ccmsg メッセージ
  として TL にバブル表示** (from は当該セッションの aN)
- tool result の実形 (ccmsg CLI の stdout が tool_result にどう載るか) は実 transcript で
  観測してから schema 確定

### 2.3 やらないこと

- 保存側 (rooms/*.jsonl) の変更なし
- subscribe event の形の変更なし (msg-last カラム順 v0.53.1 はそのまま — 同定情報の
  前方配置として引き続き有効)

## 3. Phase 分割

| Phase | スコープ |
|---|---|
| Phase 1 | webui: (r,mid) 同定 + lazy read + キャッシュ + フォールバック (受信側) |
| Phase 2 | webui: tool result 検出 → AI 発バブル (送信側) |

## 4. Addendum 2026-07-29: §2.2 の実現手段を daemon の軽量エコーに置換 (kawaz r76 mid=74)

§2.2 の**目的** (AI 自身の post を TL にバブル表示する) は維持し、**手段**を差し替えた。
Bash tool result の応答 JSON パターンマッチ (`extractCcmsgToolResultRefs`) は削除。
daemon が自 post を本文なしの軽量エコー (`msg_via` + `echo:true`) として author の
subscribe stream にも配信するようになった (DR-0003 §5 Addendum) ため、自 post は
受信側と同じ `<task-notification>` 経路で transcript に載り、§2.1 の (r, mid) 同定 +
lazy read にそのまま乗る。

**Why**: パターンマッチは CLI 応答 JSON の形に密結合で、v0.80.0 の種別リネームで実際に
壊れた (issue `2026-07-29-self-ccmsg-post-bubbles-missing`)。エコーは protocol 上の
契約なので、TL は「配信された msg を描く」という 1 つの規則だけを持てばよくなる。

## 5. 関連

- kawaz r26 mid=122 (方針)
- v0.42.1 (truncated room 欠落救済) / v0.53.1 (msg-last カラム順) — 本 DR で救済 parse は
  フォールバックに降格

## 6. Addendum 2026-09-26: 単体 ccmsg (peer messaging socket 注入) の受信・送信・PushNotification

メッセージの配送は Claude Code の peer messaging socket へ直接書き込む経路に移った (単体の ccmsg (別リポ) に加え、v1 daemon 自身も同じ経路で注入する。daemon 側の封筒生成・宛先解決の正本は [DR-0034](./DR-0034-peer-socket-injection.md))。この経路では subscribe の `<task-notification><event>` は transcript に載らず、代わりに以下の形が載る。TL と daemon (session-user-input / session-dump) はこれらを room を介さずそのまま描く。照合パターンは `packages/protocol/src/ccmsg-direct-transcript.ts` の 1 モジュールに集約し、webui と daemon の双方がそれを使う (形が変わったらここだけ直す)。

### 6.1 受信 (封筒)

- `type:"user"` 行 (`isMeta:true`, `promptSource:"system"`, `origin.kind:"peer"`) の文字列 content に `<cross-session-message from="ccmsg" from-name=… from-mode="prompting" ccmsg-mid="<instance>/<n>" ccmsg-from="user|<sid>" [ccmsg-reply-to=…]>` 封筒が埋まる。封筒本文の末尾 `Reply with: ccmsg reply …` 行は取り除いたものを本文とする。閉じタグは次の封筒の手前で最後に現れるものを取る (本文中の閉じタグ文字列を許す)
- `ccmsg-mid` / `ccmsg-from` を持たない `<cross-session-message>` (Claude Code 本来の peer message) は対象外
- 受け手がターン実行中に届いた場合は `type:"user"` 行ではなく `type:"attachment"` 行 (`attachment.type:"queued_command"`, `attachment.origin.kind:"peer"`) の `attachment.prompt` に封筒が載る。これも配送行として扱い、ts はその行の timestamp。同じ行の `rendered` (system-reminder) にも封筒が繰り返されるが読まない
- 直前の `queue-operation` enqueue 行にも同じ封筒が載るが、配送行だけを数える
- `ccmsg-from="user"` は人 (TL では u1 の右寄せバブル、境界行、👤 nav 対象。daemon では「最後のユーザ入力」に算入)。sid はセッション発 (TL では fold 内の peer バブル)
- 本文は封筒内に全文あるので daemon read は行わない。dedup キーは mid (`direct-in|<mid>`)

### 6.2 送信 (Bash の `ccmsg post|reply|notify`)

- Bash tool_use の command 先頭 (またはシェル区切りの後) の `ccmsg`・パス付き `…/ccmsg` + `post <sid> <text>` / `reply <mid> <text> [--to <sid>]` / `notify <text> [--about <sid>]`。本文は `'…'` / `"…"` / `\` を剥がす。`$(…)`・バッククォート・heredoc など解釈しない構文は引数文字列をそのまま本文にする。`--help` 呼び出しは送信ではない
- 対になる tool_result が `{}` / `{"delivered":…}` なら送信済み、`{"ok":…}` は room CLI の応答なので §4 の経路に任せて対象外、それ以外 (is_error 含む) は失敗として本文とともに理由を表示。tool_result 未着は送信中
- TL では「このセッション →」の peer バブルとして fold 内に出す。dedup キーは tool_use id (`direct-out|<id>`)。宛先は post の sid、reply の `--to` (無ければ人)
- session-dump では `ccmsg-sent` (`meta.source:"direct"`, `op`, `status`, 失敗時 `error`)。受信は `ccmsg-received` (`meta.source:"direct"`, `mid`)

### 6.3 PushNotification

- tool_use `{name:"PushNotification", input:{message}}` を、1on1 room の `say` と同じ見た目の 📣 バブルとして境界行に出す (`say` の代替となる通知)。既読ボタンは持たない (既読管理の対象外)
