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
