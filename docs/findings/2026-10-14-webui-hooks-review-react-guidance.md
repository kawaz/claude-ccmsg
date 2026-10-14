# webui の hooks を react.dev のガイダンスで点検

- Date: 2026-10-14

## 判明した事実

reviewer-sol-high が `packages/webui/src/client` の hook 558 箇所を react.dev の現行ガイダンス (Effect の濫用・非同期の世代ガード・key) で点検した。high 6 件、medium 4 件、low 1 件。読み取り専用のレビューで、実機・テストでの再現は未実施。

### high (6)

1. `packages/webui/src/client/components/FileTree.tsx:627-640` — お気に入りの永続値を消す。`useState<string[]>([])` の後に読み込み Effect と `saveFavorites(favRoot, favorites)` の Effect が並び、初回 mount の空配列が保存済みを上書きする。favRoot 変更時も旧 root の配列を新 root のキーへ保存する
2. `packages/webui/src/client/App.tsx:331-333` / `packages/webui/src/client/components/RoomView.tsx:266-272` / `packages/webui/src/client/components/Composer.tsx:73-75,265-275` — room を切り替えても送信下書きが残る。RoomView に room 別 key が無く、常時マウントの Composer の text・attachments が次の room に持ち越され、送信先は新しい room.id になる (誤送信)
3. `packages/webui/src/client/components/Timeline.tsx:3418-3433,3450-3464,3490-3506` / `packages/webui/src/client/store.ts:880-904,956-980` — agent A から B へ切り替えた時、A の進行中の transcriptRead が sid だけで `timeline/loaded` を dispatch し、reducer が agent・世代を照合しないため B を上書きする
4. `packages/webui/src/client/components/FileViewer.tsx:776-814,1117-1142` / `packages/webui/src/client/store.ts:1184-1196` — ファイル読み込みの応答に世代が無く、reducer は `fs/file-loaded` を無条件に `tree.file` へ格納する。同一 path の再取得でも逆転しうる
5. `packages/webui/src/client/components/RoomView.tsx:38-44,91-114` / `packages/webui/src/client/store.ts:99-105,682-703` — `#room-mNN` 直リンクが初回ロードで着地しない。アンカー Effect の依存が room ID と mid だけで、履歴が idle の初回は DOM が無く空振りし、履歴到着後に再実行されない
6. `packages/webui/src/client/components/CwdTree.tsx:149-188,190-230` — 全体再取得は cancelled で守るが、展開時の `dirTree([entry.path])` は守らない。フィルタ変更後も同じ path が残れば旧要求の children を `attachDirTreeChildren` で新ツリーへ混入する

### medium (4)

1. `packages/webui/src/client/components/RoomView.tsx:46-89` / `packages/webui/src/client/components/Timeline.tsx:2961-3002,4076-4089,4321-4381` / `packages/webui/src/client/app.css:2324-2331,4388-4413` — フォント・画像・翻訳の伸長を 0/60/300/1000ms の反復 scrollTop / scrollIntoView で追っており、時間外の変化を拾えず手動操作と競合する
2. `packages/webui/src/client/components/Composer.tsx:124-136` / `packages/webui/src/client/components/RoomComposerFab.tsx:33-47` — `onSendingChange` / `onDraftChange` の親通知が Effect 経由で、親の state が一拍遅れる。送信直後の blocked が反映される前に外部 click を拾いうる
3. `packages/webui/src/client/components/UsageStats.tsx:223-259,264-277` — period / fetchDays 更新時、旧 stats と selected を Effect で消すまで新 period で旧集計を描く
4. `packages/webui/src/client/components/FileViewer.tsx:1028-1088` / `packages/webui/src/client/components/Timeline.tsx:3931-3975` (low 寄り) — match 配列から current index へ至る 2 段 Effect chain

### low

- `key={i}` の構造的変動箇所は要件別に精査が要る

## 実用的な示唆 / ベストプラクティス

- 永続化は Effect でなく操作の handler で行い、読み込みは初期化時に済ませる。root のような境界は key で再マウントする (high 1)
- 入力状態を持つ component は、送信先を決める ID (room ID) を key にする。同一 room 内で popup を閉じた場合の下書き保持だけ残す (high 2)
- 非同期応答の dispatch には要求側の identity (agent・path・フィルタ) と世代を付け、reducer か呼び出し側で現在の選択と一致する応答だけ適用する。全体と子階層の要求は同じ世代で管理する (high 3, 4, 6)
- 直リンクのアンカーは、対象メッセージの描画・履歴ロードを契機に未着地のものを一度だけ処理する (high 5)
- 自動末尾追随は CSS scroll anchoring、明示ジャンプ後の伸長は ResizeObserver で扱い、時間刻みの反復スクロールをやめる (medium 1)
- 子と親の state 更新は handler 内で同時に行うか、共有 state を親へ持ち上げる (medium 2)
- period のような入力で派生状態を作り直す場合は、period keyed component で同期的に reset する (medium 3)
- 検索入力 handler で match 配列と current index を同時更新する。DOM 依存のハイライト Effect は残してよい (medium 4)

## 検証の詳細

### 点検の範囲と未実施事項

| 項目 | 結果 |
|---|---|
| 対象 | `packages/webui/src/client` の hook 558 箇所 |
| 基準 | react.dev の現行ガイダンス |
| 実施者 | reviewer-sol-high (2026-10-14) |
| 実機での再現・テスト | 該当なし: 読み取り専用のレビューのため未実施 |
| `SessionInputComposer` の下書き保存 | 対象外: 別 worker が修正中 |

考察: 各指摘はコード読解に基づく。修正に着手する際は、再現手順を実機で確認してから直す。
