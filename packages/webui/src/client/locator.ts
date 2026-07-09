// URL fragment locator (DR-0004 §5): `#rXXXX` selects a room, `#rXXXX-mNN`
// selects a room and a message within it. Room ids are opaque server-issued
// tokens; splitting on the trailing `-m<digits>` suffix keeps this independent
// of the id's own shape.

export interface Locator {
  room: string | null;
  mid: number | null;
}

export function parseHash(hash: string): Locator {
  const raw = hash.replace(/^#/, "");
  if (!raw) return { room: null, mid: null };
  const m = raw.match(/^(.+)-m(\d+)$/);
  if (m) return { room: m[1] ?? null, mid: Number(m[2]) };
  return { room: raw, mid: null };
}

export function anchorId(roomId: string, mid: number): string {
  return `msg-${roomId}-${mid}`;
}

export function messageHref(roomId: string, mid: number): string {
  return `#${roomId}-m${mid}`;
}

export function roomHref(roomId: string): string {
  return `#${roomId}`;
}
