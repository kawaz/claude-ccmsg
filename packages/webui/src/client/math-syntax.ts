// markdown の中の TeX の数式の書き方 (DR-0010 §14)。GitHub の記法に揃え、
// GitHub が一貫しない細部は pandoc の規則に合わせる。
//
// - 文中: `$…$` と `` $`…`$ ``。どちらも行をまたがない
//   - `$…$` は pandoc の規則: 開きの `$` の直後と閉じの `$` の直前が空白で
//     なく、閉じの `$` の直後が数字でない。中の `\x` は 2 文字の組で読むので、
//     `\$` では閉じない
//   - `` $`…`$ `` は最初の `` `$ `` までを TeX として読む
// - 別行立て: 1 行に収まる `$$…$$` (文の間でも)、段落全体が `$$…$$` のもの
//   (中の改行は可)、言語が `math` のコードブロック (これは code の節点のまま)
// - 文と同じ段落で行をまたぐ `$$…$$` と、詰めた箇条書きの項目の中の行を
//   またぐ `$$…$$` は数式にしない。中身が空白だけのものも数式にしない
//
// 文中の数式は micromark の text の構成要素として読む。数式は 1 つの単位に
// なるので、中の `*`・`_`・`~` が外で開いた強調や取り消し線を閉じることは
// なく、コードの中 (inline code が先に取る) と `\$` (文字の escape が先に取る)
// は対象外になる。同じ位置から始まる記法では数式を先に取る。
import type {
  Code,
  Construct,
  Effects,
  Extension,
  State,
  Token,
  TokenizeContext,
} from "micromark-util-types";
import type { CompileContext, Extension as FromMarkdownExtension } from "mdast-util-from-markdown";
import type { Literal, Nodes, Paragraph, PhrasingContent, Root, RootContent } from "mdast";

/** 文中の数式。`form` は書かれた形 (`$…$` / `$$…$$` / `` $`…`$ ``)。 */
export interface InlineMath extends Literal {
  type: "inlineMath";
  form: "inline" | "display" | "backtick";
}

/** 段落全体が `$$…$$` だった別行立ての数式。 */
export interface BlockMath extends Literal {
  type: "math";
}

declare module "mdast" {
  interface PhrasingContentMap {
    inlineMath: InlineMath;
  }
  interface BlockContentMap {
    math: BlockMath;
  }
  interface RootContentMap {
    inlineMath: InlineMath;
    math: BlockMath;
  }
}

declare module "micromark-util-types" {
  interface TokenTypeMap {
    mathTextInline: "mathTextInline";
    mathTextDisplay: "mathTextDisplay";
    mathTextBacktick: "mathTextBacktick";
    mathTextSequence: "mathTextSequence";
    mathTextData: "mathTextData";
    mathTextTrailing: "mathTextTrailing";
  }
}

const DOLLAR = 36;
const BACKTICK = 96;
const BACKSLASH = 92;

function isLineEnding(code: Code): boolean {
  return code !== null && code < -2;
}

/** 空白 (タブ・タブの残り・JS の `\s` に当たる文字)。行の終わりは含めない。 */
function isSpace(code: Code): boolean {
  if (code === null || code < -2) return false;
  if (code < 0) return true;
  return /\s/u.test(String.fromCodePoint(code));
}

function isAsciiDigit(code: Code): boolean {
  return code !== null && code >= 48 && code <= 57;
}

/** `` $`…`$ ``: 最初の `` `$ `` まで。中身は 1 文字以上で、行をまたがない。 */
function tokenizeBacktick(effects: Effects, ok: State, nok: State): State {
  let size = 0;
  const content = (code: Code): State | undefined => {
    if (code === null || isLineEnding(code)) return nok(code);
    if (code === BACKTICK && size > 0) {
      effects.consume(code);
      return maybeClose;
    }
    effects.consume(code);
    size += 1;
    return content;
  };
  const maybeClose = (code: Code): State | undefined => {
    if (code === DOLLAR) {
      effects.consume(code);
      effects.exit("mathTextBacktick");
      return ok;
    }
    // 直前の `` ` `` は中身だった。
    size += 1;
    return content(code);
  };
  const tick = (code: Code): State | undefined => {
    if (code !== BACKTICK) return nok(code);
    effects.consume(code);
    return content;
  };
  return (code) => {
    effects.enter("mathTextBacktick");
    effects.consume(code);
    return tick;
  };
}

/** `$$…$$`: 最初の `$$` まで。中の `\x` は組。行をまたいでよいのは、段落の
 * 頭から始まり段落の終わりで閉じる時だけ (段落全体が数式)。
 *
 * 中は micromark の inline code (codeText) と同じ組み立てにする: 区切りの
 * `$$` は mathTextSequence、中身は mathTextData、行の終わりは lineEnding の
 * token。行の終わりを中身と同じ token に入れると、段落の終わりで閉じた時に
 * micromark の後処理が止まらなくなった (実測)。 */
