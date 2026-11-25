// Narrowing helpers shared by the webui tests (DR-0038 §5): a test reads what
// the code under test produced through these instead of asserting its type, so
// a value of another shape fails the test with what was expected rather than
// slipping through a cast.
import * as v from "valibot";
import type { ComponentChild, ComponentChildren, VNode } from "preact";
import {
  JsonObjectSchema,
  jsonText,
  parseWith,
  readRequest,
  type JsonObject,
  type PeerInfo,
  type Request,
} from "@ccmsg/protocol";

/** `value`, which the test needs to be there: a lookup that found nothing
 * (`find`, `Map.get`, a function answering null) fails the test, naming
 * `what` was looked for, instead of an error thrown later from reading a field
 * of nothing. */
export function defined<T>(value: T | null | undefined, what: string): T {
  if (value === undefined || value === null) throw new Error(`expected ${what}, found none`);
  return value;
}

/** `value` as an instance of `ctor` (a DOM element of a given kind, the Error
 * a rejected promise carried); anything else fails the test, naming `what`. */
export function instanceOf<V, T extends V>(
  value: V,
  ctor: abstract new (...args: never[]) => T,
  what: string,
): T {
  if (!(value instanceof ctor)) throw new Error(`expected ${what} to be a ${ctor.name}`);
  return value;
}

/** Put `value` in place of the global `name` (a browser API the bun runtime
 * lacks, or a builtin of its own a test drives by hand) and return what puts
 * the original back: its own property as it was, or none when there was none.
 * bun runs every test file in one process, so a global left replaced or
 * deleted leaks into the files that run after. */
export function stubGlobal<T>(name: string, value: T): () => void {
  return stubProperty(globalThis, name, {
    value,
    configurable: true,
    enumerable: true,
    writable: true,
  });
}

/** Define `name` on `target` as `descriptor` (a getter on a DOM prototype the
 * test gives the layout happy-dom does not compute) and return what puts the
 * original back: `target`'s own property as it was, or none when there was
 * none. Deleting is not putting back: happy-dom defines some of these as the
 * prototype's own (`clientHeight` on `HTMLElement.prototype`), and its classes
 * are the same across `withDom` registrations, so a deleted one is gone for
 * the files that run after. */
export function stubProperty(
  target: object,
  name: string,
  descriptor: PropertyDescriptor,
): () => void {
  const original = Object.getOwnPropertyDescriptor(target, name);
  Object.defineProperty(target, name, descriptor);
  return () => {
    if (original === undefined) Reflect.deleteProperty(target, name);
    else Object.defineProperty(target, name, original);
  };
}

/** A paste on `el` of a clipboard holding `data` (a type → its content), as a
 * browser sends one. A paste the input box takes for markdown (an HTML one,
 * DR-0065) is the one it prevents. */
export function clipboardPaste(el: Element, data: Record<string, string>): ClipboardEvent {
  const clipboard = new DataTransfer();
  for (const [type, value] of Object.entries(data)) clipboard.setData(type, value);
  const event = new ClipboardEvent("paste", {
    clipboardData: clipboard,
    bubbles: true,
    cancelable: true,
  });
  el.dispatchEvent(event);
  return event;
}

/** HTML a paste carries that goes in as markdown (DR-0065): a link. */
export const LINK_HTML = '<p>see <a href="https://example.com/doc">the doc</a></p>';
/** LINK_HTML as the markdown it goes in as. */
export const LINK_MARKDOWN = "see [the doc](https://example.com/doc)";

/** A stand-in for `document.execCommand("insertText")`, which happy-dom lacks:
 * it puts the text in place of the focused textarea's selection and sends an
 * `input`, as a browser does. `next()` resolves with the text of the next
 * insertion (the paste's markdown goes in after the converter is loaded). */
