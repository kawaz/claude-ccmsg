// Temml の stylesheet (Temml-Local.css) の中のフォントの参照 `url('Temml.woff2')`
// を、そのフォントの data URL に置き換える Bun.build の plugin (DR-0010 §14)。
// stylesheet は数式の chunk (client/math-typeset.ts) が文字として読み、数式が
// 出た時に文書へ足す。フォント (約 9KB、`\mathscr` 用) を別のファイルとして
// 配らずに済む。
import type { BunPlugin } from "bun";

const FONT_REF = "url('Temml.woff2')";

export const inlineTemmlFont: BunPlugin = {
  name: "inline-temml-font",
  setup(build) {
    build.onLoad({ filter: /[\\/]temml[\\/]dist[\\/]Temml-Local\.css$/ }, async (args) => {
      const text = await Bun.file(args.path).text();
      if (!text.includes(FONT_REF)) {
        throw new Error(`Temml-Local.css に ${FONT_REF} が無い (Temml の版が変わった)`);
      }
      const fontPath = args.path.replace(/Temml-Local\.css$/, "Temml.woff2");
      const font = Buffer.from(await Bun.file(fontPath).arrayBuffer()).toString("base64");
      return {
        contents: text.replaceAll(FONT_REF, `url("data:font/woff2;base64,${font}")`),
        loader: "text",
      };
    });
  },
};
