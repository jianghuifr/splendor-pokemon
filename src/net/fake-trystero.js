// 测试替身：严格照抄 trystero 0.25.3 的真实契约，用来锁死网络层的 API 用法。
// 任何回退到 0.24 老写法（元组解构 makeAction、把 peerId 当第二参、onPeerJoin 当函数调用）
// 都会在这里直接抛错，而不是等到浏览器里才炸。
const buses = new Map();   // roomId -> Set<endpoint>
let seq = 0;

export const selfId = 'fake-self';

export function joinRoom(config, roomId, callbacks) {
  if (!config) throw new Error('requires a config map as the first argument');
  if (callbacks && typeof callbacks !== 'object') throw new Error('third argument must be a callbacks object');
  if (!config.appId) throw new Error('config map is missing appId field');
  if (!roomId) throw new Error('roomId argument required');

  const key = config.appId + '|' + roomId;
  if (!buses.has(key)) buses.set(key, new Set());
  const bus = buses.get(key);

  const me = {
    peerId: 'peer' + (++seq),
    actions: new Map(),        // ns -> action handle
    peerJoin: null,
    peerLeave: null,
    left: false,
  };

  const others = () => [...bus].filter((e) => e !== me && !e.left);

  const room = {
    // 本端点自身的 peerId。真实 trystero 一个页面只有一个 selfId，但这里要在一个进程里
    // 模拟多个端点，所以每个 room 报自己的 id，让上层能区分"我"和"对端"。
    selfId: me.peerId,

    makeAction(ns) {
      if (me.actions.has(ns)) return me.actions.get(ns);
      let onMessage = null;
      const pending = [];
      const handle = {
        // 真实签名：send(payload, {target, metadata, onProgress, signal})
        async send(payload, opts) {
          if (opts !== undefined && (typeof opts !== 'object' || opts === null || Array.isArray(opts))) {
            throw new Error('send 的第二参必须是选项对象（0.25 契约），收到 ' + typeof opts);
          }
          const raw = opts?.target;
          const targets = raw === undefined ? null
            : (Array.isArray(raw) ? raw : [raw]);
          for (const ep of others()) {
            if (targets && !targets.includes(ep.peerId)) continue;
            const act = ep.actions.get(ns);
            if (!act) continue;
            act._deliver(JSON.parse(JSON.stringify(payload)), me.peerId);
          }
        },
        get onMessage() { return onMessage; },
        set onMessage(fn) {
          onMessage = fn;
          if (fn) pending.splice(0).forEach(([p, id]) => fn(p, { peerId: id }));
        },
        _deliver(payload, fromId) {
          if (!onMessage) { pending.push([payload, fromId]); return; }
          onMessage(payload, { peerId: fromId });
        },
      };
      me.actions.set(ns, handle);
      return handle;
    },

    getPeers() {
      const out = {};
      for (const ep of others()) out[ep.peerId] = {};
      return out;
    },

    // 访问器属性，不是方法：room.onPeerJoin(cb) 会抛 TypeError。
    get onPeerJoin() { return me.peerJoin; },
    set onPeerJoin(fn) {
      me.peerJoin = fn;
      if (fn) others().forEach((ep) => fn(ep.peerId));   // 真实实现会回放已在场的 peer
    },
    get onPeerLeave() { return me.peerLeave; },
    set onPeerLeave(fn) { me.peerLeave = fn; },

    leave() {
      me.left = true;
      bus.delete(me);
      for (const ep of others()) ep.peerLeave?.(me.peerId);
    },
  };

  bus.add(me);
  // 通知已在场的人：有新 peer 进来了。
  for (const ep of others()) ep.peerJoin?.(me.peerId);
  return room;
}

export function __resetFakeNet() { buses.clear(); seq = 0; }
