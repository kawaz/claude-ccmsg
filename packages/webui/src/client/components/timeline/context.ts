// Timeline 直下でだけ供給できる共有状態の context と、それを読む hook。
import { createContext } from "preact";
import { useCallback, useContext, useEffect, useState } from "preact/hooks";
import { type PeerInfo } from "@ccmsg/protocol";
import { type RoomState } from "../../store.ts";
import { useResettableState } from "../../useKeyedState.ts";
import { type FilePathResolveCtx } from "../../filepath-ref.ts";
import { FoldOpenStore } from "../../fold-open-store.ts";
import { defaultTimelineAutoOpen } from "../../timeline-auto-open.ts";
import { type TimelineAutoOpenContextValue } from "./useAutoOpenSettings.ts";
import { type ItemRawLookup } from "./useTranscriptModel.ts";

export const ItemRawContext = createContext<ItemRawLookup | null>(null);

export const AgentTimelineHrefsContext = createContext<ReadonlyMap<string, string>>(new Map());
export const FileToolSidContext = createContext("");

/** Sender-scoped `FilePathResolveCtx` for the session that this Timeline pane
 * belongs to (kawaz r46m62): TL displays this session's own transcript, so
 * the "sender" of every assistant / thinking segment is the session owner
 * itself, and `filepath[:LINE[:COL]]` inline-code tokens should resolve
 * against that session's own cwd/repo_root. Undefined when the daemon has
 * not yet announced the peer row (rare — cleared to plain code, same as
 * before this DR). The `LinkedMarkdownView` at each MarkdownView call site
 * consumes this via useContext. */
export const SessionFilePathCtxContext = createContext<FilePathResolveCtx | undefined>(undefined);

export const TimelineAutoOpenContext = createContext<TimelineAutoOpenContextValue>({
  settings: defaultTimelineAutoOpen(false),
  revision: 0,
});

/** Open/closed state for every fold in this Timeline, so that nav can open one
 * whose body is not mounted yet. The value is a store object created once per
 * Timeline, never a new object per toggle — see fold-open-store.ts. */
export const FoldOpenContext = createContext<FoldOpenStore>(new FoldOpenStore());

/**
 * A fold's own view of that store: `open` for the `<details>`, `mountBody` for
 * whether to render the body at all.
 *
 * A closed fold's body is 72-96% of a real transcript
 * (docs/findings/2026-08-12-timeline-windowing-design.md) and none of it is
 * visible until the fold opens, so it is not rendered until then. A closed
 * `<details>` is exactly as tall either way, so nothing above or below it
 * moves when the body appears — this buys the node count without any of the
 * scroll-anchoring machinery a windowed list would need.
 *
 * `mountBody` stays true once opened, so closing does not throw away state the
 * reader can see (a translated thinking segment, an item toggled to jsonl).
 */
export function useFoldOpen(
  key: string,
  defaultOpen: boolean,
): {
  open: boolean;
  mountBody: boolean;
  setOpen: (open: boolean) => void;
} {
  const store = useContext(FoldOpenContext);
  const [, bump] = useState(0);
  useEffect(() => store.subscribe(key, () => bump((n) => n + 1)), [store, key]);
  const open = store.isOpen(key, defaultOpen);
  useEffect(() => {
    if (open) store.markMounted(key);
  }, [store, key, open]);
  const setOpen = useCallback((next: boolean) => store.set(key, next), [store, key]);
  return { open, mountBody: open || store.isBodyMounted(key), setOpen };
}

/** Fold-group 内で peer 発 CcmsgBubble を描画するために必要な、Timeline 直下で
 * だけ供給できる共有状態のバンドル (r55 m14, kawaz 裁定: peer 発 ccmsg は
 * boundary から外して fold group 内で thinking/agent と同格に扱う)。
 *
 * - now: msg 相対時刻の再描画 tick 値 (useNow)
 * - rooms/peers: CcmsgBubble の rich 表示 (identicon / hue / filepath-linker)
 *   に必要な AppState の投影
 * - visibleCcmsgKeys: `ccmsgRenderTargets` が確定させた「描画するバブル」の
 *   key 集合 (boundary 側と共有)。同じ ccmsg event が両経路に流れても一箇所
 *   だけ残る (kawaz r15 mid=21 の 2 重表示回避方針を維持)
 *
 * boundary 側 CcmsgBubble が使う registerUserTurnRef / onUserTurnClick /
 * selected / navKey は u1 発 (右寄せユーザバブル) 限定の user-nav 用配線で、
 * peer 発 (fold group 内) では未使用 — 本 context には含めない。
 */
export interface CcmsgRenderCtxValue {
  now: number;
  rooms: ReadonlyMap<string, RoomState>;
  peers: readonly PeerInfo[];
  visibleCcmsgKeys: ReadonlySet<string>;
}
export const CcmsgRenderContext = createContext<CcmsgRenderCtxValue | null>(null);

export function useCategoryOpen(
  category: "thinking" | "ccmsg" | "agent",
): [boolean, (open: boolean) => void] {
  const { settings, revision } = useContext(TimelineAutoOpenContext);
  // 自動展開の設定が変わる (revision が進む) たびに、その設定の既定値へ戻す。
  return useResettableState([revision], () => settings[category]);
}
