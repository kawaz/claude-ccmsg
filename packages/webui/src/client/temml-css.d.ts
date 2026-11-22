// Temml の stylesheet を文字として読む (math-typeset.ts の `with { type: "text" }`)。
declare module "temml/dist/Temml-Local.css" {
  const text: string;
  export default text;
}
