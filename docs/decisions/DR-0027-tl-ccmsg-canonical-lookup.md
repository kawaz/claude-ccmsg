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

## 4. 関連

- kawaz r26 mid=122 (方針)
- v0.42.1 (truncated room 欠落救済) / v0.53.1 (msg-last カラム順) — 本 DR で救済 parse は
  フォールバックに降格
