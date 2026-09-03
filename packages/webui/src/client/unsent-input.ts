// 「リロードすると消える書きかけ」が画面のどこかにあるか、を数える小さな
// レジストリ。version-guard の自動リロード判定がここを見て、書きかけがある
// タブでは勝手に reload せず通知に落とす。
//
// 数えるのは *localStorage に載らない* 入力だけ。1on1 の draft
// (OneOnOneComposer) は localStorage 永続なのでリロードを跨いで生き残る =
// ここでは数えない。room の Composer は text/attachments とも useState だけ
// なので、リロードすると本当に消える — 登録対象はこちら。
//
// カウンタで持つのは、Composer が room ごとに複数 mount されうるため。
// 「今この瞬間に書きかけがあるか」しか要らないので、誰が持っているかまでは
// 追跡しない。
let count = 0;

/** 書きかけを 1 件登録し、解除用の関数を返す。effect の cleanup にそのまま
 *  渡せる形にしてあるので、呼び出し側は登録/解除の対を自分で管理しない。 */
export function registerUnsentInput(): () => void {
  count++;
  let released = false;
  return () => {
    // 二重解除でカウンタが負に振れないようにする (preact の effect は
    // StrictMode 相当の再実行で cleanup が 2 度走ることがある)。
    if (released) return;
    released = true;
    count--;
  };
}

/** 失われる書きかけが 1 件でもあるか。 */
export function hasUnsentInput(): boolean {
  return count > 0;
}

/** テスト用のリセット。プロダクションコードからは呼ばない。 */
export function resetUnsentInput(): void {
  count = 0;
}
