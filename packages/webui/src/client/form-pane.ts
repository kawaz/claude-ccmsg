// main ペイン側フォームパネルの幅 (FormPane.tsx)。描画から切り出してあるのは
// 他の永続値と同じ理由 — 幅の丸めと永続化をレンダラ無しで検証できるように
// (DR-0005 §1、session-creator.ts / files-view-store.ts と同じ約束)。
import { readStorage, writeStorage } from "./storage.ts";

export const FORM_PANE_WIDTH_KEY = "ccmsg.formPaneWidth";
export const FORM_PANE_MIN_PX = 320;
export const FORM_PANE_MAX_PX = 800;
/** 確定した cwd の表示に 422px 要る (docs/findings/2026-08-12-form-ux-width-
 * survey.md) ので、既定はそれを満たす幅にする。 */
export const FORM_PANE_DEFAULT_PX = 460;

/** 幅は #sidebar と同じく px 直値 (比率でないのは、フォームの必要幅が
 * ウィンドウ幅ではなく中身 — cwd の絶対パスや uuid — で決まるため)。 */
export function clampFormPaneWidth(w: number): number {
  if (!Number.isFinite(w)) return FORM_PANE_DEFAULT_PX;
  return Math.min(FORM_PANE_MAX_PX, Math.max(FORM_PANE_MIN_PX, w));
}

export function loadFormPaneWidth(): number {
  const raw = readStorage(FORM_PANE_WIDTH_KEY);
  return clampFormPaneWidth(raw === null ? FORM_PANE_DEFAULT_PX : Number(raw));
}

export function saveFormPaneWidth(width: number): void {
  writeStorage(FORM_PANE_WIDTH_KEY, String(width));
}
