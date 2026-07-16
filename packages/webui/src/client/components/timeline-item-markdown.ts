import { ADMIN_ID } from "../store.ts";

/** r26 mid=8 (kawaz): agent 発 (`from !== ADMIN_ID`) の msg 本文は markdown
 * としてレンダリングし、u1 (ユーザ) 発はプレーンのまま維持する。判定自体を
 * pure function に切り出してテスト可能にする — `from` から `ADMIN_ID`
 * (= "u1") を除く全てが対象 (署名済み agent sid 前提、値の形式は問わない)。
 *
 * .ts に分離しているのは webui/test の慣習 (composer.test.ts の module doc
 * comment 参照) — bun test の JSX runtime を巻き込まないよう、pure 分岐は
 * .tsx コンポーネントから切り出して .ts で import する。 */
export function shouldRenderAsMarkdown(from: string): boolean {
  return from !== ADMIN_ID;
}
