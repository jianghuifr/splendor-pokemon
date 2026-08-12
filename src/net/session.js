// 会话层：把「谁能操作哪个座位」和「状态从哪来」抽象掉，让 UI 一套代码跑热座与联机。
//
// 联机采用 host 权威：只有房主跑引擎。客户端把意图发给房主，房主校验后广播新状态。
// 引擎是纯函数，客户端手里也有完整状态，因此可本地预演来做即时校验（如超 10 弃宝石），
// 只在最终动作成型后发一次意图，无额外往返。
import { createGame, applyAction } from '../game/engine.js';
import { joinGameRoom } from './room.js';
import { getIdentity } from './identity.js';

// buffer:true 会把「还没有订阅者时」触发的事件存下来，等第一个订阅者接上再补发。
// 通知需要它：房主的 deny（如房间已满）可能在 UI 订阅之前就到了，
// 丢掉的话被拒的人会卡在房间里、看不到任何原因。
function emitter({ buffer = false } = {}) {
  const cbs = new Set();
  let pending = buffer ? [] : null;
  return {
    on(cb) {
      cbs.add(cb);
      if (pending && pending.length) {
        const queued = pending; pending = [];
        for (const args of queued) { try { cb(...args); } catch (e) { console.error(e); } }
      }
      return () => cbs.delete(cb);
    },
    fire(...a) {
      if (!cbs.size && pending) { pending.push(a); return; }
      for (const cb of [...cbs]) { try { cb(...a); } catch (e) { console.error(e); } }
    },
  };
}

// ---------- 热座：本机轮流操作，所有座位都归我 ----------
export function createHotSeatSession(infos) {
  const changed = emitter();
  const s = {
    mode: 'hot',
    isHost: true,
    phase: 'playing',
    state: createGame(infos),
    roster: infos.map((p) => ({ ...p, online: true, ready: true })),
    myId: null,                 // 热座无固定座位
    controls: () => true,       // 任何座位都可操作
    onChange: changed.on,
    submit(action) {
      const actor = s.state.players[s.state.current];
      const res = applyAction(s.state, actor.id, action);
      if (!res.ok) return res;
      s.state = res.state;
      changed.fire({ events: res.events });
      return res;
    },
    dryRun(action) {
      const actor = s.state.players[s.state.current];
      return applyAction(s.state, actor.id, action);
    },
    leave() {},
  };
  return s;
}

// ---------- 联机 ----------
// 引擎/房主回传的错误码翻成人话。UI 层直接复用，避免两处各写一份。
export const DENY_TEXT = {
  room_full: '房间已满（最多 4 人）',
  game_started: '该房间已经开局了',
  not_your_turn: '还没轮到你',
  must_discard: '宝石会超过 10 个，需要先弃牌',
  cannot_afford: '宝石不够，买不起这张卡',
  colors_must_differ: '拿 3 个必须是不同颜色',
  take3_count: '拿 3 个需要正好选 3 种颜色',
  need_4_to_take2: '同色拿 2 个需要银行该色 ≥ 4',
  bad_color: '这个宝石颜色不存在',
  reserve_full: '预定区已满（最多 3 张）',
  deck_empty: '该牌堆已空',
  empty_pile: '该位置没有卡',
  no_card: '找不到这张卡',
  not_reserved: '这张卡不在你的预定区',
  no_such_player: '找不到这个玩家',
  unknown_action: '无法识别的操作',
  game_over: '对局已经结束了',
};

