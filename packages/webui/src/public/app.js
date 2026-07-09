// ccmsg webui client (DR-0004). Vanilla ESM, no build step: this file is served
// as-is and imports ws-client.js as a relative ESM module.
import { WsClient } from "/ws-client.js";

const USER_UID = 0;

/** @typedef {{uid:number, sid:string, repo:string, ws:string, cwd:string, joined_at:string, left:boolean}} MemberInfo */
/** @typedef {{id:string, title?:string, membersByUid:Map<number,MemberInfo>, memberOrder:number[], msgs:Map<number,object>, timeline:object[], lastMid:number, lastTs:string|null}} RoomState */

const state = {
  /** @type {Map<string, RoomState>} */
  rooms: new Map(),
  /** @type {Array<{sid:string,repo:string,ws:string,cwd:string}>} */
  peers: [],
  currentRoomId: /** @type {string|null} */ (null),
  /** @type {Set<number>} mention targets for the compose box of the current room */
  mentionTo: new Set(),
};

const el = {
  status: document.getElementById("conn-status"),
  roomList: document.getElementById("room-list"),
  peerList: document.getElementById("peer-list"),
  roomView: document.getElementById("room-view"),
  menuToggle: document.getElementById("menu-toggle"),
  sidebar: document.getElementById("sidebar"),
  backdrop: document.getElementById("sidebar-backdrop"),
  peersRefresh: document.getElementById("peers-refresh"),
};

function ensureRoom(id) {
  let room = state.rooms.get(id);
  if (!room) {
    room = {
      id,
      title: undefined,
      membersByUid: new Map(),
      memberOrder: [],
      msgs: new Map(),
      timeline: [],
      lastMid: 0,
      lastTs: null,
    };
    state.rooms.set(id, room);
  }
  return room;
}

function applyRoomsResponse(detail) {
  if (!detail?.ok || !Array.isArray(detail.rooms)) return;
  for (const summary of detail.rooms) {
    const room = ensureRoom(summary.id);
    if (summary.title) room.title = summary.title;
    room.lastMid = summary.last_mid ?? room.lastMid;
    room.lastTs = summary.last_ts ?? room.lastTs;
    for (const m of summary.members ?? []) upsertMember(room, m);
  }
  renderSidebar();
}

function upsertMember(room, m) {
  if (!room.membersByUid.has(m.uid)) room.memberOrder.push(m.uid);
  room.membersByUid.set(m.uid, {
    uid: m.uid,
    sid: m.sid,
    repo: m.repo,
    ws: m.ws,
    cwd: m.cwd,
    joined_at: m.joined_at,
    left: room.membersByUid.get(m.uid)?.left ?? false,
  });
}

/** Fold one delivered event (`{...StorageEvent, r}` or backlog line) into room state. */
function applyEvent(ev) {
  const roomId = ev.r;
  if (!roomId) return;
  const room = ensureRoom(roomId);
  switch (ev.type) {
    case "member":
      upsertMember(room, ev);
      room.timeline.push(ev);
      break;
    case "leave": {
      const m = room.membersByUid.get(ev.uid);
      if (m) m.left = true;
      room.timeline.push(ev);
      break;
    }
    case "msg":
      if (!room.msgs.has(ev.mid)) {
        room.msgs.set(ev.mid, ev);
        room.timeline.push(ev);
      }
      room.lastMid = Math.max(room.lastMid, ev.mid);
      room.lastTs = ev.ts;
      break;
    case "title":
      room.title = ev.title;
      room.timeline.push(ev);
      break;
    case "next":
    case "prev":
      room.timeline.push(ev);
      break;
    default:
      return;
  }
  renderSidebar();
  if (state.currentRoomId === roomId) renderRoomView();
}

// --- locator (URL fragment) --------------------------------------------------
// `#rXXXX` selects a room, `#rXXXX-mNN` selects a room and scrolls to a message
// (DR-0004 §5). Room ids are opaque server-issued tokens; splitting on the last
// `-m<digits>` suffix keeps this independent of the id's own shape.

