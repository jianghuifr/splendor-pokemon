// 引擎单元测试：node --test src/game/engine.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, applyAction, canAfford, costBreakdown } from './engine.js';
import { CARDS } from './cards.js';
import { NOBLES } from './nobles.js';

// 确定性 rng（线性同余），保证可复现。
function seeded(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}
const mkGame = (n = 2) =>
  createGame(Array.from({ length: n }, (_, i) => ({ id: 'p' + i, name: 'P' + i })), seeded(42));

test('数据完整性：90 张卡 40/30/20，10 张贵族', () => {
  assert.equal(CARDS.length, 90);
  const cnt = { 1: 0, 2: 0, 3: 0 };
  for (const c of CARDS) cnt[c.tier]++;
  assert.deepEqual(cnt, { 1: 40, 2: 30, 3: 20 });
  assert.equal(NOBLES.length, 10);
});

// 规则原文是「拿走三个不同颜色的指示物」：银行有 3 种以上可选时必须拿满 3 种，
// 只有在可选色不足 3 种时才允许少拿。
test('take3：银行够 3 色时必须正好拿 3 种，少拿要被拒', () => {
  for (const colors of [['w'], ['w', 'u']]) {
    const r = applyAction(mkGame(2), 'p0', { type: 'take3', colors });
    assert.equal(r.ok, false, `拿 ${colors.length} 色应被拒`);
    assert.equal(r.error, 'take3_count');
  }
  assert.equal(applyAction(mkGame(2), 'p0', { type: 'take3', colors: ['w', 'u', 'g'] }).ok, true);
});

test('take3：银行只剩 2 色时允许拿 2 色，但不能凑 3 色', () => {
  const g = mkGame(2);
  Object.assign(g.bank, { w: 2, u: 2, g: 0, r: 0, k: 0 });
  assert.equal(applyAction(g, 'p0', { type: 'take3', colors: ['w', 'u'] }).ok, true);
  assert.equal(applyAction(g, 'p0', { type: 'take3', colors: ['w', 'u', 'g'] }).error, 'take3_count');
});

test('非法输入返回 {ok:false} 而不是抛异常（联机时 action 来自远端）', () => {
  const bad = [
    { type: 'reserve', source: 'deck' },
    { type: 'reserve', source: 'deck', tier: 9 },
    { type: 'take3', colors: {} },
    { type: 'take3', colors: 5 },
    { type: 'take3', colors: 'wu' },
  ];
  for (const action of bad) {
    let r;
    assert.doesNotThrow(() => { r = applyAction(mkGame(2), 'p0', action); }, JSON.stringify(action));
    assert.equal(r.ok, false, JSON.stringify(action));
  }
});

test('大师球计入 10 张上限，也必须可以弃掉', () => {
  const g = mkGame(2);
  g.players[0].gold = 8;                        // 拿 3 个宝石后是 11 张，需弃 1
  g.players[0].tokens = { w: 0, u: 0, g: 0, r: 0, k: 0 };
  const r = applyAction(g, 'p0', { type: 'take3', colors: ['w', 'u', 'g'], discard: { gold: 1 } });
  assert.equal(r.ok, true, '弃大师球应被接受：' + r.error);
  assert.equal(r.state.players[0].gold, 7);
  assert.equal(r.state.bank.gold, 6);
  // 不弃就该被拒
  const g2 = mkGame(2);
  g2.players[0].gold = 8;
  g2.players[0].tokens = { w: 0, u: 0, g: 0, r: 0, k: 0 };
  assert.equal(applyAction(g2, 'p0', { type: 'take3', colors: ['w', 'u', 'g'] }).error, 'must_discard');
});

test('弃牌数量非法（负数 / 小数 / 超出持有）一律拒绝', () => {
  const mk = () => { const g = mkGame(2); g.players[0].gold = 11; return g; };
  for (const discard of [{ gold: -1 }, { gold: 1.5 }, { gold: 99 }, { gold: '2' }]) {
    const r = applyAction(mk(), 'p0', { type: 'take3', colors: ['w', 'u', 'g'], discard });
    assert.equal(r.ok, false, JSON.stringify(discard) + ' 应被拒');
    assert.equal(r.error, 'bad_discard');
  }
});

test('初始化：2 人每色 4 宝石 + 5 黄金 + 3 贵族，各级 4 张展示', () => {
  const g = mkGame(2);
  for (const c of ['w', 'u', 'g', 'r', 'k']) assert.equal(g.bank[c], 4);
  assert.equal(g.bank.gold, 5);
  assert.equal(g.nobles.length, 3);
  for (const t of [1, 2, 3]) assert.equal(g.board[t].filter(Boolean).length, 4);
});

test('人数缩放：4 人每色 7 宝石 + 5 贵族', () => {
  const g = mkGame(4);
  assert.equal(g.bank.w, 7);
  assert.equal(g.nobles.length, 5);
});

test('take3：拿三种不同色', () => {
  const g = mkGame(2);
  const r = applyAction(g, 'p0', { type: 'take3', colors: ['w', 'u', 'g'] });
  assert.ok(r.ok);
  assert.equal(r.state.players[0].tokens.w, 1);
  assert.equal(r.state.bank.w, 3);
  assert.equal(r.state.current, 1);
});

test('take3 拒绝重复色', () => {
  const g = mkGame(2);
  const r = applyAction(g, 'p0', { type: 'take3', colors: ['w', 'w', 'g'] });
  assert.equal(r.ok, false);
});

