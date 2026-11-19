// 許可依頼の project_permissions のファイルの rule を、依頼を受けた時にファイル
// システムで確かめる (DR-0040 §12)。
//
// 何を保証するか (各 test の doc comment 参照):
//   - realpathLoose は存在するところまで symlink を解決し、まだ無い残りを書いた
//     まま付ける (Python の os.path.realpath の非 strict と同じ)
//   - missingRealFileRules は、symlink を通る // / ~/ のファイルの rule に、実体の
//     綴りの rule が同じ依頼の add に無ければ、足す rule の全文を返す
//
// fixture は mkdtemp の一時ディレクトリに作る。一時ディレクトリ自体が symlink
// (/tmp → /private/tmp) の下にあることがあるので、期待値はその realpath を基点
// にする。
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { perTestTmpDir } from "../../testkit/src/tmp.ts";
import { missingRealFileRules, realpathLoose } from "../src/permit-file-rules.ts";

const tmpDir = perTestTmpDir();

/** A fixture: `<base>/real/c.txt`, `<base>/link -> real` (relative),
 * `<base>/alink -> <base>/real` (absolute), `<base>/chain -> link`, with
 * `base` as made and `realBase` its realpath. */
function fixture(): { base: string; realBase: string } {
  const base = tmpDir("permit-file-rules-");
  fs.mkdirSync(path.join(base, "real"));
  fs.writeFileSync(path.join(base, "real", "c.txt"), "c");
  fs.symlinkSync("real", path.join(base, "link"));
  fs.symlinkSync(path.join(base, "real"), path.join(base, "alink"));
  fs.symlinkSync("link", path.join(base, "chain"));
  return { base, realBase: fs.realpathSync(base) };
}

/** The reason missingRealFileRules gives for `rule`, lacking `missing`. */
function lacking(rule: string, missing: string): string {
  return `${rule}: path が symlink を通り、実体の綴りの rule も無いと当たらない。同じ依頼の add に ${missing} も足す`;
}

describe("realpathLoose", () => {
  // 何を保証するか: 存在するファイルは realpath そのもの。symlink を通る path
  // (相対・絶対・連鎖) は実体の綴りになる。
  test("resolves an existing file, through a relative, an absolute and a chained symlink", async () => {
    const { base, realBase } = fixture();
    const real = path.join(realBase, "real", "c.txt");
    expect(await realpathLoose(path.join(base, "real", "c.txt"))).toBe(real);
    for (const via of ["link", "alink", "chain"]) {
      expect(await realpathLoose(path.join(base, via, "c.txt"))).toBe(real);
    }
  });

  // 何を保証するか: まだ無いファイル、まだ無い親の下のファイルは、存在する最も
  // 深い親までを解決し、残りを書いたまま付ける。symlink の下のまだ無いファイル
  // は、symlink を解決した上に残りを付ける。
  test("resolves as far as the path exists and puts back the rest as written", async () => {
    const { base, realBase } = fixture();
    expect(await realpathLoose(path.join(base, "real", "new.txt"))).toBe(
      path.join(realBase, "real", "new.txt"),
    );
    expect(await realpathLoose(path.join(base, "real", "sub", "deeper", "new.txt"))).toBe(
      path.join(realBase, "real", "sub", "deeper", "new.txt"),
    );
    expect(await realpathLoose(path.join(base, "link", "new.txt"))).toBe(
      path.join(realBase, "real", "new.txt"),
    );
    expect(await realpathLoose(path.join(base, "chain", "sub", "new.txt"))).toBe(
      path.join(realBase, "real", "sub", "new.txt"),
    );
  });

  // 何を保証するか: OS の symlink (macOS の /var → /private/var) も利用者の
  // symlink と同じく解決する。まだ無い残りも付く。
  test("resolves the OS's /var the same way", async () => {
    const rest = path.join(`ccmsg-no-such-${crypto.randomUUID()}`, "f.txt");
    const resolved = await realpathLoose(path.join("/var", rest));
    expect(resolved).toBe(path.join(fs.realpathSync("/var"), rest));
    if (process.platform === "darwin") expect(resolved).toBe(path.join("/private/var", rest));
  });
});

