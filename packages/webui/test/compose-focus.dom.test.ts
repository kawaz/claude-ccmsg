// The input box's textarea keeps the person's focus and caret across the
// box's own controls (DR-0062 §3, §15, kawaz 2026-11-24), mounted with the
// parts the FAB's box and the comment form share.
// 何を保証するか:
//   - textarea にフォーカスがある間、btw / 後で のピル・添付の ×・📎 の押し始めは既定の動きを
//     止め (フォーカスを動かさない)、押した操作 (click) はそのまま効く
//   - textarea にフォーカスが無い時 (ボタンにフォーカスして押した等) は止めない (フォーカスを
//     textarea に移さない)
//   - 添付の × の後も、textarea のキャレットは本文の同じ所 (外した [FILE<N>] の分だけ前) に居る
//   - ファイルの選択が閉じた時 (選んだ時も、取り消した時も)、開く前に textarea に居たなら
//     textarea にフォーカスと元のキャレットの範囲が戻る。選んだファイルはその戻ったキャレットに
//     入る (onFiles が呼ばれる時にはもう戻っている)。開く前に居なかったなら戻さない
import { afterEach, describe, expect, test } from "bun:test";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import {
  AttachFileButton,
  ComposerAttachments,
} from "../src/client/components/ComposerAttachments.tsx";
import { ComposeTextareaContext } from "../src/client/components/compose-focus.ts";
import { SendModePill, type SendMode } from "../src/client/components/SendModePill.tsx";
import {
  useAttachmentBox,
  useAttachmentInput,
} from "../src/client/components/useAttachmentInput.ts";
import type { ComposerAttachment } from "../src/client/components/composer-attachments.ts";
import { useRef, useState } from "preact/hooks";
import { withDom } from "./dom.ts";
import { instanceOf } from "./helpers.ts";

withDom();

const roots: HTMLElement[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(() => render(null, root));
    root.remove();
  }
});

const FILE1: ComposerAttachment = {
  n: 1,
  name: "a.txt",
  status: "done",
  progress: 100,
  path: "/tmp/a.txt",
};

interface Seen {
  modes: SendMode[];
  files: Array<{ names: string[]; active: boolean; caret: number }>;
}

/** An input box as the FAB's and the comment form are: its textarea, the
 * chips, the 📎 and the pill, under the textarea's context. */
function Box({ seen, onFiles }: { seen: Seen; onFiles?: (files: readonly File[]) => void }) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const box = useAttachmentBox(() => ({ text: "ab[FILE1]cdef", attachments: [FILE1] }));
  const attach = useAttachmentInput({
    textareaRef,
    content: box.content,
    edit: box.edit,
    locked: () => false,
    text: box.text,
  });
  const [mode, setMode] = useState<SendMode>("now");
  return h(
    ComposeTextareaContext.Provider,
    { value: textareaRef },
    h("textarea", {
      ref: textareaRef,
      value: box.text,
      onInput: (event: Event) => {
        const target = event.currentTarget;
        if (target instanceof HTMLTextAreaElement) {
          box.edit({ text: target.value, attachments: box.content.current.attachments });
        }
      },
    }),
    h(ComposerAttachments, { attachments: box.attachments, onRemove: attach.removeAttachment }),
    h(AttachFileButton, {
      onFiles:
        onFiles ??
        ((files: readonly File[]) => {
          const el = textareaRef.current;
          seen.files.push({
            names: files.map((file) => file.name),
            active: el !== null && document.activeElement === el,
            caret: el?.selectionStart ?? -1,
          });
        }),
      disabled: false,
    }),
    h(SendModePill, {
      mode,
      onChange: (next: SendMode) => {
        seen.modes.push(next);
        setMode(next);
      },
      disabled: false,
    }),
  );
}