export function stubInsertText(): { next: () => Promise<string>; restore: () => void } {
  let waiting: Array<(text: string) => void> = [];
  const restore = stubProperty(document, "execCommand", {
    configurable: true,
    value: (_command: string, _ui: boolean, text: string): boolean => {
      const el = document.activeElement;
      if (el instanceof HTMLTextAreaElement) {
        el.setRangeText(text, el.selectionStart, el.selectionEnd, "end");
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
      for (const resolve of waiting) resolve(text);
      waiting = [];
      return true;
    },
  });
  return {
    next: () =>
      new Promise((resolve) => {
        waiting.push(resolve);
      }),
    restore,
  };
}

/** An in-memory `Storage` for code that reads `localStorage` /
 * `sessionStorage` directly, which the bun runtime lacks. Put it in place with
 * `stubGlobal` and put the original back after the test: a storage left on
 * `globalThis` carries what the test wrote into the files that run after. */
export class MemStorage {
  private data = new Map<string, string>();
  get length(): number {
    return this.data.size;
  }
  key(i: number): string | null {
    return [...this.data.keys()][i] ?? null;
  }
  getItem(k: string): string | null {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.data.set(k, v);
  }
  removeItem(k: string): void {
    this.data.delete(k);
  }
  clear(): void {
    this.data.clear();
  }
}

export const JsonObjectTextSchema = jsonText(JsonObjectSchema);

/** A line of JSON text that has to be an object (a frame the client sent), read
 * as one with every field it carries; anything else fails the test. */
export function jsonObjectOf(line: string): JsonObject {
  const read = parseWith(JsonObjectTextSchema, line);
  if (!read.ok) throw new Error(`not a JSON object: ${read.failure.summary}: ${line}`);
  return read.value;
}

/** A line the client sent, read as the request the daemon would read it as;
 * a line the daemon would refuse fails the test. */
export function requestOf(line: string): Request {
  const read = readRequest(line);
  if (read.kind === "other_major_hello") throw new Error(`a hello of another major: ${line}`);
  if (read.kind !== "request") throw new Error(`not a request: ${read.failure.summary}: ${line}`);
  return read.request;
}

// --- time --------------------------------------------------------------------

interface FakeWait {
  readonly at: number;
  readonly fn: () => void;
  cancelled: boolean;
}

/** A clock the test moves by hand, for code that takes its time and its waits
 * from a clock (`WsClock`): the time stands still, and a wait runs only when
 * `advance` carries the time to it. */
export class FakeClock {
  private time = 0;
  private waits: FakeWait[] = [];

  now(): number {
    return this.time;
  }

  after(ms: number, fn: () => void): { cancel(): void } {
    const wait: FakeWait = { at: this.time + ms, fn, cancelled: false };
    this.waits.push(wait);
    return {
      cancel: () => {
        wait.cancelled = true;
      },
    };
  }

  /** Move the time `ms` forward, running each wait that falls due on the way
   * at its own time: earliest first, and those due at once in the order they
   * were set. A wait set by one that runs is run too if it falls due within
   * the same `ms`. */
  advance(ms: number): void {
    const until = this.time + ms;
    for (;;) {
      this.waits = this.waits.filter((wait) => !wait.cancelled);
      const due = this.waits.reduce<FakeWait | undefined>(
        (first, wait) =>
          wait.at <= until && (first === undefined || wait.at < first.at) ? wait : first,
        undefined,
      );
      if (due === undefined) break;
      this.waits = this.waits.filter((wait) => wait !== due);
      this.time = due.at;
      due.fn();
    }
    this.time = until;
  }
}

// --- VNode trees -------------------------------------------------------------

/** Whether a rendered child is an element / component node (as opposed to
 * text, a number, or an empty slot). */
export function isVNode(child: ComponentChild): child is VNode {
  return typeof child === "object" && child !== null && "type" in child && "props" in child;
}

/** Whether rendered children are a list (`Array.isArray` alone would narrow
 * them to `any[]`). */
export function isChildList(node: ComponentChildren): node is ComponentChild[] {
  return Array.isArray(node);
}

/** Every node under `node` (itself included) that `predicate` picks, in
 * document order. */
export function collect(
  node: ComponentChildren,
  predicate: (n: VNode) => boolean,
  acc: VNode[] = [],
): VNode[] {
  if (isChildList(node)) {
    for (const c of node) collect(c, predicate, acc);
    return acc;
  }
  if (!isVNode(node)) return acc;
  // Narrowing a ComponentChild picks its `VNode<any>` member; held as a
  // `VNode` its props are the typed `{ children }`.
  const element: VNode = node;
  if (predicate(element)) acc.push(element);
  collect(element.props.children, predicate, acc);
  return acc;
}

/** The text a rendered tree shows, concatenated. */
export function flattenText(node: ComponentChildren): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (isChildList(node)) return node.map(flattenText).join("");
  if (!isVNode(node)) return "";
  const element: VNode = node;
  return flattenText(element.props.children);
}