export async function createNetSession({ roomId, asHost }) {
  const identity = getIdentity();
  const room = await joinGameRoom(roomId, identity);
  const changed = emitter();
  const noticed = emitter({ buffer: true });

  const s = {
    mode: 'net',
    isHost: !!asHost,
    roomId,
    phase: 'lobby',
    state: null,
    roster: [],                  // [{id,name,online,ready,peerId}]
    myId: identity.id,
    hostId: asHost ? identity.id : null,
    onChange: changed.on,
    onNotice: noticed.on,
    controls(playerId) { return playerId === identity.id; },
    leave() { room.leave(); },
  };

  const seatOf = (id) => s.roster.find((r) => r.id === id);
  const push = (extra) => changed.fire(extra || {});

  // ---- 房主侧 ----
  if (asHost) {
    s.roster = [{ id: identity.id, name: identity.name, online: true, ready: true, peerId: null, host: true }];

    const broadcastRoster = () => {
      room.send('roster', {
        hostId: identity.id,
        phase: s.phase,
        seats: s.roster.map(({ peerId, ...r }) => r),
      });
    };
    const broadcastState = (events) => {
      room.send('state', { game: s.state, events: events || [] });
    };

    room.on('hello', (info, peerId) => {
      if (!info || !info.id) return;
      room.remember(peerId, info);
      const existing = seatOf(info.id);
      if (existing) {
        existing.online = true;
        existing.peerId = peerId;
        existing.name = info.name || existing.name;
      } else if (s.phase === 'lobby' && s.roster.length < 4) {
        s.roster.push({ id: info.id, name: info.name || '训练家', online: true, ready: false, peerId });
      } else {
        room.send('deny', { reason: s.phase === 'lobby' ? 'room_full' : 'game_started' }, peerId);
        return;
      }
      broadcastRoster();
      if (s.state) room.send('state', { game: s.state, events: [] }, peerId);
      noticed.fire(`${info.name || '训练家'} 加入了房间`);
      push();
    });

    room.on('ready', (d, peerId) => {
      const info = room.lookup(peerId);
      const seat = info && seatOf(info.id);
      if (!seat) return;
      seat.ready = !!(d && d.ready);
      broadcastRoster();
      push();
    });

    room.on('rename', (d, peerId) => {
      const info = room.lookup(peerId);
      const seat = info && seatOf(info.id);
      if (!seat || !d || !d.name) return;
      seat.name = String(d.name).slice(0, 10);
      room.remember(peerId, { ...info, name: seat.name });
      broadcastRoster();
      push();
    });

    room.on('intent', (d, peerId) => {
      const info = room.lookup(peerId);
      if (!info || !s.state || !d || !d.action) return;
      const actor = s.state.players[s.state.current];
      if (actor.id !== info.id) {
        return room.send('deny', { reason: 'not_your_turn' }, peerId);
      }
      const res = applyAction(s.state, info.id, d.action);
      if (!res.ok) return room.send('deny', { reason: res.error }, peerId);
      s.state = res.state;
      broadcastState(res.events);
      push({ events: res.events });
    });

    room.onPeerLeave((peerId) => {
      const info = room.lookup(peerId);
      const seat = info && seatOf(info.id);
      if (!seat) return;
      if (s.phase === 'lobby') {
        s.roster = s.roster.filter((r) => r.id !== info.id);
      } else {
        seat.online = false;      // 对局中保留座位，等重连
      }
      broadcastRoster();
      noticed.fire(`${seat.name} 掉线了`);
      push();
    });

    room.onPeerJoin(() => { broadcastRoster(); });

    s.setReady = (v) => { seatOf(identity.id).ready = !!v; broadcastRoster(); push(); };
    s.rename = (name) => { seatOf(identity.id).name = name; broadcastRoster(); push(); };
    s.canStart = () => s.roster.length >= 2 && s.roster.every((r) => r.ready);
    s.start = () => {
      if (!s.canStart()) return false;
      s.state = createGame(s.roster.map((r) => ({ id: r.id, name: r.name })));
      s.phase = 'playing';
      broadcastRoster();
      broadcastState([]);
      push();
      return true;
    };
    s.submit = (action) => {
      const actor = s.state.players[s.state.current];
      if (actor.id !== identity.id) return { ok: false, error: 'not_your_turn' };
      const res = applyAction(s.state, identity.id, action);
      if (!res.ok) return res;
      s.state = res.state;
      broadcastState(res.events);
      push({ events: res.events });
      return res;
    };
    s.dryRun = (action) => applyAction(s.state, identity.id, action);
    return s;
  }

  // ---- 客户端侧 ----
  let helloTimer = null;
  const sayHello = () => {
    room.send('hello', { id: identity.id, name: identity.name, fp: identity.fp });
  };

  room.on('roster', (d) => {
    if (!d) return;
    s.hostId = d.hostId;
    s.phase = d.phase;
    s.roster = d.seats || [];
    push();
  });

  room.on('state', (d) => {
    if (!d || !d.game) return;
    s.state = d.game;
    s.phase = 'playing';
    push({ events: d.events || [] });
  });

  room.on('deny', (d) => {
    noticed.fire(DENY_TEXT[d && d.reason] || ('操作被拒绝：' + (d && d.reason)));
    push();
  });

  room.onPeerJoin(() => sayHello());
  helloTimer = setInterval(sayHello, 4000);   // 房主晚到或重连时补握手
  const stopHello = room.on('roster', () => {
    if (s.roster.some((r) => r.id === identity.id)) {
      clearInterval(helloTimer); helloTimer = null; stopHello();
    }
  });
  sayHello();

  s.setReady = (v) => room.send('ready', { ready: !!v });
  s.rename = (name) => room.send('rename', { name });
  s.canStart = () => false;
  s.submit = (action) => { room.send('intent', { action }); return { ok: true, pending: true }; };
  s.dryRun = (action) => applyAction(s.state, identity.id, action);
  const origLeave = s.leave;
  s.leave = () => { if (helloTimer) clearInterval(helloTimer); origLeave(); };
  return s;
}
