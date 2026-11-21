// 許可依頼の project_permissions の add の rule から、daemon が書く rule の組を
// 作る (DR-0040 §12)。
//
// 何を保証するか (各 test の doc comment 参照):
//   - realpathLoose は存在するところまで symlink を解決し、まだ無い残りを書いた
//     まま付ける (Python の os.path.realpath の非 strict と同じ)
//   - addedRules は、書かれた rule を当たる形に直し (Write → Edit、/ 1 つ →
//     //)、symlink を通る // / ~/ のファイルの rule には実体の綴りの // の rule を
//     添える
//
// fixture は mkdtemp の一時ディレクトリに作る。一時ディレクトリ自体が symlink
// (/tmp → /private/tmp) の下にあることがあるので、期待値はその realpath を基点
// にする。
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { perTestTmpDir } from "../../testkit/src/tmp.ts";
import { addedRules, realpathLoose } from "../src/permit-file-rules.ts";

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

describe("addedRules", () => {
  // 何を保証するか: symlink を通らない // / ~/ の rule、相対・ファイル以外の rule
  // は書かれたまま 1 本 (~/ は渡した home に読み、綴りは ~/ のまま)。
  test("is the rule alone when it goes through no symlink, is relative or names no file", async () => {
    const { realBase } = fixture();
    for (const rule of [
      `Edit(/${realBase}/real/c.txt)`,
      `Read(/${realBase}/real/new.txt)`,
      "Edit(~/real/c.txt)",
      "Edit(src/**)",
      "Bash(ls ~/link)",
    ]) {
      expect(await addedRules(rule, realBase)).toEqual([rule]);
    }
  });

  // 何を保証するか: 当たらない形は当たる形に直す: Write は Edit に、/ 1 つで
  // 始まる path は // に (直した上で symlink を通れば実体の rule も添える)。
  test("puts Write as Edit and a single / as //", async () => {
    const { base, realBase } = fixture();
    expect(await addedRules("Write(src/**)", base)).toEqual(["Edit(src/**)"]);
    expect(await addedRules(`Write(${realBase}/real/c.txt)`, base)).toEqual([
      `Edit(/${realBase}/real/c.txt)`,
    ]);
    expect(await addedRules(`Read(${base}/link/c.txt)`, base)).toEqual([
      `Read(/${base}/link/c.txt)`,
      `Read(/${realBase}/real/c.txt)`,
    ]);
  });

  // 何を保証するか: symlink を通る // と ~/ の rule には、同じ tool の実体の綴りの
  // // の rule を添える。書かれた綴りは残す (~/ も)。symlink の先の先 (chain) も
  // 解決する。
  test("adds the // rule of the real path to a rule through a symlink, keeping the rule as written", async () => {
    const { base, realBase } = fixture();
    const real = `${realBase}/real/c.txt`;
    expect(await addedRules(`Edit(/${base}/link/c.txt)`, base)).toEqual([
      `Edit(/${base}/link/c.txt)`,
      `Edit(/${real})`,
    ]);
    expect(await addedRules("Read(~/alink/c.txt)", base)).toEqual([
      "Read(~/alink/c.txt)",
      `Read(/${real})`,
    ]);
    expect(await addedRules(`Edit(/${base}/chain/c.txt)`, base)).toEqual([
      `Edit(/${base}/chain/c.txt)`,
      `Edit(/${real})`,
    ]);
  });

  // 何を保証するか: まだ無いファイルも、symlink の下なら実体の綴りを添える。
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
    for (const [rule, real] of cases) {
      expect(await addedRules(rule, base)).toEqual([rule, real]);
    }
    // A glob in the segment right below the base: only the base is resolved,
    // and the braces are kept as written.
    expect(await addedRules(`Edit(/${realBase}/l{ink,x}/c.txt)`, base)).toEqual([
      `Edit(/${realBase}/l{ink,x}/c.txt)`,
    ]);
  });
});
