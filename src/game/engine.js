// 纯函数游戏引擎：完整 Splendor 规则。不依赖 DOM / 网络。
import { CARDS, COLORS } from './cards.js';
import { NOBLES } from './nobles.js';

const WIN_POINTS = 15;
const TOKEN_HAND_LIMIT = 10;

// 人数 → 每色宝石数量、贵族数量。黄金固定 5。
function bankSetup(n) {
  const per = n <= 2 ? 4 : n === 3 ? 5 : 7;
  return { per, gold: 5, nobles: n + 1 };
}

function clone(o) { return JSON.parse(JSON.stringify(o)); }
function zero() { return { w: 0, u: 0, g: 0, r: 0, k: 0 }; }

function shuffle(arr, rng = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function createGame(playerInfos, rng = Math.random) {
  const n = playerInfos.length;
  if (n < 2 || n > 4) throw new Error('players must be 2-4');
  const setup = bankSetup(n);

  const byTier = { 1: [], 2: [], 3: [] };
  // 克隆一份再上桌：CARDS 是模块级常量，直接放引用的话，
  // 任何一处改了牌面数据都会永久污染全局，影响之后所有对局。
  for (const c of CARDS) byTier[c.tier].push({ ...c, cost: { ...c.cost } });
  const decks = {};
  const board = {};
  for (const t of [1, 2, 3]) {
    const d = shuffle(byTier[t], rng);
    board[t] = [d.pop(), d.pop(), d.pop(), d.pop()];
    decks[t] = d;
  }

  // 贵族同理，克隆出独立的 requires。
  const nobles = shuffle(NOBLES, rng).slice(0, setup.nobles)
    .map((nb) => ({ ...nb, requires: { ...nb.requires } }));

  const players = playerInfos.map((p) => ({
    id: p.id, name: p.name,
    tokens: zero(), gold: 0,
    bonuses: zero(),
    reserved: [], cards: [], nobles: [],
    points: 0,
  }));

  const bank = zero();
  for (const c of COLORS) bank[c] = setup.per;
  bank.gold = setup.gold;

  return {
    players, bank, decks, board, nobles,
    perColor: setup.per,
    current: 0, startPlayer: 0,
    endTriggered: false, winner: null,
  };
}

function handCount(pl) {
  return COLORS.reduce((s, c) => s + pl.tokens[c], 0) + pl.gold;
}

// 逐色拆解购买成本，供 UI 悬浮提示与支付共用同一套算法。
// rows 只含实际有成本的颜色：need 为折扣后应付，have 为自有宝石可付部分，missing 需大师球补。
export function costBreakdown(pl, card) {
  const rows = [];
  let goldNeed = 0;
  for (const c of COLORS) {
    const cost = card.cost[c] || 0;
    if (!cost) continue;
    const need = Math.max(0, cost - pl.bonuses[c]);
    const have = Math.min(need, pl.tokens[c]);
    const missing = need - have;
    goldNeed += missing;
    rows.push({ color: c, cost, discount: cost - need, need, have, missing });
  }
  const goldShort = Math.max(0, goldNeed - pl.gold);
  return { rows, goldNeed, goldHave: pl.gold, goldShort, ok: goldShort === 0 };
}

// 计算购买某卡的支付方案；返回 {ok, pay:{色→token数}, gold} 或 {ok:false}
function payment(pl, card) {
  const b = costBreakdown(pl, card);
  if (!b.ok) return { ok: false };
  const pay = zero();
  for (const r of b.rows) pay[r.color] = r.have;
  return { ok: true, pay, gold: b.goldNeed };
}

export function canAfford(pl, card) {
  return payment(pl, card).ok;
}

function applyDiscard(pl, bank, discard) {
  if (!discard) return null;
  // 先把所有项校验完再落账：中途失败不该留下改了一半的状态。
  const drops = {};
  for (const c of COLORS) {
    const d = discard[c] || 0;
    // 非整数（例如字符串或 NaN）会让 tokens 变成 NaN，之后所有校验都失效，必须挡住。
    if (!Number.isInteger(d) || d < 0 || d > pl.tokens[c]) return 'bad_discard';
    drops[c] = d;
  }
  // 大师球计入 10 张上限，所以必须同样可弃，否则手上黄金多时会"超限却无牌可弃"。
  const g = discard.gold || 0;
  if (!Number.isInteger(g) || g < 0 || g > pl.gold) return 'bad_discard';

  for (const c of COLORS) { pl.tokens[c] -= drops[c]; bank[c] += drops[c]; }
  pl.gold -= g; bank.gold += g;
  return null;
}

function refill(state, tier, pos) {
  const d = state.decks[tier];
  state.board[tier][pos] = d.length ? d.pop() : null;
}

function checkNobles(state, pl, events) {
  for (let i = 0; i < state.nobles.length; i++) {
    const nb = state.nobles[i];
    const ok = COLORS.every((c) => pl.bonuses[c] >= (nb.requires[c] || 0));
    if (ok) {
      pl.nobles.push(nb);
      pl.points += nb.points;
      state.nobles.splice(i, 1);
      events.push({ kind: 'noble', playerId: pl.id, nobleId: nb.id });
      return; // 每回合至多一位贵族到访
    }
  }
}

function advance(state) {
  // 触发终局后，打到回合回到起始玩家即结束。
  const next = (state.current + 1) % state.players.length;
  if (state.endTriggered && next === state.startPlayer) {
    let best = null;
    for (const p of state.players) {
      if (!best || p.points > best.points ||
        (p.points === best.points && p.cards.length < best.cards.length)) best = p;
    }
    state.winner = best.id;
  }
  state.current = next;
}

// 主入口：校验并应用动作。返回 {ok:true,state,events} 或 {ok:false,error}
export function applyAction(prev, playerId, action) {
  const state = clone(prev);
  const idx = state.players.findIndex((p) => p.id === playerId);
  if (idx === -1) return { ok: false, error: 'no_such_player' };
  if (state.winner) return { ok: false, error: 'game_over' };
  if (idx !== state.current) return { ok: false, error: 'not_your_turn' };
  const pl = state.players[idx];
  const bank = state.bank;
  const events = [];

  if (action.type === 'take3') {
    const raw = action.colors;
    // 联机时 action 由远端 peer 传来，先确认形状再解构 —— 否则会抛异常打断房主的消息处理。
    if (!Array.isArray(raw)) return { ok: false, error: 'take3_count' };
    const cols = [...new Set(raw)];
    if (cols.length !== raw.length) return { ok: false, error: 'colors_must_differ' };
    for (const c of cols) if (!COLORS.includes(c)) return { ok: false, error: 'bad_color' };
    // 规则是「3 种不同色各 1」；只有银行里可选的颜色不足 3 种时，才允许按实际数量少拿。
    const avail = COLORS.filter((c) => bank[c] > 0).length;
    if (cols.length !== Math.min(3, avail)) return { ok: false, error: 'take3_count' };
    for (const c of cols) if (bank[c] < 1) return { ok: false, error: 'empty_pile' };
    for (const c of cols) { bank[c]--; pl.tokens[c]++; }
  } else if (action.type === 'take2') {
    const c = action.color;
    if (!COLORS.includes(c)) return { ok: false, error: 'bad_color' };
    if (bank[c] < 4) return { ok: false, error: 'need_4_to_take2' };
    bank[c] -= 2; pl.tokens[c] += 2;
  } else if (action.type === 'reserve') {
    if (pl.reserved.length >= 3) return { ok: false, error: 'reserve_full' };
    let card;
    if (action.source === 'deck') {
      // tier 可能来自远端，越界会让 decks[tier].length 直接抛异常。
      const d = state.decks[action.tier];
      if (!d) return { ok: false, error: 'bad_tier' };
      if (!d.length) return { ok: false, error: 'deck_empty' };
      card = d.pop();
    } else {
      card = state.board[action.tier]?.[action.pos];
      if (!card) return { ok: false, error: 'no_card' };
      refill(state, action.tier, action.pos);
    }
    pl.reserved.push(card);
    if (bank.gold > 0) { bank.gold--; pl.gold++; }
  } else if (action.type === 'buy') {
    let card, loc;
    if (action.source === 'reserved') {
      const i = pl.reserved.findIndex((c) => c.id === action.cardId);
      if (i === -1) return { ok: false, error: 'not_reserved' };
      card = pl.reserved[i]; loc = { list: pl.reserved, i };
    } else {
      card = state.board[action.tier]?.[action.pos];
      if (!card) return { ok: false, error: 'no_card' };
      loc = { board: true };
    }
    const pmt = payment(pl, card);
    if (!pmt.ok) return { ok: false, error: 'cannot_afford' };
    for (const c of COLORS) { pl.tokens[c] -= pmt.pay[c]; bank[c] += pmt.pay[c]; }
    pl.gold -= pmt.gold; bank.gold += pmt.gold;
    pl.cards.push(card);
    pl.bonuses[card.bonus]++;
    pl.points += card.points;
    if (loc.board) refill(state, action.tier, action.pos);
    else loc.list.splice(loc.i, 1);
    events.push({ kind: 'buy', playerId: pl.id, cardId: card.id });
  } else {
    return { ok: false, error: 'unknown_action' };
  }

  // 手持超过 10 需弃牌（含黄金）
  if (handCount(pl) > TOKEN_HAND_LIMIT) {
    const err = applyDiscard(pl, bank, action.discard);
    if (err) return { ok: false, error: err };
    if (handCount(pl) > TOKEN_HAND_LIMIT) return { ok: false, error: 'must_discard' };
  }

  checkNobles(state, pl, events);
  if (pl.points >= WIN_POINTS) state.endTriggered = true;
  advance(state);
  return { ok: true, state, events };
}