function parseHash() {
  const raw = location.hash.replace(/^#/, "");
  if (!raw) return { room: null, mid: null };
  const m = raw.match(/^(.+)-m(\d+)$/);
  if (m) return { room: m[1], mid: Number(m[2]) };
  return { room: raw, mid: null };
}

function anchorId(roomId, mid) {
  return `msg-${roomId}-${mid}`;
}

window.addEventListener("hashchange", () => applyLocator());

function applyLocator() {
  const { room, mid } = parseHash();
  state.currentRoomId = room;
  state.mentionTo.clear();
  renderSidebar();
  renderRoomView();
  if (room && mid !== null) {
    const target = document.getElementById(anchorId(room, mid));
    target?.scrollIntoView({ block: "center" });
  }
  closeMobileSidebar();
}

// --- rendering ---------------------------------------------------------------

function relTime(iso) {
  if (!iso) return "";
  const diffMs = Date.now() - new Date(iso).getTime();
  const s = Math.max(0, Math.floor(diffMs / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function memberLabel(uid, room) {
  if (uid === USER_UID) return "User";
  const m = room?.membersByUid?.get(uid);
  if (!m) return `u${uid}`;
  const short = m.sid ? m.sid.slice(0, 8) : `u${uid}`;
  return m.repo ? `${short} (${m.repo})` : short;
}

function activeRoomsSorted() {
  return [...state.rooms.values()].sort((a, b) => (b.lastTs ?? "").localeCompare(a.lastTs ?? ""));
}

function renderSidebar() {
  el.roomList.replaceChildren();
  for (const room of activeRoomsSorted()) {
    const li = document.createElement("li");
    if (room.id === state.currentRoomId) li.classList.add("active");
    const a = document.createElement("a");
    a.href = `#${room.id}`;
    const title = document.createElement("span");
    title.className = "room-title";
    title.textContent = room.title || room.id;
    const meta = document.createElement("span");
    meta.className = "room-meta";
    const memberCount = [...room.membersByUid.values()].filter((m) => !m.left).length;
    meta.textContent = `${memberCount} 名 · #${room.lastMid} · ${relTime(room.lastTs)}`;
    a.append(title, meta);
    li.append(a);
    el.roomList.append(li);
  }

  el.peerList.replaceChildren();
  for (const peer of state.peers) {
    const li = document.createElement("li");
    li.title = peer.cwd;
    li.textContent = `${peer.sid.slice(0, 8)} · ${peer.repo || "?"} · ${peer.ws || "?"}`;
    el.peerList.append(li);
  }
}

function renderRoomView() {
  el.roomView.replaceChildren();
  const room = state.currentRoomId ? state.rooms.get(state.currentRoomId) : null;
  if (!room) {
    const p = document.createElement("p");
    p.id = "empty-state";
    p.textContent = "room を選んでください";
    el.roomView.append(p);
    return;
  }

  const header = document.createElement("header");
  header.className = "room-header";
  const h2 = document.createElement("h2");
  h2.textContent = room.title || room.id;
  header.append(h2);

  const chips = document.createElement("div");
  chips.className = "member-chips";
  chips.append(memberChip(USER_UID, room));
  for (const uid of room.memberOrder) {
    const m = room.membersByUid.get(uid);
    if (m && !m.left) chips.append(memberChip(uid, room));
  }
  header.append(chips);
  el.roomView.append(header);

  const timeline = document.createElement("div");
  timeline.className = "timeline";
  for (const ev of room.timeline) timeline.append(renderTimelineItem(ev, room));
  el.roomView.append(timeline);

  el.roomView.append(renderComposer(room));
}

function memberChip(uid, room) {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "chip";
  if (uid === USER_UID) chip.classList.add("chip-user");
  if (state.mentionTo.has(uid)) chip.classList.add("chip-selected");
  chip.textContent = memberLabel(uid, room);
  chip.title = uid === USER_UID ? "User (uid 0)" : `uid ${uid}`;
  chip.addEventListener("click", () => {
    if (state.mentionTo.has(uid)) state.mentionTo.delete(uid);
    else state.mentionTo.add(uid);
    renderRoomView();
  });
  return chip;
}

function renderTimelineItem(ev, room) {
  const wrap = document.createElement("div");
  switch (ev.type) {
    case "msg": {
      wrap.className = "msg" + (ev.from === USER_UID ? " msg-user" : "");
      wrap.id = anchorId(room.id, ev.mid);
      const meta = document.createElement("div");
      meta.className = "msg-meta";
      const from = document.createElement("span");
      from.className = "msg-from";
      from.textContent = memberLabel(ev.from, room);
      meta.append(from);
      if (ev.to?.length) {
        const to = document.createElement("span");
        to.className = "msg-to";
        to.textContent = `→ ${ev.to.map((u) => memberLabel(u, room)).join(", ")}`;
        meta.append(to);
      }
      const time = document.createElement("span");
      time.className = "msg-time";
      time.textContent = relTime(ev.ts);
      meta.append(time);
      const anchor = document.createElement("a");
      anchor.className = "msg-anchor";
      anchor.href = `#${anchorId(room.id, ev.mid).replace("msg-", "")}`;
      anchor.textContent = `#${room.id}-m${ev.mid}`;
      meta.append(anchor);
      const body = document.createElement("div");
      body.className = "msg-body";
      body.textContent = ev.msg;
      wrap.append(meta, body);
      break;
    }
    case "member":
      wrap.className = "event event-member";
      wrap.textContent = `+ ${memberLabel(ev.uid, room)} が参加`;
      break;
    case "leave":
      wrap.className = "event event-leave";
      wrap.textContent = `− ${memberLabel(ev.uid, room)} が退出`;
      break;
    case "title":
      wrap.className = "event event-title";
      wrap.textContent = `title: ${ev.title}`;
      break;
    case "next": {
      wrap.className = "event event-link";
      const a = document.createElement("a");
      a.href = `#${ev.room}`;
      a.textContent = `→ 次スレ ${ev.room}`;
      wrap.append(a);
      break;
    }
    case "prev": {
      wrap.className = "event event-link";
      const a = document.createElement("a");
      a.href = `#${ev.room}`;
      a.textContent = `← 前スレ ${ev.room}`;
      wrap.append(a);
      break;
    }
    default:
      wrap.className = "event";
      wrap.textContent = JSON.stringify(ev);
  }
  return wrap;
}

function renderComposer(room) {
  const form = document.createElement("form");
  form.className = "composer";
  const mentionLabel = document.createElement("div");
  mentionLabel.className = "composer-mention";
  mentionLabel.textContent = state.mentionTo.size
    ? `→ ${[...state.mentionTo].map((u) => memberLabel(u, room)).join(", ")}`
    : "room 全体へ (member chip をクリックで mention)";
  const textarea = document.createElement("textarea");
  textarea.placeholder = "メッセージを入力";
  textarea.rows = 2;
  const send = document.createElement("button");
  send.type = "submit";
  send.textContent = "送信";
  form.append(mentionLabel, textarea, send);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = textarea.value.trim();
    if (!text) return;
    send.disabled = true;
    try {
      const to = [...state.mentionTo];
      const res = await client.post(room.id, text, to);
      if (res.ok) {
        applyEvent({
          type: "msg",
          mid: res.mid,
          from: USER_UID,
          ...(to.length ? { to } : {}),
          ts: new Date().toISOString(),
          msg: text,
          r: room.id,
        });
        textarea.value = "";
      }
    } finally {
      send.disabled = false;
    }
  });
  return form;
}

// --- mobile sidebar drawer ----------------------------------------------------

function openMobileSidebar() {
  el.sidebar.classList.add("open");
  el.backdrop.classList.add("visible");
}
function closeMobileSidebar() {
  el.sidebar.classList.remove("open");
  el.backdrop.classList.remove("visible");
}
el.menuToggle.addEventListener("click", () => {
  el.sidebar.classList.contains("open") ? closeMobileSidebar() : openMobileSidebar();
});
el.backdrop.addEventListener("click", closeMobileSidebar);

// --- connection status ---------------------------------------------------------

function setStatus(text, cls) {
  el.status.textContent = text;
  el.status.className = `status ${cls}`;
}

el.peersRefresh.addEventListener("click", async () => {
  const res = await client.peers();
  if (res.ok) {
    state.peers = res.peers;
    renderSidebar();
  }
});

// --- wire up ---------------------------------------------------------------

const client = new WsClient();
client.addEventListener("connecting-done", () => setStatus("connected", "status-ok"));
client.addEventListener("disconnected", () =>
  setStatus("disconnected – 再接続中…", "status-error"),
);
client.addEventListener("restarting", () => setStatus("daemon 再起動中…", "status-warn"));
client.addEventListener("rooms", (e) => applyRoomsResponse(e.detail));
client.addEventListener("subscribed", async () => {
  const res = await client.peers();
  if (res.ok) {
    state.peers = res.peers;
    renderSidebar();
  }
});
client.addEventListener("event", (e) => applyEvent(e.detail));

applyLocator();
client.connect();
