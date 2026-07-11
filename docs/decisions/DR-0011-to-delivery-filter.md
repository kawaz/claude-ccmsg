# DR-0011: `to` を mention から配信フィルタへ変更 + drag & drop invite

- Status: Accepted
- Date: 2026-07-12
- 起点: kawaz 指示 (2026-07-12、verbatim は §4)

## 1. 決定

1. `MsgEvent.to` / `PostRequest.to` の意味論を「mention (注意喚起、全員配信)」から
   **「配信フィルタ」** に変更する。`to` 付き msg の subscribe 配信対象は:
   - `to` に列挙された member
   - 送信者自身
   - **admin User (u1) — 常時配信の例外**
2. since replay にも同じフィルタを適用する (offline 中の `to` 付き msg が
   replay で全員に流れたら本末転倒)。
3. storage / `read` / `rooms` は変更しない: イベントは room log に全件残り、
   任意の member が `read` で取得できる。配信されなかった member は mid の
   飛びで「自分宛でない会話があった」ことに気づける。
4. 新 op `invite { room, sid }`: 接続中セッションを既存 room に追加
   (MemberEvent append + broadcast)。webui はセッション行を room チャット
   エリアへ drag & drop して invite できる。権限は admin User + member
   session (set_title と同じ)。既メンバーへの invite は no-op (`already: true`)。

## 2. 背景

`to` は DR-0003/0006 で「attention target であって visibility filter ではない」
と定義され、全 member に配信されていた。マルチエージェント room で 1:1 の
やり取りをすると、無関係なエージェント全員のコンテキストに流れ込む。
1:1 room を都度作る代替は room 増殖と切り替えコストで却下 (kawaz)。

## 3. 検討した代替案

- **private メッセージ機能 (visibility filter)**: storage 段階で隠す案。
  却下 — 「読みたければ読める」開放性を失い、admin 監査面も複雑化する。
  mid 飛び + `read` の pull 型で足りる。
- **u1 も配信絞りに含める**: kawaz の「全員に飛ぶのはコンテキストの無駄」は
  エージェントのコンテキスト浪費が主意図であり、User には同種のコストが
  ない。u1 を絞ると webui のリアルタイム観察 (RoomView は subscribe 駆動)
  が壊れるため例外とした。

## 4. kawaz 指示 (verbatim)

> なるほど、無駄にroomが増えると切り替えも面倒だし、他の人には通知飛ばないようにしよう。全員に飛ぶのはコンテキストの無駄。
> midが飛び板になることで自分以外の会話の存在は気づくかもしれないが能動的に読みに行かない限りは読む必要ないと判断できるはず。読みたいと思えば読むこともできるようになってれば良い。
>
> あとROOMを開いてるときに、再度のSESSIONSにあるセッションをROOMのチャットエリアにドラッグしたら状態できるようになってると楽で良い。

(最終段落の「状態できる」は文脈から「招待できる」と解釈 — §1-4 の drag & drop invite)

## 5. 互換性

- 旧クライアントが `to` 付きで post しても wire 形は不変 (挙動が配信絞りに
  変わるのみ)。旧 daemon + 新クライアントでは従来通り全員配信 (劣化なし、
  newer-wins upgrade で収束)。
- 既存 room log の `to` 付き msg は再解釈されるが、storage 形式は不変。