describe("missingRealFileRules", () => {
  // 何を保証するか: symlink を通らない // / ~/ の rule、相対・ファイル以外の rule
  // には何も求めない。~/ は渡した home に読む。
  test("asks nothing of a rule not through a symlink, a relative rule or a rule of no file", async () => {
    const { realBase } = fixture();
    expect(
      await missingRealFileRules(
        [
          `Edit(/${realBase}/real/c.txt)`,
          `Read(/${realBase}/real/new.txt)`,
          "Edit(~/real/c.txt)",
          "Edit(src/**)",
          "Bash(ls ~/link)",
        ],
        realBase,
      ),
    ).toEqual([]);
  });

  // 何を保証するか: symlink を通る // と ~/ の rule は、同じ tool の実体の綴りの
  // // の rule を求め、書いた rule と足す rule の全文を理由に入れる。1 つの依頼の
  // 足りないものは全部返す。
  test("asks for the // rule of the real path of each rule through a symlink", async () => {
    const { base, realBase } = fixture();
    const real = `${realBase}/real/c.txt`;
    expect(
      await missingRealFileRules([`Edit(/${base}/link/c.txt)`, "Read(~/alink/c.txt)"], base),
    ).toEqual([
      lacking(`Edit(/${base}/link/c.txt)`, `Edit(/${real})`),
      lacking("Read(~/alink/c.txt)", `Read(/${real})`),
    ]);
  });

  // 何を保証するか: 実体の綴りの rule が同じ依頼の add にあれば (// でも ~/ でも)
  // 求めない。tool が違えば足りない (Edit の実体の rule は Read の rule を満たさない)。
  test("is satisfied by the real path's rule in the same request, of the same tool", async () => {
    const { base, realBase } = fixture();
    expect(
      await missingRealFileRules(["Edit(~/link/c.txt)", `Edit(/${realBase}/real/c.txt)`], base),
    ).toEqual([]);
    expect(
      await missingRealFileRules([`Edit(/${base}/chain/c.txt)`, "Edit(~/real/c.txt)"], realBase),
    ).toEqual([]);
    expect(
      await missingRealFileRules(
        [`Read(/${base}/link/c.txt)`, `Edit(/${realBase}/real/c.txt)`],
        base,
      ),
    ).toEqual([lacking(`Read(/${base}/link/c.txt)`, `Read(/${realBase}/real/c.txt)`)]);
  });

  // 何を保証するか: まだ無いファイルも、symlink の下なら実体の綴りを求める。
  // glob を含む rule は glob の手前までを解決し、glob の部分は書いたまま付ける。
  // 末尾の / は保つ。
  test("resolves a file not made yet, the part before a glob, and keeps a trailing /", async () => {
    const { base, realBase } = fixture();
    const cases: [string, string][] = [
      [`Edit(/${base}/link/sub/new.txt)`, `Edit(/${realBase}/real/sub/new.txt)`],
      [`Edit(/${base}/link/**)`, `Edit(/${realBase}/real/**)`],
      [`Edit(/${base}/link/*.txt)`, `Edit(/${realBase}/real/*.txt)`],
      [`Read(/${base}/link/)`, `Read(/${realBase}/real/)`],
    ];
    for (const [rule, missing] of cases) {
      expect(await missingRealFileRules([rule], base)).toEqual([lacking(rule, missing)]);
    }
    // A glob in the segment right below the base: only the base is resolved,
    // and the braces are kept as written.
    expect(await missingRealFileRules([`Edit(/${realBase}/l{ink,x}/c.txt)`], base)).toEqual([]);
    expect(await missingRealFileRules([`Edit(/${realBase}/real/**)`], base)).toEqual([]);
  });
});
