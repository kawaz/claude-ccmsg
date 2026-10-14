// 非同期要求の世代。応答が届く順は要求の順と一致しない (daemon は 1 本の
// 接続の要求を並行に処理する) ので、「どの要求への応答か」を応答の側に持たせ、
// 適用する側が「今の要求か」を照合して古い応答を捨てる。
//
// 使い方は 1 通り:
//  1. 要求を出す時に `nextRequestGeneration()` で世代を取り、要求を受け付けた
//     印 (store の `timeline/loading` / `fs/file-loading`、CwdTree の
//     `fetch-started` 等) と一緒に状態へ記録する
//  2. 応答を適用する action に同じ世代を載せる
//  3. reducer は、記録してある世代と一致する応答だけを適用する。その後に別の
//     要求が始まった (agent / file / フィルタの切り替え、再取得) か、状態が
//     作り直された (eviction 等で世代が消えた) なら捨てる
//
// 照合を reducer に置くのは、応答を待つ間に要求元のコンポーネントが消えても
// 状態 (store の cache) は残るため。Effect の cleanup で応答を捨てる形
// (react.dev の `ignore` フラグ) にすると、"loading" を記録した後に unmount
// した要求の応答が誰にも適用されず、cache が "loading" のまま止まる。
//
// 値は窓全体で単調増加する整数で、0 は出さない。どの slot の世代かは区別
// しない (一意でありさえすればよい) ので、slot ごとの採番は持たない。

let lastGeneration = 0;

export function nextRequestGeneration(): number {
  lastGeneration += 1;
  return lastGeneration;
}
