// 戻る / 進むボタンの可否。履歴は Navigation API が持つ外部の状態なので、
// render 中に window.navigation を読まず useSyncExternalStore で購読する。
// 履歴が動く遷移 (push / replace / traverse) はどれも currententrychange を
// 伴うので、それを変化の合図にする。
import { useSyncExternalStore } from "preact/compat";

function subscribeCurrentEntry(onChange: () => void): () => void {
  window.navigation.addEventListener("currententrychange", onChange);
  return () => window.navigation.removeEventListener("currententrychange", onChange);
}

export function useCanGoBack(): boolean {
  return useSyncExternalStore(subscribeCurrentEntry, () => window.navigation.canGoBack);
}

export function useCanGoForward(): boolean {
  return useSyncExternalStore(subscribeCurrentEntry, () => window.navigation.canGoForward);
}

/** The current URL's fragment without its `#`, percent-decoded (`""` for
 * none). The fragment names a place inside what the page shows — an id in a
 * markdown preview — and is not part of the locator the store keeps, so the
 * one that goes to that place reads it here. A fragment that does not decode
 * is taken as written. */
export function useLocationFragment(): string {
  return useSyncExternalStore(subscribeCurrentEntry, () => {
    const raw = location.hash.slice(1);
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  });
}
