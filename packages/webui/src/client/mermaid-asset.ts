// mermaid の配布物を daemon が配る場所 (DR-0010 §13)。daemon の側
// (mermaid-assets.ts) とフロントの側 (mermaid-render.ts) が同じ値を使う。
// 版は packages/webui/package.json の dependencies の mermaid と同じ値に固定し、
// 一致はテストが確かめる。URL に版を入れるので、配る側は immutable で返せる。

export const MERMAID_VERSION = "12.3.0";

/** 配布物のディレクトリ (`dist/`) を配る URL の接頭辞。 */
export const MERMAID_ASSET_DIR = `/assets/mermaid-${MERMAID_VERSION}/`;

/** フロントが dynamic import する入口 (`dist/mermaid.esm.min.mjs`)。中から
 * 同じディレクトリの `chunks/mermaid.esm.min/*.mjs` を相対で読む。 */
export const MERMAID_ENTRY_PATH = `${MERMAID_ASSET_DIR}mermaid.esm.min.mjs`;
