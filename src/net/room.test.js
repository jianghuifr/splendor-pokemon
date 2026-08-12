// 网络层测试：node --test src/net/room.test.js
// 用 fake-trystero 替换真实 CDN 依赖，锁死 trystero 0.25 的 API 契约。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// 把 ./trystero.js 换成读 fake 的实现，必须在 import room.js 之前完成。
registerHooks({
  load(url, ctx, next) {
    if (url.endsWith('/net/trystero.js')) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `import { joinRoom, selfId } from './fake-trystero.js';
                 export const APP_ID = 'test-app';
                 export async function loadTrystero() { return { joinRoom, selfId }; }`,
      };
    }
    return next(url, ctx);
  },
});

const { joinGameRoom } = await import('./room.js');
const { __resetFakeNet } = await import('./fake-trystero.js');

const ident = (n) => ({ id: 'u' + n, name: '玩家' + n, fp: 'fp' + n });
const tick = () => new Promise((r) => setTimeout(r, 0));

test('两端互通：广播能被对端收到', async () => {
  __resetFakeNet();
  const a = await joinGameRoom('r1', ident(1));
  const b = await joinGameRoom('r1', ident(2));
  const got = [];
  b.on('hello', (d, peerId) => got.push([d, peerId]));

  await a.send('hello', { name: '甲' });
  await tick();

  assert.equal(got.length, 1);
  assert.deepEqual(got[0][0], { name: '甲' });
  assert.ok(got[0][1], 'peerId 必须随消息一起送到（0.25 放在 meta.peerId 里）');
  a.leave(); b.leave();
});

test('定向发送只到指定 peer，数组组发也支持', async () => {
  __resetFakeNet();
  const a = await joinGameRoom('r2', ident(1));
  const b = await joinGameRoom('r2', ident(2));
  const c = await joinGameRoom('r2', ident(3));
  const hitB = [], hitC = [];
  b.on('m', (d) => hitB.push(d));
  c.on('m', (d) => hitC.push(d));

  const bId = a.peers()[0];
  await a.send('m', { only: 'b' }, bId);
  await tick();
  assert.equal(hitB.length + hitC.length, 1, '定向发送只应命中一个');

  await a.send('m', { both: 1 }, a.peers());
  await tick();
  assert.equal(hitB.length + hitC.length, 3, '数组 target 应命中两个');
  a.leave(); b.leave(); c.leave();
});

test('peerJoin / peerLeave 支持多个订阅者', async () => {
  __resetFakeNet();
  const a = await joinGameRoom('r3', ident(1));
  const joins1 = [], joins2 = [], leaves = [];
  a.onPeerJoin((id) => joins1.push(id));
  a.onPeerJoin((id) => joins2.push(id));   // 原生只允许一个，封装必须扇出
  a.onPeerLeave((id) => leaves.push(id));

  const b = await joinGameRoom('r3', ident(2));
  await tick();
  assert.equal(joins1.length, 1);
  assert.equal(joins2.length, 1, '第二个订阅者不能被覆盖掉');

  b.leave();
  await tick();
  assert.equal(leaves.length, 1);
  a.leave();
});

test('off 能摘掉处理器，remember/lookup 记住身份', async () => {
  __resetFakeNet();
  const a = await joinGameRoom('r4', ident(1));
  const b = await joinGameRoom('r4', ident(2));
  const seen = [];
  const off = b.on('x', (d) => seen.push(d));

  await a.send('x', 1);
  await tick();
  off();
  await a.send('x', 2);
  await tick();
  assert.deepEqual(seen, [1], 'off 之后不应再收到');

  const aId = b.peers()[0];
  b.remember(aId, { name: '甲' });
  assert.deepEqual(b.lookup(aId), { name: '甲' });
  assert.equal(b.peerCount(), 1);
  a.leave(); b.leave();
});

test('向已离开的 peer 发送不会抛未捕获异常', async () => {
  __resetFakeNet();
  const a = await joinGameRoom('r5', ident(1));
  const b = await joinGameRoom('r5', ident(2));
  const bId = a.peers()[0];
  b.leave();
  await tick();
  await a.send('ghost', {}, bId);   // 不应 reject
  a.leave();
});
