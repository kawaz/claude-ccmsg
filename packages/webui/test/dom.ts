// DOM 基盤: component / hook をマウントして検証する test file が、冒頭で
// 1 度だけ `withDom()` を呼ぶ。そのファイルの test の間だけ happy-dom の
// window / document 等を globalThis に載せ、ファイルが終わると元の値に戻す。
// bun test は全ファイルを 1 プロセスで走らせるので、DOM を要らないファイル
// (globalThis.localStorage を差し替えるもの等) に window が残らないよう、
// 登録と解除をファイル単位で閉じる (stubGlobal の afterEach と同じ理由)。
//
// DOM の間の fetch はどの要求も断る: 自分で fetch する component (TL の日の帯は
// その年の祝日を取りに行く、DR-0054) が test から外のネットワークに出ないため。
// 答えが要る test は自分の fetch に差し替え (stubGlobal)、戻すとこの断りに戻る。
import { afterAll, beforeAll } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { stubGlobal } from "./helpers.ts";

/** `size`: 窓の大きさ (省略時は happy-dom の既定 1024×768)。幅で変わる CSS
 * (@media) を読む test が、狭い幅の窓で開く時に渡す。 */
export function withDom(size?: { width: number; height: number }): void {
  let restoreFetch = (): void => {};
  beforeAll(() => {
    GlobalRegistrator.register({ url: "http://127.0.0.1/", ...size });
    restoreFetch = stubGlobal("fetch", (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return Promise.reject(new TypeError(`tests do not reach the network: ${url}`));
    });
  });
  afterAll(async () => {
    restoreFetch();
    await GlobalRegistrator.unregister();
  });
}