test('take2 需该色≥4', () => {
  const g = mkGame(2);
  const ok = applyAction(g, 'p0', { type: 'take2', color: 'w' });
  assert.ok(ok.ok);
  assert.equal(ok.state.players[0].tokens.w, 2);
  assert.equal(ok.state.bank.w, 2);
  // 削减到 3 后不能再 take2
  const low = JSON.parse(JSON.stringify(g));
  low.bank.r = 3;
  const bad = applyAction(low, 'p0', { type: 'take2', color: 'r' });
  assert.equal(bad.ok, false);
});

test('not_your_turn 校验', () => {
  const g = mkGame(2);
  const r = applyAction(g, 'p1', { type: 'take2', color: 'w' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'not_your_turn');
});

test('预定得黄金且占预定位', () => {
  const g = mkGame(2);
  const r = applyAction(g, 'p0', { type: 'reserve', source: 'board', tier: 1, pos: 0 });
  assert.ok(r.ok);
  assert.equal(r.state.players[0].reserved.length, 1);
  assert.equal(r.state.players[0].gold, 1);
  assert.equal(r.state.bank.gold, 4);
  assert.ok(r.state.board[1][0]); // 已补牌
});

test('购买：加成抵扣 + 黄金补差 + 加分', () => {
  let g = mkGame(2);
  const pl = g.players[0];
  // 造一张可负担的卡放到 board[1][0]
  g.board[1][0] = { id: 'X', tier: 1, bonus: 'r', points: 1, cost: { w: 2, u: 1 } };
  pl.tokens.w = 1; pl.gold = 2; pl.bonuses.u = 1; // u 成本被加成抵掉，w 差 1 用黄金
  const r = applyAction(g, 'p0', { type: 'buy', source: 'board', tier: 1, pos: 0 });
  assert.ok(r.ok, r.error);
  const p = r.state.players[0];
  assert.equal(p.cards.length, 1);
  assert.equal(p.bonuses.r, 1);
  assert.equal(p.points, 1);
  assert.equal(p.tokens.w, 0);
  assert.equal(p.gold, 1); // 花了 1 黄金
});

test('手持超 10 需弃牌', () => {
  let g = mkGame(2);
  const p = g.players[0];
  p.tokens = { w: 3, u: 3, g: 2, r: 0, k: 0 }; p.gold = 0; // 手持 8
  const noDiscard = applyAction(g, 'p0', { type: 'take3', colors: ['r', 'k', 'g'] });
  assert.equal(noDiscard.ok, false);
  assert.equal(noDiscard.error, 'must_discard');
  const withDiscard = applyAction(g, 'p0', { type: 'take3', colors: ['r', 'k', 'g'], discard: { w: 1 } });
  assert.ok(withDiscard.ok);
  const q = withDiscard.state.players[0];
  assert.equal(['w','u','g','r','k'].reduce((s,c)=>s+q.tokens[c],0) + q.gold, 10);
});

test('贵族到访：满足加成即获得 3 分', () => {
  let g = mkGame(2);
  g.nobles = [{ id: 'nb', points: 3, requires: { r: 1 } }];
  const p = g.players[0];
  g.board[1][0] = { id: 'X', tier: 1, bonus: 'r', points: 0, cost: {} };
  const r = applyAction(g, 'p0', { type: 'buy', source: 'board', tier: 1, pos: 0 });
  assert.ok(r.ok);
  assert.equal(r.state.players[0].nobles.length, 1);
  assert.equal(r.state.players[0].points, 3);
  assert.equal(r.state.nobles.length, 0);
});

test('终局：达15分后打满整轮再定胜负', () => {
  let g = mkGame(2);
  g.players[0].points = 14;
  g.board[1][0] = { id: 'X', tier: 1, bonus: 'r', points: 1, cost: {} };
  const r = applyAction(g, 'p0', { type: 'buy', source: 'board', tier: 1, pos: 0 });
  assert.ok(r.ok);
  assert.equal(r.state.endTriggered, true);
  assert.equal(r.state.winner, null); // p1 还没打
  const r2 = applyAction(r.state, 'p1', { type: 'take2', color: 'u' });
  assert.ok(r2.ok);
  assert.equal(r2.state.winner, 'p0');
});

test('canAfford 纯查询', () => {
  const card = { cost: { w: 3 }, bonus: 'r' };
  assert.equal(canAfford({ tokens: { w: 3, u: 0, g: 0, r: 0, k: 0 }, gold: 0, bonuses: { w: 0, u: 0, g: 0, r: 0, k: 0 } }, card), true);
  assert.equal(canAfford({ tokens: { w: 1, u: 0, g: 0, r: 0, k: 0 }, gold: 1, bonuses: { w: 0, u: 0, g: 0, r: 0, k: 0 } }, card), false);
});

test('costBreakdown 逐色列出折扣与缺口', () => {
  const card = { cost: { w: 3, u: 2 }, bonus: 'r' };
  const pl = { tokens: { w: 1, u: 0, g: 0, r: 0, k: 0 }, gold: 1, bonuses: { w: 1, u: 0, g: 0, r: 0, k: 0 } };
  const b = costBreakdown(pl, card);
  assert.deepEqual(b.rows.map((r) => r.color), ['w', 'u']); // 只列有成本的颜色
  assert.deepEqual(b.rows[0], { color: 'w', cost: 3, discount: 1, need: 2, have: 1, missing: 1 });
  assert.deepEqual(b.rows[1], { color: 'u', cost: 2, discount: 0, need: 2, have: 0, missing: 2 });
  assert.equal(b.goldNeed, 3);
  assert.equal(b.goldShort, 2); // 只有 1 个大师球，还差 2
  assert.equal(b.ok, false);
  assert.equal(b.ok, canAfford(pl, card)); // 与 canAfford 同源
});
