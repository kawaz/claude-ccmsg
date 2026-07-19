# DR-0017: `ccmsg reply` (daemon 仲介の返信) + 応答経路指示

- **Status**: Accepted (2026-07-15、REPLY-Q1=a / Q3=a / Q4=a 裁定)
- **Date**: 2026-07-15
- **前提**: [DR-0003](./DR-0003-wire-protocol.md) の post semantics、[DR-0011](./DR-0011-to-delivery-filter.md) の to=配信フィルタ、[DR-0014](./DR-0014-1on1-room-and-reply-via.md) の reply_via (本 DR が置換)、[DR-0016](./DR-0016-storage-event-seq.md) の seq

## 1. Context / 動機

DR-0014 の `reply_via` は「agent が読んで従う hint」だったが、実運用初日に
**hint を読めても従わない**失敗が観測された (r17 mid=16、本リポ担当セッション
自身が reply_via:"tl" を無視して room に post し続けた)。原因の内省 (r17
mid=17-18 の議論):

- LLM は JSON field を「データ」として処理し「自分への行動指示」として
  内面化しにくい。msg 内容 (要望) に注意が向くと metadata は素通りする
- 宛先構成の記法 (`r10u1a32a35`) は agent に宛先計算をさせないための情報
  だが、そもそも**計算自体を daemon に移せば wire で運ぶ必要がない**

kawaz 提案 (r17 mid=16,19): 返信は `ccmsg reply` で msg を指して送り、
daemon が宛先を構成する。subscribe が届ける msg には jsonl 行 + 改行 +
**具体的なコマンドを含む自然言語の指示文 1 行**を添える。

## 2. Decision

### 2.1 `ccmsg reply <rNmN> <msg>` (REPLY-Q3=a)

- 新 CLI コマンド。`post <room> <msg>` と同じ positional 慣習
- `<rNmN>` = 返信対象 msg の room + mid (例: `r17m16`)。パースは
  `/^(r\d+)m(\d+)$/` — room id は DR-0006 の `r<N>` namespace なので曖昧性なし
- 送信 identity は post と同じ解決 (sid 必須、u1 masquerade 防止も同じ)

### 2.2 wire: `ReplyRequest` (daemon が宛先構成、REPLY-Q1=a)

- `{ op: "reply", room, mid, msg }` を追加
- daemon は対象 msg を room log から引き、**`to` = 元 msg の from +
  (元 msg の to − 返信者) + u1** で post 相当の append + deliver を行う
  (SKILL の暗黙応答ルール 1-4 の機械化)。u1 は DR-0013 broadcast の
  agent post 制約も自然に満たす
- 元 msg の from が返信者自身なら `self_reply` error (自分への返信は無意味)
- 対象 mid が存在しない room / msg は `msg_not_found` error
- 返信として append される MsgEvent に **`reply_to: "rNmN"`** を記録
  (スレッド表示の将来素材、storage 上の事実)

### 2.3 配信 hint: `reply_via` → `reply_to` (REPLY-Q4=a)

- 配信時の per-recipient hint field を `reply_to` に改名し、値を 3 形に縮退:
  - `"rNmN"` — この msg へ `ccmsg reply rNmN <text>` で返信せよ
    (自分が受けた msg の room+mid そのもの)
  - `"tl"` — 通常のアシスタント応答 (transcript 出力) で返せ。room に
    post/reply しない (1on1 room の u1 発 msg、DR-0014 §2.4 の tl と同じ)
  - `"none"` — 返信不要 (archive 済み room の惰性 msg 等)
- DR-0014 の routing 記法 (`r10u1a32a35`) は**廃止** — 宛先計算が §2.2 で
  daemon に移ったため、受信者は宛先を知る必要がない
- §2.2 の storage 上の `reply_to` (返信元 pointer) と配信 hint の `reply_to`
  (返信手段) は**同名別義にしない**: 配信時、storage の reply_to はそのまま、
  hint は従来 reply_via と同じく配信時 injection。衝突するため **hint field
  名は `reply_hint`** とする [提案: kawaz の「reply_to にする?」は hint の
  改名意図と解釈したが、storage pointer と両立させるための命名調整]

### 2.4 指示文行 (kawaz r17 mid=19 の形)