function tokenizeDisplay(
  effects: Effects,
  ok: State,
  nok: State,
  atParagraphStart: boolean,
): State {
  let size = 0;
  let multiLine = false;
  let sequence: Token | null = null;
  const between = (code: Code): State | undefined => {
    if (code === null) return nok(code);
    if (isLineEnding(code)) {
      if (!atParagraphStart) return nok(code);
      multiLine = true;
      size += 1;
      effects.enter("lineEnding");
      effects.consume(code);
      effects.exit("lineEnding");
      return between;
    }
    if (code === DOLLAR) {
      sequence = effects.enter("mathTextSequence");
      effects.consume(code);
      return closing;
    }
    effects.enter("mathTextData");
    return data(code);
  };
  const data = (code: Code): State | undefined => {
    if (code === null || isLineEnding(code) || code === DOLLAR) {
      effects.exit("mathTextData");
      return between(code);
    }
    effects.consume(code);
    size += 1;
    return code === BACKSLASH ? escaped : data;
  };
  const escaped = (code: Code): State | undefined => {
    // `\` の次の 1 文字は組で中身 (`\$` で閉じない)。行の終わりは between が扱う。
    if (code === null || isLineEnding(code)) return data(code);
    effects.consume(code);
    return data;
  };
  const closing = (code: Code): State | undefined => {
    if (code !== DOLLAR || sequence === null) {
      // 1 つだけの `$` は中身。
      if (sequence !== null) sequence.type = "mathTextData";
      size += 1;
      return data(code);
    }
    if (size === 0) return nok(code);
    effects.consume(code);
    effects.exit("mathTextSequence");
    if (!multiLine) {
      effects.exit("mathTextDisplay");
      return ok;
    }
    return trailing;
  };
  // 行をまたいだ時は、閉じの後ろが段落の終わり (空白は許す) でなければ数式に
  // しない。
  const trailing = (code: Code): State | undefined => {
    if (code === null) {
      effects.exit("mathTextDisplay");
      return ok(code);
    }
    if (!isSpace(code)) return nok(code);
    effects.enter("mathTextTrailing");
    effects.consume(code);
    effects.exit("mathTextTrailing");
    return trailing;
  };
  const second = (code: Code): State | undefined => {
    if (code !== DOLLAR) return nok(code);
    effects.consume(code);
    effects.exit("mathTextSequence");
    return between;
  };
  return (code) => {
    effects.enter("mathTextDisplay");
    effects.enter("mathTextSequence");
    effects.consume(code);
    return second;
  };
}

/** `$…$` (pandoc の規則)。 */
function tokenizeInline(effects: Effects, ok: State, nok: State): State {
  let afterSpace = false;
  const content = (code: Code): State | undefined => {
    if (code === null || isLineEnding(code)) return nok(code);
    if (code === BACKSLASH) {
      effects.consume(code);
      afterSpace = false;
      return escaped;
    }
    if (code === DOLLAR) {
      if (afterSpace) return nok(code);
      effects.consume(code);
      effects.exit("mathTextInline");
      return closed;
    }
    afterSpace = isSpace(code);
    effects.consume(code);
    return content;
  };
  const escaped = (code: Code): State | undefined => {
    if (code === null || isLineEnding(code)) return nok(code);
    effects.consume(code);
    return content;
  };
  const closed = (code: Code): State | undefined => (isAsciiDigit(code) ? nok(code) : ok(code));
  const first = (code: Code): State | undefined => {
    if (code === null || isLineEnding(code) || isSpace(code) || code === DOLLAR) return nok(code);
    return content(code);
  };
  return (code) => {
    effects.enter("mathTextInline");
    effects.consume(code);
    return first;
  };
}

/** `$` で始まる文中の数式。形は `` $`…`$ ``、`$$…$$`、`$…$` の順に試し、
 * 最初に当たったものを取る。 */
const mathText: Construct = {
  name: "mathText",
  tokenize(this: TokenizeContext, effects, ok, nok) {
    const atParagraphStart = this.previous === null;
    const backtick: Construct = { tokenize: (e, o, n) => tokenizeBacktick(e, o, n) };
    const display: Construct = {
      tokenize: (e, o, n) => tokenizeDisplay(e, o, n, atParagraphStart),
    };
    const inline: Construct = { tokenize: (e, o, n) => tokenizeInline(e, o, n) };
    return effects.attempt(
      backtick,
      ok,
      effects.attempt(display, ok, effects.attempt(inline, ok, nok)),
    );
  },
};

