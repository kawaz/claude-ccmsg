// Shiki が塗った 1 トークン (`.shiki-tok`) が「JSON の文字列リテラル」かを
// 判定し、生の文字列値を返す pure helper。JSON プレビュー上の
// `"C:\\path\\to"` のようなトークンを、エスケープ済みの見た目のままでなく
// JSON.parse 後の値としてコピーするために使う (useJsonStringCopy)。
//
// トークンは行単位に切られるため、複数行にまたがる文字列や途中で切れた
// トークンは parse に失敗する。その場合は null を返し、呼び出し側は
// コピー UI を出さない (壊れた値を黙ってコピーさせない)。

/**
 * JSON 文字列リテラルなら parse 後の値、そうでなければ null。
 *
 * 前後の空白は落としてから判定する (インデントを含むトークンがあるため)。
 */
export function parseJsonStringToken(text: string | null | undefined): string | null {
  if (text == null) return null;
  const trimmed = text.trim();
  if (trimmed.length < 2 || !trimmed.startsWith('"') || !trimmed.endsWith('"')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  // `"a" + "b"` のような複数リテラルは JSON.parse が弾くので、ここに来る
  // 時点で string 以外にはなり得ない。型の保証として残す。
  return typeof parsed === "string" ? parsed : null;
}