- subscribe の stdout で、**msg event の jsonl 行の直後に平文 1 行**を出す:
  - `reply_hint: "rNmN"` → `返信用コマンド: ccmsg reply rNmN --msg <text>`
  - `reply_hint: "tl"` → `返信: この room に post せず、通常のアシスタント応答 (transcript 出力) で返す`
  - `reply_hint: "none"` → `返信不要`
- 平文行は CLI (subscribe) が reply_hint から生成する — daemon は構造化
  field だけ運ぶ (wire を汚さない、webui は field を直接読む)
- **`--raw` オプションで平文行を抑制** (jq 等の厳密な JSONL 消費者向け)。
  Monitor 経由の AI 消費が default なので指示文行あり側が default
- msg 以外の event (member/title/archive/...) には付けない

### 2.5 REPLY-Q2 (tl 経路への reply 呼び出し) [提案]

- `reply_hint:"tl"` の msg に `ccmsg reply` した場合: **error で弾く**
  (`reply_via_tl` error、「この msg への返信は transcript 出力で行う」を
  error msg で案内)。間違った経路を選んだ瞬間に矯正が入る (hint 素通り
  問題への構造的対策)。※ Q2 は明示裁定前のため実装は error 側に倒す
  (受理側への変更は後から互換に足せるが、逆は挙動変更になる)

### 2.6 互換

- `reply_via` field は**即時削除** (追加 v0.32.0 から 1 日、外部消費者なし、
  SKILL.md/webui が唯一の読者)。SKILL.md / webui / テストを同 commit で追従
- 旧 client (reply コマンドなし) は従来通り post で返信できる — reply は
  追加経路であり post を破壊しない

## 3. 却下案

- **reply_via 完全削除 + 指示文行のみ** (REPLY-Q4-b): 指示文は LLM に効く層、
  field はコード (CLI の文生成・webui 表示・テスト) が読む層で役割が違う。
  field を消すと CLI が指示文を組み立てる材料が消える
- **指示文行を daemon が生成して wire に載せる**: 表示文言の変更のたびに
  daemon release が要る + webui には不要な payload。CLI 生成が適所
- **`--to rNmN --msg <text>` 形** (REPLY-Q3-b): post と positional 慣習を
  揃える方が CLI 全体の一貫性が高い (kawaz Q3=a 裁定)

## 4. 受け入れ条件

- [ ] `ccmsg reply rNmN <msg>` が元 from + (元 to − 自分) + u1 宛の msg を
      append し、`reply_to: "rNmN"` が storage に残る
- [ ] 自分の msg への reply / 不在 mid への reply が error
- [ ] `reply_hint` が rNmN / tl / none の 3 形で配信される (routing 記法が
      消えている)
- [ ] tl の msg への reply が error + 案内文
- [ ] subscribe stdout: msg 行直後に reply_hint 対応の指示文行、`--raw` で
      抑制、msg 以外の event に付かない
- [ ] webui CcmsgBubble / transcript-model が reply_hint 追従 (reply_via
      参照の残置なし)

## 5. Addendum: 実行指示 `reply_via` への統一 (2026-07-19)

受信 agent が値の意味を解釈せず、そのまま行動できるよう、§2.3 の三値 hint と
§2.4 の CLI 後付け平文行を次の単一フィールドに置換する。

- 通常の返信: `reply_via: "Use \`ccmsg reply rNmN <msg>\`"`
- transcript 応答: `reply_via: "Reply in your normal assistant response (the user reads your transcript)"`
- 返信不要: `reply_via: "No reply needed"`

`reply_via` は従来と同じく配信時に受信者ごとに注入し、room jsonl には保存しない。
CLI `subscribe` は daemon の JSONL をそのまま出力し、日本語の返信案内行を追加しない。
平文行の抑制専用だった `--raw` も削除する。これにより JSONL と agent 向け指示が
同じ frame 内で完結する。

長文本文の取得指示も同じ参照表記に揃え、`msg_via` は
`Use \`ccmsg read rNmN\`` とする。CLI `read` は `rNmN` と `rNmN,mN` を受理し、
既存の `<room> <mids>` 形式も維持する。webui は `msg_via` frame の `(r, mid)` を
DR-0027 の daemon read 復元経路へ渡し、保存済み本文を表示する。