/** micromark の拡張 (文中の数式)。 */
export function mathSyntax(): Extension {
  return { text: { [DOLLAR]: mathText } };
}

const FORMS = {
  mathTextInline: { form: "inline", open: 1, close: 1 },
  mathTextDisplay: { form: "display", open: 2, close: 2 },
  mathTextBacktick: { form: "backtick", open: 2, close: 2 },
} as const;

function enterMath(form: InlineMath["form"]) {
  return function (this: CompileContext, token: Token): undefined {
    this.enter({ type: "inlineMath", value: "", form }, token);
  };
}

function exitMath(kind: keyof typeof FORMS) {
  return function (this: CompileContext, token: Token): undefined {
    const raw = this.sliceSerialize(token);
    const node = this.stack.at(-1);
    if (node?.type === "inlineMath") {
      const { open, close } = FORMS[kind];
      // 行をまたぐ `$$…$$` の token は後ろの空白まで含むので、閉じの位置で切る。
      const end = kind === "mathTextDisplay" ? raw.lastIndexOf("$$") : raw.length - close;
      node.value = raw.slice(open, end);
    }
    this.exit(token);
  };
}

/** mdast-util-from-markdown の拡張 (文中の数式の節点 `inlineMath`)。 */
export function mathFromMarkdown(): FromMarkdownExtension {
  return {
    enter: {
      mathTextInline: enterMath("inline"),
      mathTextDisplay: enterMath("display"),
      mathTextBacktick: enterMath("backtick"),
    },
    exit: {
      mathTextInline: exitMath("mathTextInline"),
      mathTextDisplay: exitMath("mathTextDisplay"),
      mathTextBacktick: exitMath("mathTextBacktick"),
    },
  };
}

/** 書かれたとおりの文字 (数式にしないと決めた時に文字へ戻す)。 */
function rawOf(math: InlineMath): string {
  switch (math.form) {
    case "inline":
      return `$${math.value}$`;
    case "display":
      return `$$${math.value}$$`;
    case "backtick":
      return `$\`${math.value}\`$`;
  }
}

function isBlankText(node: PhrasingContent): boolean {
  return node.type === "text" && node.value.trim() === "";
}

/** 数式にしないもの (中身が空白だけ、行をまたぐ文中の `$$…$$`) を文字に戻す。 */
function demote(children: PhrasingContent[]): PhrasingContent[] {
  const out: PhrasingContent[] = [];
  for (const child of children) {
    const keep =
      child.type !== "inlineMath" ||
      (child.value.trim() !== "" && !(child.form === "display" && /[\r\n]/.test(child.value)));
    const next: PhrasingContent = keep ? child : { type: "text", value: rawOf(child) };
    if ("children" in next) {
      next.children = demote(next.children);
    }
    const last = out.at(-1);
    if (next.type === "text" && last?.type === "text") {
      last.value += next.value;
    } else {
      out.push(next);
    }
  }
  return out;
}

/** 段落全体が 1 つの `$$…$$` なら、その中身。 */
function wholeParagraphMath(paragraph: Paragraph): string | null {
  const meaningful = paragraph.children.filter((child) => !isBlankText(child));
  const [only] = meaningful;
  if (meaningful.length !== 1 || only?.type !== "inlineMath" || only.form !== "display")
    return null;
  return only.value.trim() === "" ? null : only.value;
}

function liftBlocks<T extends RootContent>(nodes: T[], tightList: boolean): (T | BlockMath)[] {
  return nodes.map((node): T | BlockMath => {
    if (node.type === "paragraph") {
      const tex = tightList ? null : wholeParagraphMath(node);
      if (tex !== null) {
        const math: BlockMath = { type: "math", value: tex };
        if (node.position) math.position = node.position;
        return math;
      }
      node.children = demote(node.children);
      return node;
    }
    liftChildren(node, false);
    return node;
  });
}

function liftChildren(node: Nodes, tightList: boolean): void {
  switch (node.type) {
    case "root":
    case "blockquote":
    case "footnoteDefinition":
      node.children = liftBlocks(node.children, false);
      return;
    case "list":
      for (const item of node.children) liftChildren(item, node.spread === false);
      return;
    case "listItem":
      node.children = liftBlocks(node.children, tightList);
      return;
    case "heading":
    case "tableCell":
      node.children = demote(node.children);
      return;
    case "table":
      for (const row of node.children) {
        for (const cell of row.children) liftChildren(cell, false);
      }
      return;
    default:
      return;
  }
}

/** パースの後に、段落全体の `$$…$$` を別行立ての数式 (`math`) にし、数式に
 * しない `inlineMath` を文字に戻す。詰めた箇条書き (GitHub では項目が段落を
 * 作らない) の中の段落は別行立てにしない。 */
export function liftMath(root: Root): void {
  liftChildren(root, false);
}
