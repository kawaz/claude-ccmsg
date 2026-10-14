// Timeline と、Timeline から切り出した hook をマウントして検証するための部品。
// daemon の代わりに transcript 系の要求 (transcript_read / subscribe /
// unsubscribe / fork_origin) を記録し、応答はテストが好きな時に返す。store は
// 本物を使うので、応答が reducer を通って Timeline に届くまでの配線がそのまま
// 検証される。
import { h, render, type ComponentChild } from "preact";
import { act } from "preact/test-utils";
import type { ReplyOf } from "@ccmsg/protocol";
import { AppContext } from "../src/client/context.ts";
import type { AgentRef } from "../src/client/locator.ts";
import { CLOSED_SIDEBAR } from "../src/client/sidebar-url.ts";
import { initialState } from "../src/client/store.ts";
import { createStore, type Store } from "../src/client/useStore.ts";
import { createWsClient, type WsHandle } from "../src/client/ws.ts";
import {
  assistantContentRow,
  line as jsonl,
  textBlock,
  userContentRow,
} from "../../protocol/test/transcript-rows.ts";

export const SID = "aaaaaaaa-0000-4000-8000-000000000001";

type ReadOpts = Parameters<WsHandle["transcriptRead"]>[1];

export interface PendingRead {
  sid: string;
  opts: ReadOpts;
  /** その要求に応答を返す。reducer まで流し終えてから解決する。 */
  answer(reply: ReplyOf<"transcript_read">): Promise<void>;
}

/** transcript 系の要求を記録する ws。それ以外の要求は接続していない本物の
 * client に任せる (送ると reject されるので、使われたらテストが気づく)。 */
export class FakeTranscriptWs {
  readonly reads: PendingRead[] = [];
  readonly subscribes: string[] = [];
  readonly unsubscribes: string[] = [];
  readonly forkOrigins: string[] = [];
  readonly handle: WsHandle;

  constructor(store: Store) {
    const base = createWsClient(
      (action) => store.dispatch(action),
      () => store.getState(),
    );
    this.handle = {
      ...base,
      transcriptRead: (sid, opts) => {
        let resolveReply: (reply: ReplyOf<"transcript_read">) => void = () => {};
        const replied = new Promise<ReplyOf<"transcript_read">>((resolve) => {
          resolveReply = resolve;
        });
        this.reads.push({
          sid,
          opts,
          // 要求側の then は応答より先に登録されているので、`await replied` の
          // 続きはその then (store への dispatch) の後に回る。
          answer: (reply) =>
            act(async () => {
              resolveReply(reply);
              await replied;
            }),
        });
        return replied;
      },
      transcriptSubscribe: (sid) => {
        this.subscribes.push(sid);
        return Promise.resolve({ ok: true, sid, size: 0 });
      },
      transcriptUnsubscribe: (sid) => {
        this.unsubscribes.push(sid);
        return Promise.resolve({ ok: true, sid });
      },
      forkOrigin: (sid) => {
        this.forkOrigins.push(sid);
        return Promise.resolve({ ok: true, origin: null });
      },
    };
  }

  /** 最後に出た transcript_read。無ければテストを落とす。 */
  lastRead(): PendingRead {
    const read = this.reads.at(-1);
    if (read === undefined) throw new Error("expected a transcript_read, found none");
    return read;
  }
}

/** sid の Timeline を開いた store。`position` は `/timeline/<uuid>` の位置。 */
export function timelineStore(
  options: { position?: string; agent?: AgentRef; connected?: boolean } = {},
): Store {
  const store = createStore(initialState());
  store.dispatch({
    type: "locator/changed",
    locator: {
      view: "timeline",
      sid: SID,
      ...(options.position !== undefined ? { position: options.position } : {}),
      ...(options.agent !== undefined ? { agent: options.agent } : {}),
    },
    sidebar: CLOSED_SIDEBAR,
  });
  if (options.connected ?? true) store.dispatch({ type: "conn/status", status: "connected" });
  return store;
}

/** 1 往復分 (ユーザの発話と assistant の応答) の行。uuid は `u<n>` / `a<n>`。 */
export function exchange(n: number, words = `question ${n}`): string[] {
  return [
    jsonl(userContentRow(words, { uuid: uuidOf("u", n) })),
    jsonl(assistantContentRow([textBlock(`answer ${n}`)], { uuid: uuidOf("a", n) })),
  ];
}

export function uuidOf(kind: "u" | "a", n: number): string {
  const tail = String(n).padStart(4, "0");
  return `00000000-0000-4000-8000-${kind === "u" ? "1" : "2"}0000000${tail}`;
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** `start` から並ぶ `lines` を返す transcript_read の成功応答。`end` は行の
 * byte 長 (改行込み) から数え、`size` は `end` と同じ (末尾まで読んだ)。 */
export function page(lines: readonly string[], start = 0): ReplyOf<"transcript_read"> {
  const end = lines.reduce((sum, text) => sum + utf8Bytes(text) + 1, start);
  return { ok: true, sid: SID, lines: [...lines], start, end, size: end };
}

/** `page` と同じ数え方で、`start` から並ぶ `lines` の終わりの byte 位置。 */
export function endOf(lines: readonly string[], start: number): number {
  return lines.reduce((sum, text) => sum + utf8Bytes(text) + 1, start);
}

export class Mounted {
  private root: HTMLElement | null = null;

  async mount(store: Store, ws: WsHandle, vnode: ComponentChild): Promise<HTMLElement> {
    const root = document.createElement("div");
    document.body.append(root);
    this.root = root;
    await act(() => render(h(AppContext.Provider, { value: { store, ws } }, vnode), root));
    return root;
  }

  async rerender(store: Store, ws: WsHandle, vnode: ComponentChild): Promise<void> {
    const root = this.root;
    if (root === null) throw new Error("rerender before mount");
    await act(() => render(h(AppContext.Provider, { value: { store, ws } }, vnode), root));
  }

  async unmount(): Promise<void> {
    const root = this.root;
    this.root = null;
    if (root === null) return;
    await act(() => render(null, root));
    root.remove();
  }
}
