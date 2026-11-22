// mermaid の配布物を /assets/mermaid-<版>/ の下に配る (DR-0010 §13)。
//
// 配るのは ESM の最小化版の入口 (`dist/mermaid.esm.min.mjs`) と、それが相対で
// 読む `dist/chunks/mermaid.esm.min/*.mjs`、パッケージの LICENSE だけ。中身は
// 配布物のまま (Bun.build に通さない): 合わせて 5.5MB あり、起動のたびに
// ビルドし直さないため。chunk は外の名前を import しないので、ディレクトリの
// 形のまま配れば自己完結する。webui の本体の bundle には入らず、フロントは
// mermaid のコードブロックが出た時だけ入口を読む。
//
// どのファイルを配れるかは最初の要求の時に配布物のディレクトリを読んで決め、
// それ以外の名前 (`..` を含むもの等) は配らない。各ファイルは最初に求められた
// 時に読んで gzip し、プロセスの間覚える (brotli は作らない。本体と違い最初の
// 表示を待たせるものではなく、作るのに数秒かかるため)。
import { readdir } from "node:fs/promises";
import * as v from "valibot";
import { MERMAID_ASSET_DIR, MERMAID_VERSION } from "./client/mermaid-asset.ts";
import { encodeAsset, type EncodedAsset } from "./encoded-asset.ts";

const CHUNK_DIR = "chunks/mermaid.esm.min/";
const ENTRY = "mermaid.esm.min.mjs";
const LICENSE = "LICENSE";

const PackageJsonSchema = v.object({ version: v.string() });

/** 配れるファイル: URL の中の名前 (MERMAID_ASSET_DIR より後ろ) → ファイル。 */
async function listFiles(): Promise<ReadonlyMap<string, URL>> {
  const pkgUrl = new URL(import.meta.resolve("mermaid/package.json"));
  const pkg = v.safeParse(PackageJsonSchema, await Bun.file(pkgUrl).json());
  if (!pkg.success || pkg.output.version !== MERMAID_VERSION) {
    const found = pkg.success ? pkg.output.version : "(読めない)";
    throw new Error(
      `mermaid の版が合わない: 入っているのは ${found}、webui が配るのは ${MERMAID_VERSION}。bun install --frozen-lockfile を実行する`,
    );
  }
  const dist = new URL("dist/", pkgUrl);
  const files = new Map<string, URL>([
    [ENTRY, new URL(ENTRY, dist)],
    [LICENSE, new URL(LICENSE, pkgUrl)],
  ]);
  for (const name of await readdir(new URL(CHUNK_DIR, dist))) {
    if (name.endsWith(".mjs")) files.set(CHUNK_DIR + name, new URL(CHUNK_DIR + name, dist));
  }
  return files;
}

export interface MermaidAsset {
  asset: EncodedAsset;
  contentType: string;
}

/** 失敗は覚えず、次の要求でもう一度読む。 */
function memo<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    pending ??= load().catch((err: unknown) => {
      pending = null;
      throw err;
    });
    return pending;
  };
}

const files = memo(listFiles);
const loaded = new Map<string, () => Promise<MermaidAsset>>();

/** `path` (`/assets/mermaid-<版>/…`) で配るもの。配らない名前なら null。 */
export async function findMermaidAsset(path: string): Promise<MermaidAsset | null> {
  if (!path.startsWith(MERMAID_ASSET_DIR)) return null;
  const name = path.slice(MERMAID_ASSET_DIR.length);
  const file = (await files()).get(name);
  if (file === undefined) return null;
  let load = loaded.get(name);
  if (load === undefined) {
    load = memo(async () => ({
      asset: await encodeAsset(await Bun.file(file).text()),
      contentType:
        name === LICENSE ? "text/plain; charset=utf-8" : "text/javascript; charset=utf-8",
    }));
    loaded.set(name, load);
  }
  return load();
}
