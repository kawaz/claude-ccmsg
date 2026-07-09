import type { ConnStatus } from "../store.ts";

const LABELS: Record<ConnStatus, { text: string; cls: string }> = {
  connecting: { text: "connecting…", cls: "status-connecting" },
  connected: { text: "connected", cls: "status-ok" },
  disconnected: { text: "disconnected – 再接続中…", cls: "status-error" },
  restarting: { text: "daemon 再起動中…", cls: "status-warn" },
};

export function ConnectionStatus({ status }: { status: ConnStatus }) {
  const { text, cls } = LABELS[status];
  return (
    <span id="conn-status" class={`status ${cls}`}>
      {text}
    </span>
  );
}
