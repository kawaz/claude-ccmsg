// Open/closed state for every fold in one Timeline, held outside the fold
// components that display it.
//
// Two things need it out there. Nav (search ↑/↓, a `/timeline/<uuid>` pin)
// has to open a fold whose body is not mounted yet, so it cannot go through
// the DOM the way it used to — it opens by key, and the fold re-renders with
// a body. And a fold's state has to outlive its component, which is what lets
// a later windowing pass unmount folds without silently re-closing them.
//
// Per-key subscription rather than one context value: opening a fold must
// re-render that fold alone. A shared value would hand every memoized
// FoldGroup a new prop on each toggle and undo the memoization that keeps a
// live tail cheap (see MemoLineView's doc comment).

type Listener = () => void;

export class FoldOpenStore {
  /** Only folds the reader (or nav) has actually touched. Absent means "still
   * at the caller's default", which is how an auto-open settings change can
   * take effect without this store knowing what any group's default is. */
  private readonly overrides = new Map<string, boolean>();
  /** Folds whose body has been mounted once. Re-closing keeps the body around:
   * it holds state the reader would notice losing — a thinking segment's ja
   * translation, an item switched to jsonl — and re-opening is meant to look
   * like it was never closed. */
  private readonly mounted = new Set<string>();
  private readonly listeners = new Map<string, Set<Listener>>();
  /** Fires when any fold's body is mounted for the first time. Nav that had to
   * open a fold waits on this rather than on a timer: the element it wants to
   * scroll to comes into existence with that render and not before. */
  private readonly mountListeners = new Set<Listener>();

  isOpen(key: string, fallback: boolean): boolean {
    return this.overrides.get(key) ?? fallback;
  }

  /** Whether this fold's body should be rendered: open now, or open before. */
  isBodyMounted(key: string): boolean {
    return this.mounted.has(key);
  }

  /** Latch a fold whose body is being rendered without anyone having opened it
   * — an auto-open group starts open, so nothing calls `set` on it. */
  markMounted(key: string): void {
    if (this.mounted.has(key)) return;
    this.mounted.add(key);
    for (const listener of this.mountListeners) listener();
  }

  set(key: string, open: boolean): void {
    if (open) this.markMounted(key);
    if (this.overrides.get(key) === open) return;
    this.overrides.set(key, open);
    this.notify(key);
  }

  subscribeMounted(listener: Listener): () => void {
    this.mountListeners.add(listener);
    return () => this.mountListeners.delete(listener);
  }

  /** Back to every fold's own default (the auto-open settings changed). The
   * mounted latch deliberately survives — an auto-open revision re-closes
   * folds, it does not discard what is inside them. */
  reset(): void {
    if (this.overrides.size === 0) return;
    const keys = [...this.overrides.keys()];
    this.overrides.clear();
    for (const key of keys) this.notify(key);
  }

  subscribe(key: string, listener: Listener): () => void {
    let set = this.listeners.get(key);
    if (!set) {
      set = new Set();
      this.listeners.set(key, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(key);
    };
  }

  private notify(key: string): void {
    for (const listener of this.listeners.get(key) ?? []) listener();
  }
}
