// DOM 基盤: component / hook をマウントして検証する test file が、冒頭で
// 1 度だけ `withDom()` を呼ぶ。そのファイルの test の間だけ happy-dom の
// window / document 等を globalThis に載せ、ファイルが終わると元の値に戻す。
// bun test は全ファイルを 1 プロセスで走らせるので、DOM を要らないファイル
// (globalThis.localStorage を差し替えるもの等) に window が残らないよう、
// 登録と解除をファイル単位で閉じる (stubGlobal の afterEach と同じ理由)。
import { afterAll, beforeAll } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

export function withDom(): void {
  beforeAll(() => {
    GlobalRegistrator.register({ url: "http://127.0.0.1/" });
  });
  afterAll(async () => {
    await GlobalRegistrator.unregister();
  });
}
