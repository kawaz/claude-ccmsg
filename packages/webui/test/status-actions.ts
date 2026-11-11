// The Status tab's operations lists (セッション操作 and the danger zone) and the
// dialogs their rows open, as the tests reach them: a row by its name, its
// button, the dialog by its title, and the dialog's ways to close.
import { act } from "preact/test-utils";
import { instanceOf } from "./helpers.ts";

/** The operations row named `name`, or null when it is not offered. */
export function actionRow(root: HTMLElement, name: string): HTMLElement | null {
  const found = [...root.querySelectorAll(".status-action")].find(
    (row) => row.querySelector(".status-action-name")?.textContent === name,
  );
  return found === undefined ? null : instanceOf(found, HTMLElement, `the ${name} row`);
}

/** The names of the rows of the list `listSelector`, in order. */
export function actionNames(root: HTMLElement, listSelector: string): string[] {
  return [...root.querySelectorAll(`${listSelector} .status-action-name`)].map(
    (name) => name.textContent ?? "",
  );
}

/** The button at the end of the row named `name`. */
export function actionButton(root: HTMLElement, name: string): HTMLButtonElement {
  return instanceOf(
    actionRow(root, name)?.querySelector("button"),
    HTMLButtonElement,
    `the ${name} row's button`,
  );
}

/** Press the row's button and let what it opens (and reads) land. */
export async function openAction(root: HTMLElement, name: string): Promise<void> {
  await act(() => actionButton(root, name).click());
  for (let i = 0; i < 3; i++) await act(() => Promise.resolve());
}

/** The open dialog titled `title`, or null. */
export function dialogTitled(root: HTMLElement, title: string): HTMLDialogElement | null {
  const found = [...root.querySelectorAll("dialog.modal-dialog")].find(
    (dialog) => dialog.querySelector(".modal-dialog-title")?.textContent === title,
  );
  return found === undefined ? null : instanceOf(found, HTMLDialogElement, `the ${title} dialog`);
}

/** Escape on a modal dialog, as the browser delivers it: a cancelable
 * `cancel` event. Returns whether the dialog let it through (the default not
 * prevented is the browser closing it on its own; the dialog always takes
 * it over, so this is false). */
export async function pressEscape(dialog: HTMLDialogElement): Promise<boolean> {
  let notPrevented = true;
  await act(() => {
    notPrevented = dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
  });
  return notPrevented;
}

/** The dialog's × button. */
export function closeButton(dialog: HTMLDialogElement): HTMLButtonElement {
  return instanceOf(
    dialog.querySelector(".modal-dialog-close"),
    HTMLButtonElement,
    "the dialog's close button",
  );
}

/** The OverrideSelect named `label` in `form`, at rest: the text that shows
 * the option chosen and opens the select when pressed. */
export function pickText(form: Element | null, label: string): HTMLButtonElement {
  return instanceOf(
    form?.querySelector(`button.override-value[aria-label="${label}"]`),
    HTMLButtonElement,
    `the ${label} select at rest`,
  );
}

/** Press the OverrideSelect named `label` in `form` and choose `value` in
 * the select drawn in its place. */
export async function choosePick(
  form: Element | null,
  label: string,
  value: string,
): Promise<void> {
  await act(() => pickText(form, label).click());
  const select = instanceOf(
    form?.querySelector(`select[aria-label="${label}"]`),
    HTMLSelectElement,
    `the ${label} select`,
  );
  await act(() => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