async function mount(): Promise<{ root: HTMLElement; seen: Seen; textarea: HTMLTextAreaElement }> {
  const root = document.createElement("div");
  document.body.append(root);
  roots.push(root);
  const seen: Seen = { modes: [], files: [] };
  await act(() => render(h(Box, { seen }), root));
  return {
    root,
    seen,
    textarea: instanceOf(root.querySelector("textarea"), HTMLTextAreaElement, "the textarea"),
  };
}

function button(root: HTMLElement, selector: string): HTMLButtonElement {
  return instanceOf(root.querySelector(selector), HTMLButtonElement, selector);
}

/** A press of `el` by a pointer: its pointerdown (whether its default was
 * taken), then its click. */
async function press(el: HTMLElement): Promise<boolean> {
  const down = new PointerEvent("pointerdown", { bubbles: true, cancelable: true });
  el.dispatchEvent(down);
  await act(() => el.click());
  return down.defaultPrevented;
}

describe("the box's controls keep the textarea's focus", () => {
  test("in the textarea, a press of 後で / btw / × / 📎 takes no default, and does what it does", async () => {
    const { root, seen, textarea } = await mount();
    textarea.focus();
    textarea.setSelectionRange(1, 1);
    expect(await press(button(root, ".session-input-later"))).toBe(true);
    expect(await press(button(root, ".session-input-btw"))).toBe(true);
    expect(seen.modes).toEqual(["later", "btw"]);
    expect(await press(button(root, ".composer-attach-btn"))).toBe(true);
    expect(await press(button(root, ".composer-attachment-remove"))).toBe(true);
    expect(textarea.value).toBe("abcdef");
    expect(document.activeElement).toBe(textarea);
  });

  test("not in the textarea, a press takes its default (the focus is not brought to the textarea)", async () => {
    const { root } = await mount();
    const later = button(root, ".session-input-later");
    later.focus();
    expect(await press(later)).toBe(false);
    expect(document.activeElement).not.toBe(root.querySelector("textarea"));
  });

  test("a × leaves the caret where it was in the text, before the [FILE<N>] taken out", async () => {
    const { root, textarea } = await mount();
    textarea.focus();
    // After "ab[FILE1]c": 10.
    textarea.setSelectionRange(10, 10);
    await press(button(root, ".composer-attachment-remove"));
    expect(textarea.value).toBe("abcdef");
    expect(document.activeElement).toBe(textarea);
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([3, 3]);
  });
});

describe("the file choice gives the textarea its focus and caret back", () => {
  function fileInput(root: HTMLElement): HTMLInputElement {
    return instanceOf(root.querySelector("input[type=file]"), HTMLInputElement, "the file input");
  }

  test("closed with a choice: back before the files go in, at the caret it had", async () => {
    const { root, seen, textarea } = await mount();
    textarea.focus();
    textarea.setSelectionRange(4, 6);
    await press(button(root, ".composer-attach-btn"));
    // The system's screen takes the focus.
    textarea.blur();
    const input = fileInput(root);
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [new File(["x"], "b.txt")],
    });
    await act(() => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(seen.files).toEqual([{ names: ["b.txt"], active: true, caret: 4 }]);
    expect(document.activeElement).toBe(textarea);
  });

  test("closed with none (cancel): back with the range it had", async () => {
    const { root, textarea } = await mount();
    textarea.focus();
    textarea.setSelectionRange(1, 3);
    await press(button(root, ".composer-attach-btn"));
    textarea.blur();
    await act(() => {
      fileInput(root).dispatchEvent(new Event("cancel"));
    });
    expect(document.activeElement).toBe(textarea);
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([1, 3]);
  });

  test("opened from outside the textarea: nothing is given back", async () => {
    const { root, textarea } = await mount();
    const attachButton = button(root, ".composer-attach-btn");
    attachButton.focus();
    await press(attachButton);
    await act(() => {
      fileInput(root).dispatchEvent(new Event("cancel"));
    });
    expect(document.activeElement).not.toBe(textarea);
  });
});
