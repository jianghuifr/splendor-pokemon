// 大厅：所有人加入同一个公共信令房间，互相广播状态，从而看到「谁在线」和「哪些房间可加入」。
// 大厅只做发现，不承载对局流量；真正的对局在各自的房间里点对点跑。
import { joinGameRoom } from './room.js';
import { getIdentity } from './identity.js';

const LOBBY_ID = 'pkmn-splendor-lobby-v1';
const BEAT_MS = 5000;      // 心跳间隔
const STALE_MS = 16000;    // 超过则视为离线

export async function joinLobby() {
  const identity = getIdentity();
  const room = await joinGameRoom(LOBBY_ID, identity);
  const seen = new Map();    // id -> {presence, at}
  const cbs = new Set();

  let mine = { id: identity.id, name: identity.name, status: 'idle', roomId: null, seats: 0, max: 4 };

  const snapshot = () => {
    const now = Date.now();
    const live = [];
    for (const [id, rec] of seen) {
      if (now - rec.at > STALE_MS) { seen.delete(id); continue; }
      live.push(rec.presence);
    }
    const people = [mine, ...live].sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    const rooms = [];
    const byRoom = new Map();
    for (const p of people) {
      if (p.status !== 'hosting' || !p.roomId) continue;
      byRoom.set(p.roomId, { roomId: p.roomId, host: p.name, hostId: p.id, seats: p.seats || 1, max: p.max || 4, mine: p.id === identity.id });
    }
    for (const r of byRoom.values()) rooms.push(r);
    return { people, rooms, selfId: identity.id };
  };

  const fire = () => { const snap = snapshot(); for (const cb of [...cbs]) { try { cb(snap); } catch (e) { console.error(e); } } };

  room.on('presence', (p) => {
    if (!p || !p.id || p.id === identity.id) return;
    seen.set(p.id, { presence: p, at: Date.now() });
    fire();
  });

  // 新 peer 进来时立刻自报一次，免得对方等下一个心跳。
  room.on('ping', () => room.send('presence', mine));
  room.onPeerJoin(() => { room.send('presence', mine); });
  room.onPeerLeave(() => fire());

  const beat = setInterval(() => { room.send('presence', mine); fire(); }, BEAT_MS);
  room.send('presence', mine);
  room.send('ping', {});

  return {
    onUpdate(cb) { cbs.add(cb); cb(snapshot()); return () => cbs.delete(cb); },

    // 状态变化时立即广播，让别人的列表尽快刷新。
    announce(patch) {
      mine = { ...mine, ...patch, id: identity.id };
      room.send('presence', mine);
      fire();
    },

    snapshot,
    leave() {
      clearInterval(beat);
      mine.status = 'offline';
      try { room.send('presence', mine); } catch { /* 已断开 */ }
      room.leave();
      cbs.clear();
    },
  };
}
