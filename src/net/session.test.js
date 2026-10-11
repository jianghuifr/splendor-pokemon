// 联机会话测试：node --test src/net/session.test.js
// 在 Node 里把 trystero 和 identity 都换成替身，跑通「建房→加入→准备→开局→出手」整条链路。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

registerHooks({
  load(url, ctx, next) {
    if (url.endsWith('/net/trystero.js')) {
      return {
        format: 'module', shortCircuit: true,
        source: `import { joinRoom, selfId } from './fake-trystero.js';
                 export const APP_ID = 'test-app';
                 export async function loadTrystero() { return { joinRoom, selfId }; }`,
      };
    }
    if (url.endsWith('/net/identity.js')) {
      return {
        format: 'module', shortCircuit: true,
        source: `export function getIdentity() { return globalThis.__who; }
                 export function setName() {}
                 export function shortId(id) { return String(id).slice(0, 4); }`,
      };
    }
    return next(url, ctx);
  },
});

const { createNetSession } = await import('./session.js');
const { __resetFakeNet } = await import('./fake-trystero.js');

const settle = () => new Promise((r) => setTimeout(r, 5));

// 会话内部有重连心跳（setInterval），断言失败时若不 leave，进程会永不退出、看着像卡死。
// 所以统一用 t.after 注册清理：每个用例开场调 arena(t)，之后 join 出来的会话都会被收走。
function arena(t) {
  __resetFakeNet();
  const live = [];
  t.after(() => { for (const s of live) { try { s.leave(); } catch {} } });
  // identity 是模块级读取的，创建前先换掉全局身份。
  return async function join(n, opts) {
    globalThis.__who = { id: 'u' + n, name: '玩家' + n, fp: 'fp' + n };
    const s = await createNetSession(opts);
    live.push(s);
    await settle();
    return s;
  };
}

test('建房 → 加入 → 准备 → 开局 → 出手，全链路同步', async (t) => {
  const asPlayer = arena(t);
  const host = await asPlayer(1, { roomId: 'PKMN-TEST', asHost: true });
  assert.equal(host.phase, 'lobby');
  assert.equal(host.roster.length, 1);

  const guest = await asPlayer(2, { roomId: 'PKMN-TEST', asHost: false });
  await settle();

  // 房主看到两个座位，客人也收到了名单
  assert.equal(host.roster.length, 2, '房主应看到客人入座');
  assert.equal(guest.roster.length, 2, '客人应收到 roster');
  assert.equal(guest.hostId, 'u1');

  // 客人准备 → 房主侧生效
  guest.setReady(true);
  await settle();
  assert.equal(host.roster.find((r) => r.id === 'u2').ready, true);
  assert.equal(host.canStart(), true, '两人都就绪应可开局');

  // 房主开局 → 客人拿到状态
  assert.equal(host.start(), true);
  await settle();
  assert.equal(host.phase, 'playing');
  assert.equal(guest.phase, 'playing');
  assert.ok(guest.state, '客人必须收到初始牌局');
  assert.equal(guest.state.players.length, 2);
  assert.deepEqual(
    guest.state.players.map((p) => p.id),
    host.state.players.map((p) => p.id),
    '双方座位顺序必须一致',
  );

  // 轮到谁由状态决定；让当前行动方拿宝石，另一方应收到同步
  const firstId = host.state.players[host.state.current].id;
  const act = { type: 'take3', colors: ['w', 'u', 'g'] };
  if (firstId === 'u1') {
    const res = host.submit(act);
    assert.ok(res.ok, '房主出手应成功：' + res.error);
  } else {
    guest.submit(act);
  }
  await settle();
  assert.equal(guest.state.current, host.state.current, '回合指针必须同步');
  assert.deepEqual(guest.state.bank, host.state.bank, '银行必须同步');
});

test('非回合方出手被拒，并收到人话提示', async (t) => {
  const asPlayer = arena(t);
  const host = await asPlayer(1, { roomId: 'PKMN-DENY', asHost: true });
  const guest = await asPlayer(2, { roomId: 'PKMN-DENY', asHost: false });
  await settle();
  guest.setReady(true);
  await settle();
  host.start();
  await settle();

  const notices = [];
  guest.onNotice((m) => notices.push(m));

  // 找到「不是当前行动方」的那一边去出手
  const currentId = host.state.players[host.state.current].id;
  if (currentId === 'u1') {
    guest.submit({ type: 'take3', colors: ['w', 'u', 'g'] });
    await settle();
    assert.deepEqual(notices, ['还没轮到你']);
  } else {
    const res = host.submit({ type: 'take3', colors: ['w', 'u', 'g'] });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'not_your_turn');
  }
});

