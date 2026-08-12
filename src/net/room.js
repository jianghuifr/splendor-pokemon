// 薄传输层：把 Trystero 房间包成「带类型的消息总线」，不含任何游戏规则。
// 所有消息走单个 Trystero action（'msg'），避免 action 名长度限制并保证顺序一致。
import { loadTrystero, APP_ID } from './trystero.js';

// 建立房间连接。返回消息总线；上层（session.js）在此之上实现 host 权威协议。
export async function joinGameRoom(roomId, identity) {
  const { joinRoom, selfId } = await loadTrystero();
  const room = joinRoom({ appId: APP_ID }, roomId, {
    onJoinError: (info) => console.warn('信令连接告警', info),
  });
  // 0.25 起 makeAction 返回 {send, onMessage} 对象，不再是 [send, receive] 元组。
  const msg = room.makeAction('msg');

  const handlers = new Map();   // type -> Set<fn(payload, peerId)>
  const joinCbs = new Set();
  const leaveCbs = new Set();
  const peerNames = new Map();  // peerId -> {id, name}

  // 第二参现在是元数据对象，peerId 在其中，不再是裸 peerId。
  msg.onMessage = (raw, meta) => {
    if (!raw || typeof raw !== 'object') return;
    const set = handlers.get(raw.t);
    if (!set) return;
    const peerId = meta?.peerId;
    for (const fn of set) {
      try { fn(raw.d, peerId); } catch (e) { console.error('handler error', raw.t, e); }
    }
  };

  // onPeerJoin/onPeerLeave 是访问器属性，赋值即覆盖；多方订阅靠下面的回调集合扇出。
  room.onPeerJoin = (peerId) => { for (const cb of joinCbs) cb(peerId); };
  room.onPeerLeave = (peerId) => {
    peerNames.delete(peerId);
    for (const cb of leaveCbs) cb(peerId);
  };

  return {
    roomId,
    selfPeerId: selfId,
    identity,

    // send(type, data)                -> 广播
    // send(type, data, 'peerId')       -> 单发
    // send(type, data, ['a','b'])      -> 组发
    // target 走选项对象；单个 peerId 和 peerId 数组都支持。
    send(type, data, target) {
      return msg.send({ t: type, d: data }, target ? { target } : undefined)
        .catch((e) => { console.warn('发送失败', type, e?.message || e); });
    },

    on(type, fn) {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type).add(fn);
      return () => handlers.get(type).delete(fn);
    },

    onPeerJoin(cb) { joinCbs.add(cb); return () => joinCbs.delete(cb); },
    onPeerLeave(cb) { leaveCbs.add(cb); return () => leaveCbs.delete(cb); },

    peers() { return Object.keys(room.getPeers()); },
    peerCount() { return Object.keys(room.getPeers()).length; },

    // 记录 peerId ↔ 身份 的映射，供上层把网络端点对应到座位。
    remember(peerId, info) { peerNames.set(peerId, info); },
    lookup(peerId) { return peerNames.get(peerId) || null; },

    leave() {
      handlers.clear(); joinCbs.clear(); leaveCbs.clear();
      try { room.leave(); } catch { /* 已断开 */ }
    },
  };
}

// 生成便于口头分享的房间码，如 PKMN-7F3Q。
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function makeRoomCode() {
  let s = '';
  const buf = new Uint8Array(4);
  crypto.getRandomValues(buf);
  for (const b of buf) s += CODE_CHARS[b % CODE_CHARS.length];
  return 'PKMN-' + s;
}

export function normalizeRoomCode(input) {
  const raw = (input || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!raw) return null;
  const body = raw.startsWith('PKMN') ? raw.slice(4) : raw;
  if (body.length < 3) return null;
  return 'PKMN-' + body.slice(0, 8);
}