/** A rendered child a component received as a prop rather than as children
 * (an element or a text run): checked as one, so a walk can step into it. */
export const RenderedChildSchema = v.union([
  v.string(),
  v.custom<VNode>(
    (x) => typeof x === "object" && x !== null && "type" in x && "props" in x,
    "Expected a rendered element",
  ),
]);

/** A node's props, read through the schema of the props the test looks at
 * (the others are kept as they are); props of another shape fail the test. */
export function propsOf<const E extends v.ObjectEntries>(
  node: VNode,
  entries: E,
): v.InferOutput<v.LooseObjectSchema<E, undefined>> {
  const read = parseWith(v.looseObject(entries), node.props);
  if (!read.ok) throw new Error(`unexpected props of <${nameOf(node)}>: ${read.failure.summary}`);
  return read.value;
}

/** A string prop (`href`, `class`, `id`, ...), or undefined when the node has
 * none; a prop of another type fails the test. */
export function stringProp(node: VNode, name: string): string | undefined {
  return propsOf(node, { [name]: v.optional(v.string()) })[name];
}

/** A handler prop the test calls (`onClick`, `onToggle`, ...); a node without
 * one fails the test. */
export function handlerProp(node: VNode, name: string): () => void {
  const handler = defined(propsOf(node, { [name]: v.function() })[name], `the ${name} prop`);
  return () => {
    handler();
  };
}

const KeySchema = v.optional(v.union([v.string(), v.number()]));

/** A node's `key` (preact types it as `any`), or undefined when it has none. */
export function keyOf(node: VNode): string | number | undefined {
  const read = parseWith(KeySchema, node.key);
  if (!read.ok) throw new Error(`unexpected key of <${nameOf(node)}>: ${read.failure.summary}`);
  return read.value;
}

function nameOf(node: VNode): string {
  return typeof node.type === "string" ? node.type : node.type.name;
}

/** What a peer row says of where its session works, as the daemon derives it
 * (DR-0003 §3): `repo` an `owner/name` slug ("" for none) becomes
 * `repository`, `ws` a jj workspace name and `branch` the bookmark a hello
 * announced ("" for none) become `vcs.workspace` / `vcs.branch`. A part named
 * "" is set to undefined rather than left out, so that spreading this over a
 * peer that had one takes it away. */
export function peerLocation(
  repo: string,
  ws: string,
  branch = "",
): Pick<PeerInfo, "repository" | "vcs"> {
  const cut = repo.lastIndexOf("/");
  if (repo !== "" && cut <= 0) throw new Error(`expected an owner/name slug, got "${repo}"`);
  const owner = repo.slice(0, cut);
  const name = repo.slice(cut + 1);
  return {
    repository:
      repo !== ""
        ? { host: "github.com", owner, name, url: `https://github.com/${repo}` }
        : undefined,
    vcs:
      ws !== "" || branch !== ""
        ? {
            type: "jj",
            ...(ws !== "" ? { workspace: ws } : {}),
            ...(branch !== "" ? { branch } : {}),
            remotes: [],
          }
        : undefined,
  };
}

/** What became of an HTML paste (LINK_HTML) and then a plain one on `el`, a
 * message box's textarea, at the end of its text: whether each was taken from
 * the browser, and what the box holds after the HTML one went in. For the
 * tests of each box's wiring (DR-0065); how it goes in is
 * paste-html-as-markdown.dom.test.ts's. */
export async function pasteHtmlThenPlain(
  el: HTMLTextAreaElement,
): Promise<{ htmlTaken: boolean; value: string; plainTaken: boolean }> {
  const insert = stubInsertText();
  try {
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    const inserted = insert.next();
    const html = clipboardPaste(el, { "text/plain": "see the doc", "text/html": LINK_HTML });
    if (html.defaultPrevented) await inserted;
    const value = el.value;
    const plain = clipboardPaste(el, { "text/plain": "x" });
    return { htmlTaken: html.defaultPrevented, value, plainTaken: plain.defaultPrevented };
  } finally {
    insert.restore();
  }
}