test('第 5 人被拒：房间已满', async (t) => {
  const asPlayer = arena(t);
  const host = await asPlayer(1, { roomId: 'PKMN-FULL', asHost: true });
  for (const n of [2, 3, 4]) await asPlayer(n, { roomId: 'PKMN-FULL', asHost: false });
  await settle();
  assert.equal(host.roster.length, 4);

  const fifth = await asPlayer(5, { roomId: 'PKMN-FULL', asHost: false });
  const notices = [];
  fifth.onNotice((m) => notices.push(m));
  await settle();
  assert.equal(host.roster.length, 4, '第 5 人不应入座');
  assert.ok(notices.includes('房间已满（最多 4 人）'), '应收到满员提示，实际：' + notices);
});

test('只认房主发来的状态：房间内其他人伪造 state 会被忽略', async (t) => {
  const asPlayer = arena(t);
  const host = await asPlayer(1, { roomId: 'PKMN-FAKE', asHost: true });
  const guest = await asPlayer(2, { roomId: 'PKMN-FAKE', asHost: false });
  guest.setReady(true);
  await settle();
  host.start();
  await settle();
  assert.ok(guest.state, '客人应已拿到开局状态');
  const realCurrent = guest.state.current;

  // 第三方只连上房间、不入座，直接广播一份"我赢了"的状态。
  globalThis.__who = { id: 'u9', name: '路人', fp: 'fp9' };
  const { joinGameRoom } = await import('./room.js');
  const outsider = await joinGameRoom('PKMN-FAKE', { id: 'u9', name: '路人' });
  t.after(() => outsider.leave());

  const forged = JSON.parse(JSON.stringify(guest.state));
  forged.winner = 'u9';
  forged.endTriggered = true;
  forged.current = 99;
  outsider.send('state', { game: forged, events: [] });
  await settle();

  assert.notEqual(guest.state.winner, 'u9', '伪造的 winner 必须被忽略');
  assert.equal(guest.state.current, realCurrent, '客人状态不应被第三方改写');

  // 但房主自己发的状态仍然照常生效。
  const firstId = host.state.players[host.state.current].id;
  if (firstId === 'u1') host.submit({ type: 'take3', colors: ['w', 'u', 'g'] });
  else guest.submit({ type: 'take3', colors: ['w', 'u', 'g'] });
  await settle();
  assert.equal(guest.state.current, host.state.current, '房主的状态仍应正常同步');
});

test('房主离开后客人会被告知本局无法继续（以前是无声死局）', async (t) => {
  const asPlayer = arena(t);
  const host = await asPlayer(1, { roomId: 'PKMN-GONE', asHost: true });
  const guest = await asPlayer(2, { roomId: 'PKMN-GONE', asHost: false });
  guest.setReady(true);
  await settle();
  host.start();
  await settle();
  assert.ok(guest.state, '客人应已拿到牌局');
  assert.equal(guest.hostGone, false);

  const notices = [];
  guest.onNotice((m) => notices.push(m));
  host.leave();
  await settle();

  assert.equal(guest.hostGone, true, '客人必须知道房主走了');
  assert.ok(notices.some((m) => /房主已离开/.test(m)), '应给出提示，实际：' + JSON.stringify(notices));
});

test('被拒入座后停止握手心跳（否则会永远空转）', async (t) => {
  const asPlayer = arena(t);
  for (let i = 1; i <= 4; i++) await asPlayer(i, { roomId: 'PKMN-FULL', asHost: i === 1 });
  const rejected = await asPlayer(5, { roomId: 'PKMN-FULL', asHost: false });
  const notices = [];
  rejected.onNotice((m) => notices.push(m));
  await settle();
  // 让心跳有机会再跑几轮
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(notices.some((m) => /房间已满/.test(m)), '应收到满员提示，实际：' + JSON.stringify(notices));
});

test('大厅能互相发现在线的人和开着的房', async (t) => {
  __resetFakeNet();
  const { joinLobby } = await import('./lobby.js');
  globalThis.__who = { id: 'u1', name: '甲', fp: 'f1' };
  const a = await joinLobby();
  globalThis.__who = { id: 'u2', name: '乙', fp: 'f2' };
  const b = await joinLobby();
  t.after(() => { a.leave(); b.leave(); });
  await settle();

  a.announce({ status: 'hosting', roomId: 'PKMN-AAAA', seats: 1, max: 4 });
  await settle();

  const snap = b.snapshot();
  assert.equal(snap.people.length, 2, '双方都该在线列表里');
  assert.equal(snap.rooms.length, 1, '乙应发现甲开的房');
  assert.equal(snap.rooms[0].roomId, 'PKMN-AAAA');
  assert.equal(snap.rooms[0].host, '甲');
});
