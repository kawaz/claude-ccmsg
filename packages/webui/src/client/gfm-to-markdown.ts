// mdast の GFM の表と打ち消し線を markdown の文字にする、mdast-util-to-markdown
// の拡張 (貼られた HTML の変換が使う、DR-0065)。表のセルの中の改行は `<br>`
// (DR-0010 §3)。
//
// Design rationale: mdast-util-gfm-table / mdast-util-gfm-strikethrough の
// toMarkdown を使わず、ここで書く。その 2 つの module は、最初の画面の
// bundle の markdown の読み (markdown-view.tsx の fromMarkdown の拡張) と同じ
// module で、遅れて読む変換の chunk から toMarkdown 側を使うと、bundler が
// module ごと entry に置くため、mdast-util-to-markdown の handler 一式まで
// entry に入る (実測: entry が minify 後 +19.6KB、gzip +6.8KB)。書く量は、
// 揃えの空白を詰めた表 (送る先は AI で、桁の揃えは全角の文字で崩れる) と
// 打ち消し線だけなので小さい。escape の決まり (unsafe) は 2 つの拡張と同じ。
import type { Delete, InlineCode, Parents, Table, TableCell } from "mdast";
import {
  defaultHandlers,
  type ConstructName,
  type Info,
  type Options,
  type State,
} from "mdast-util-to-markdown";

/** 打ち消し線の `~` を escape しない所 (mdast-util-gfm-strikethrough と同じ)。 */
const WITHOUT_STRIKETHROUGH: ConstructName[] = [
  "autolink",
  "destinationLiteral",
  "destinationRaw",
  "reference",
  "titleQuote",
  "titleApostrophe",
];

const DELIMITER = { left: ":--", right: "--:", center: ":-:" } as const;

function table(node: Table, _parent: Parents | undefined, state: State, info: Info): string {
  const exit = state.enter("table");
  const rows = node.children.map((row) => {
    const exitRow = state.enter("tableRow");
    const cells = row.children.map((cell) => tableCell(cell, state, info));
    exitRow();
    return cells;
  });
  exit();
  const width = Math.max(1, ...rows.map((cells) => cells.length));
  const line = (cells: readonly string[]): string =>
    `|${Array.from({ length: width }, (_, i) => (cells[i] ? ` ${cells[i]} |` : " |")).join("")}`;
  const delimiter = Array.from({ length: width }, (_, i) => {
    const align = node.align?.[i];
    return align ? DELIMITER[align] : "---";
  });
  const [head = [], ...body] = rows;
  return [line(head), line(delimiter), ...body.map(line)].join("\n");
}

function tableCell(node: TableCell, state: State, info: Info): string {
  const exit = state.enter("tableCell");
  const exitPhrasing = state.enter("phrasing");
  const value = state.containerPhrasing(node, { ...info, before: " ", after: " " });
  exitPhrasing();
  exit();
  return value;
}

/** セルの中の改行は `<br>` (セルは 1 行に収まる必要があり、markdown の強制改行を
 * 置けない。この webui の markdown は `<br>` を改行として読む)。 */
function hardBreak(
  node: Parameters<typeof defaultHandlers.break>[0],
  parent: Parents | undefined,
  state: State,
  info: Info,
): string {
  return state.stack.includes("tableCell")
    ? "<br>"
    : defaultHandlers.break(node, parent, state, info);
}

/** セルの中のコードの `|` は escape する (セルの区切りと読まれないよう)。 */
function inlineCode(node: InlineCode, parent: Parents | undefined, state: State): string {
  const value = defaultHandlers.inlineCode(node, parent, state);
  return state.stack.includes("tableCell") ? value.replaceAll("|", "\\|") : value;
}

function strikethrough(
  node: Delete,
  _parent: Parents | undefined,
  state: State,
  info: Info,
): string {
  const tracker = state.createTracker(info);
  const exit = state.enter("strikethrough");
  let value = tracker.move("~~");
  value += state.containerPhrasing(node, { ...tracker.current(), before: value, after: "~" });
  value += tracker.move("~~");
  exit();
  return value;
}
strikethrough.peek = (): string => "~";

/** toMarkdown の `extensions` に渡す拡張。 */
export const gfmToMarkdown: Options = {
  unsafe: [
    { character: "~", inConstruct: "phrasing", notInConstruct: WITHOUT_STRIKETHROUGH },
    { character: "\r", inConstruct: "tableCell" },
    { character: "\n", inConstruct: "tableCell" },
    { atBreak: true, character: "|", after: "[\t :-]" },
    { character: "|", inConstruct: "tableCell" },
    { atBreak: true, character: ":", after: "-" },
    { atBreak: true, character: "-", after: "[:|-]" },
  ],
  handlers: { table, delete: strikethrough, break: hardBreak, inlineCode },
};
