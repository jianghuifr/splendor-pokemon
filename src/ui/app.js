// 控制器。热座与联机共用同一套渲染，差异全部收敛在 session 层（src/net/session.js）：
// session.state 是权威状态，session.controls(id) 决定我能否操作某座位。
import { canAfford, costBreakdown } from '../game/engine.js';
import { COLORS } from '../game/cards.js';
import { COLOR_META, GOLD_META, spriteForCard, staticForCard, cryForCard, nobleArt, nameForCard } from '../game/pokemon-map.js';
import { playCry, playBGM, toggleMute } from './audio.js';
import { createHotSeatSession, createNetSession, DENY_TEXT } from '../net/session.js';
import { getIdentity, setName, shortId } from '../net/identity.js';
import { joinLobby } from '../net/lobby.js';
import { makeRoomCode, normalizeRoomCode } from '../net/room.js';

const $ = (s, r = document) => r.querySelector(s);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };

// ---------- 可访问性小工具 ----------
// 界面里大量可点元素是 div（像素风布局靠它撑着），整体换 <button> 风险大。
// 这里补上键盘与读屏需要的最小语义：可聚焦、Enter/Space 触发、有名字。
function makeButton(node, label, activate) {
  node.setAttribute('role', 'button');
  node.tabIndex = 0;
  if (label) node.setAttribute('aria-label', label);
  node.addEventListener('click', activate);
  node.addEventListener('keydown', (e) => {
    // 空格默认会滚动页面，必须拦掉
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); activate(e); }
  });
  return node;
}

let dlgSeq = 0;
// 尊重"减少动态效果"：开启时用静态 PNG。牌桌上最多同时有 12 个循环 GIF 在动，
// 对前庭/注意力敏感的用户是持续干扰，而项目里早就备好了静态图。
const reduceMotion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
const spriteFor = (card) => (reduceMotion && reduceMotion.matches ? staticForCard(card) : spriteForCard(card));// 弹层统一走这里：补 dialog 语义、焦点移进去、Esc 关闭、关闭后焦点还回去。
function openDialog(dlg, overlay) {
  dlg.setAttribute('role', 'dialog');
  dlg.setAttribute('aria-modal', 'true');
  dlg.tabIndex = -1;
  const title = dlg.querySelector('h2');
  if (title) { title.id = title.id || ('dlg-title-' + (++dlgSeq)); dlg.setAttribute('aria-labelledby', title.id); }

  const prevFocus = document.activeElement;
  // 遮罩后面的内容退出可访问树，Tab 就不会跑到弹层外面去。
  const screens = [...document.querySelectorAll('.screen')];
  for (const s of screens) s.inert = true;

  overlay.appendChild(dlg);
  $('#modal-root').appendChild(overlay);
  const first = dlg.querySelector('[tabindex="0"], button, input');
  (first || dlg).focus();

  const close = () => {
    document.removeEventListener('keydown', onKey);
    for (const s of screens) s.inert = false;
    overlay.remove();
    if (prevFocus && prevFocus.focus) { try { prevFocus.focus(); } catch {} }
  };
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
  document.addEventListener('keydown', onKey);
  return close;
}

let session = null;
let lobby = null;
let ui = { picked: [], card: null }; // picked: 颜色数组；与 card 互斥

// 便捷读取：所有渲染都从 session.state 取，避免出现第二份真相。
const G = () => session.state;
function actor() { return G().players[G().current]; }
// 房主掉线后本局无法继续，任何座位都不该再放出可操作的元素。
function canAct() { return !G().winner && !session.hostGone && session.controls(actor().id); }

// ---------- 开始界面 ----------
function initSetup() {
  const count = $('#player-count');
  const names = $('#name-fields');
  const defaults = ['小智', '小霞', '小刚', '小茂'];
  const render = () => {
    const n = +count.value;
    names.innerHTML = '';
    for (let i = 0; i < n; i++) {
      const inp = el('input');
      inp.type = 'text'; inp.value = defaults[i]; inp.maxLength = 8;
      inp.dataset.i = i;
      // 这些输入框是动态生成的，没有 <label> 可关联 —— 读屏只会念"编辑框"。
      inp.setAttribute('aria-label', `训练家 ${i + 1} 的名字`);
      names.appendChild(inp);
    }
  };
  count.addEventListener('change', render);
  render();
  $('#start-btn').addEventListener('click', () => {
    const infos = [...names.querySelectorAll('input')].map((inp, i) => ({
      id: 'p' + i, name: (inp.value.trim() || defaults[i]),
    }));
    startSession(createHotSeatSession(infos));
  });

  // 模式切换：用 aria-pressed 把状态也暴露给读屏，而不是只靠 .active 类。
  const tabs = [...$('#mode-tabs').querySelectorAll('.tab')];
  const setTab = (t) => {
    tabs.forEach((x) => {
      const on = x === t;
      x.classList.toggle('active', on);
      x.setAttribute('aria-pressed', String(on));
    });
    const net = t.dataset.mode === 'net';
    $('#pane-hot').classList.toggle('hidden', net);
    $('#pane-net').classList.toggle('hidden', !net);
  };
  tabs.forEach((t) => t.addEventListener('click', () => setTab(t)));
  setTab(tabs[0]);

  $('#net-name').value = getIdentity().name;
  $('#enter-lobby-btn').addEventListener('click', () => {
    setName($('#net-name').value);
    enterLobby();
  });
}

function show(id) {
  const prev = [...document.querySelectorAll('.screen')].find((s) => !s.classList.contains('hidden'));
  for (const s of document.querySelectorAll('.screen')) s.classList.add('hidden');
  const next = $('#' + id);
  next.classList.remove('hidden');
  // 切屏后焦点会留在刚被隐藏的按钮上、回落到 body。移进新屏并播报，
  // 否则读屏用户不知道"现在到哪一屏了"。
  if (prev !== next) {
    next.tabIndex = -1;
    try { next.focus({ preventScroll: true }); } catch {}
    announce(next.dataset.title || {
      setup: '开始界面', lobby: '联机大厅', room: '房间等待区', game: '牌桌',
    }[id] || id);
  }
}

// 会话就绪后统一进入牌桌：播 BGM，首渲染。
// wire=false 表示订阅已由调用方（联机房间流程）建立，避免重复注册导致叫声/提示播两遍。
function startSession(s, { wire = true } = {}) {
  session = s;
  ui = { picked: [], card: null };
  if (wire) {
    s.onChange(({ events }) => {
      if (events) for (const ev of events) if (ev.kind === 'buy') playCryById(ev.cardId);
      if (s.phase === 'playing' && s.state) {
        show('game');
        renderAll();
      }
    });
    if (s.onNotice) s.onNotice(toast);
  }
  if (s.mode === 'net') {
    const badge = $('#net-badge');
    badge.classList.remove('hidden');
    badge.textContent = `${s.roomId} · ${getIdentity().name}`;
  }
  show('game');
  playBGM('battle');
  renderAll();
}

// 从当前状态里按 id 找卡，供叫声回放（买走的卡已不在展示区，需遍历玩家已购）。
function playCryById(cardId) {
  for (const p of G().players) {
    const c = p.cards.find((x) => x.id === cardId);
    if (c) return playCry(cryForCard(c));
  }
}

// ---------- 顶部工具 ----------
function initTopbar() {
  $('#mute-btn').addEventListener('click', () => {
    const m = toggleMute();
    $('#mute-btn').textContent = m ? '静' : '音';
  });
  $('#rules-btn').addEventListener('click', showRules);
}

// ---------- 主渲染 ----------
let winShown = false;
function renderAll() {
  renderBank();
  renderNobles();
  renderBoard();
  renderPlayers();
  renderActionBar();
  if (G().winner && !winShown) { winShown = true; playBGM('victory'); showWin(); }
}
// ---------- 悬浮成本提示 ----------
// 单例浮层，跟随鼠标；内容由 costBreakdown 生成，与购买判定同源。
let tipEl = null;
function tipBox() {
  if (!tipEl) { tipEl = el('div', 'cost-tip'); tipEl.hidden = true; document.body.appendChild(tipEl); }
  return tipEl;
}

function tipHTML(pl, card, cardName) {
  const b = costBreakdown(pl, card);
  const head = `<b>${cardName}</b>${card.points ? ` <span class="t-pts">★${card.points}</span>` : ''}`
    + ` <span class="t-bonus" data-color="${card.bonus}"></span>`;
  const rows = b.rows.map((r) => {
    const orig = r.discount ? ` <s>${r.cost}</s>` : '';
    const state = r.missing ? `<span class="t-bad">缺 ${r.missing}</span>` : '<span class="t-ok">✔</span>';
    return `<div class="t-row"><span class="t-dot" data-color="${r.color}" title="${COLOR_META[r.color].name}"></span>`
      + `<span class="t-name">${COLOR_META[r.color].name}</span>`
      + `<span class="t-need">需 ${r.need}${orig}</span>`
      + `<span class="t-have">持 ${r.have}</span>${state}</div>`;
  }).join('');
  let foot;
  if (b.ok) {
    foot = b.goldNeed
      ? `<span class="t-ok">可购买</span>：用 ${b.goldNeed} 个${GOLD_META.name}补齐`
      : `<span class="t-ok">可购买</span>`;
  } else {
    const lack = b.rows.filter((r) => r.missing)
      .map((r) => `<span class="t-lack"><span class="sw" data-color="${r.color}"></span>${r.missing}</span>`).join('');
    foot = `<span class="t-bad">还差 ${b.goldShort} 个：</span>${lack}`
      + `<span class="t-gold">（${GOLD_META.name} ${b.goldHave}/${b.goldNeed}）</span>`;
  }
  return `<div class="t-head">${head}</div><div class="t-rows">${rows}</div><div class="t-foot">${foot}</div>`;
}

// pl 用取值函数包一层：卡片节点会跨渲染复用，玩家状态必须现取。
function attachCostTip(node, getPl, card, cardName) {
  const show = (ev) => {
    const t = tipBox();
    t.innerHTML = tipHTML(getPl(), card, cardName);
    t.hidden = false;
    move(ev);
  };
  const move = (ev) => {
    const t = tipBox();
    const pad = 14;
    const w = t.offsetWidth, h = t.offsetHeight;
    // 键盘聚焦时没有鼠标坐标，退回元素自身位置，否则会算出 NaN。
    const pt = (typeof ev?.clientX === 'number')
      ? { x: ev.clientX, y: ev.clientY }
      : (() => { const r = node.getBoundingClientRect(); return { x: r.left, y: r.bottom }; })();
    let x = pt.x + pad, y = pt.y + pad;
    if (x + w > innerWidth - 4) x = pt.x - w - pad;
    if (y + h > innerHeight - 4) y = pt.y - h - pad;
    t.style.left = Math.max(4, x) + 'px';
    t.style.top = Math.max(4, y) + 'px';
  };
  const hide = () => { tipBox().hidden = true; };
  node.addEventListener('mouseenter', show);
  node.addEventListener('mousemove', move);
  node.addEventListener('mouseleave', hide);
  // 键盘用户聚焦到卡上时也要能看到"需/持/缺"明细 —— 这是唯一的成本信息来源。
  node.addEventListener('focus', show);
  node.addEventListener('blur', hide);
  node.addEventListener('click', hide);
}

function gemNode(color, count, selectable, picked) {
  // 大师球是万能道具，不是"第 6 种颜色"，所以既换图形（宝可球）又换底纹，
  // 免得和 5 种普通球的白底方块看成一类。注意底纹不能用平涂金色：
  // .gem.picked 已经用金色表示"已选中"，撞了会分不清。
  const isMaster = color === 'gold';
  const g = el('div', 'gem' + (isMaster ? ' master' : '') + (selectable ? ' selectable' : '') + (picked ? ' picked' : ''));
  g.dataset.color = color;
  g.appendChild(el('span', isMaster ? 'ball' : 'dot'));
  // 颜色是宝石类型的唯一视觉编码：色觉障碍下草/火、水/超能几乎分不开，
  // 所以筹码上直接写出属性名（大师球已经靠形状区分，不用再占宽度）。
  if (!isMaster) g.appendChild(el('span', 'gname', COLOR_META[color].name));
  // 只写数量：颜色已由 .dot 按 data-color 上色，再带 emoji 是重复表达。
  g.appendChild(el('span', null, String(count)));
  // 悬停给出属性名：颜色是宝石类型的唯一视觉编码，补一个文字说明。
  g.title = isMaster
    ? `${GOLD_META.name}（万能）：预定宝可梦时获得，可替代任意颜色`
    : COLOR_META[color].name;
  return g;
}

function renderBank() {
  const bank = $('#bank');
  bank.innerHTML = '';
  // 宝石随时可点：首次点击自动进入拿取模式，无需先按按钮。
  for (const c of COLORS) {
    const pickedCount = ui.picked.filter((x) => x === c).length;
    const sel = canAct() && G().bank[c] > 0;
    const node = gemNode(c, G().bank[c], sel, pickedCount > 0);
    if (pickedCount > 1) node.dataset.picked = pickedCount;
    if (sel) makeButton(node, `${COLOR_META[c].name}宝石，银行剩 ${G().bank[c]} 个`, () => pickGem(c));
    bank.appendChild(node);
  }
  bank.appendChild(gemNode('gold', G().bank.gold, false, false));
}

function renderNobles() {
  const row = $('#nobles');
  row.innerHTML = '';
  G().nobles.forEach((nb, i) => {
    const art = nobleArt(nb, i);
    const n = el('div', 'noble');
    // 贵族的要求也只用颜色表达；补一句文字说明，读屏和色觉障碍都能用。
    n.title = `需要 ${COLORS.filter((c) => nb.requires[c]).map((c) => `${nb.requires[c]}${COLOR_META[c].name}`).join(' ')}`;
    n.appendChild(Object.assign(el('img'), { src: art.src, alt: art.name, title: art.name }));
    n.appendChild(el('div', 'pts', '★ 3'));
    const req = el('div', 'req');
    for (const c of COLORS) if (nb.requires[c]) {
      const it = el('i', null, String(nb.requires[c]));
      it.dataset.color = c;
      req.appendChild(it);
    }
    n.appendChild(req);
    row.appendChild(n);
  });
}

function cardNode(card, tier, pos) {
  const c = el('div', 'card');
  const affordable = canAfford(actor(), card) && canAct();
  const clickable = canAct();
  if (affordable) c.classList.add('afford');
  if (clickable) c.classList.add('selectable');
  if (ui.card && ui.card.card.id === card.id) c.classList.add('selected');

  const head = el('div', 'head');
  head.appendChild(el('span', 'pts', card.points ? '★' + card.points : ''));
  const b = el('span', 'bonus'); b.dataset.color = card.bonus;
  head.appendChild(b);
  c.appendChild(head);

  const sp = el('div', 'sprite');
  // 卡名就在下面的 .cname 里，且整张卡是带 aria-label 的按钮 —— 图不该再念一遍内部色码。
  const img = el('img'); img.src = spriteFor(card); img.alt = ''; img.loading = 'lazy';
  // 万一某个宝可梦只有动画图、没有静态图，退回动画图也比破图强。
  img.onerror = () => { img.onerror = null; img.src = spriteForCard(card); };
  sp.appendChild(img); c.appendChild(sp);

  c.appendChild(el('div', 'cname', nameForCard(card)));

  const cost = el('div', 'cost');
  for (const col of COLORS) if (card.cost[col]) {
    const it = el('i', null, String(card.cost[col])); it.dataset.color = col;
    cost.appendChild(it);
  }
  c.appendChild(cost);

  attachCostTip(c, actor, card, nameForCard(card));
  if (clickable) {
    // 卡面费用只用颜色表达，读屏用户看不到；把成本写进按钮的可访问名称里。
    const costText = COLORS.filter((x) => card.cost[x])
      .map((x) => `${card.cost[x]}${COLOR_META[x].name}`).join(' ');
    makeButton(c, `${nameForCard(card)}${card.points ? '，★' + card.points : ''}，需 ${costText}，查看成本并购买或预定`,
      () => selectBoardCard(card, tier, pos));
  }
  return c;
}

function renderBoard() {
  const board = $('#board');
  board.innerHTML = '';
  for (const tier of [3, 2, 1]) {
    const wrap = el('div', 'tier');
    const head = el('div', 'tier-head', `等级 ${tier} · 剩余牌堆 ${G().decks[tier].length}`);
    wrap.appendChild(head);
    const row = el('div', 'tier-row');
    const deck = el('div', 'deck', `预定<br>牌堆顶`);
    if (G().decks[tier].length && canAct()) {
      deck.classList.add('selectable');
      makeButton(deck, `预定 等级 ${tier} 牌堆顶的卡`, () => doReserveDeck(tier));
    }
    row.appendChild(deck);
    G().board[tier].forEach((card, pos) => {
      if (card) row.appendChild(cardNode(card, tier, pos));
      else row.appendChild(el('div', 'card', ''));
    });
    wrap.appendChild(row);
    board.appendChild(wrap);
  }
}

// 预定卡缩略：悬浮看差多少代币，本人回合可直接点击购买。
function reservedNode(card, owner, mine) {
  const n = el('div', 'res-card');
  const ok = canAfford(owner, card);
  if (ok) n.classList.add('afford');
  const img = el('img'); img.src = spriteFor(card); img.alt = nameForCard(card); img.loading = 'lazy';
  img.onerror = () => { img.onerror = null; img.src = spriteForCard(card); };
  n.appendChild(img);
  if (card.points) n.appendChild(el('span', 'res-pts', '★' + card.points));
  const b = el('span', 'res-bonus'); b.dataset.color = card.bonus;
  n.appendChild(b);
  attachCostTip(n, () => owner, card, nameForCard(card));
  if (mine) {
    n.classList.add('selectable');
    if (ok) makeButton(n, `购买预定的 ${nameForCard(card)}`, () => commit({ type: 'buy', source: 'reserved', cardId: card.id }, card));
    else { n.classList.add('locked'); n.setAttribute('aria-disabled', 'true'); }
  }
  return n;
}

function renderPlayers() {
  const box = $('#players');
  box.innerHTML = '';
  G().players.forEach((p, i) => {
    const active = i === G().current && !G().winner;
    const isMine = session.controls(p.id);
    const node = el('div', 'player' + (active ? ' active' : ''));
    const name = el('div', 'name');
    name.appendChild(el('span', null, p.name + (isMine && session.mode === 'net' ? ' （你）' : '')));
    name.appendChild(el('span', 'score', '★ ' + p.points));
    node.appendChild(name);
    const t = el('div', 'tallies');
    for (const c of COLORS) {
      const tally = el('div', 'tally');
      const dot = el('span', 'dot'); dot.dataset.color = c;
      tally.appendChild(dot);
      tally.appendChild(el('span', null, `${p.tokens[c]}<small>+${p.bonuses[c]}</small>`));
      t.appendChild(tally);
    }
    // 大师球用宝可球图形，和前面 5 个色块区分开。
    const gd = el('div', 'tally'); gd.appendChild(el('span', 'ball'));
    gd.appendChild(el('span', null, String(p.gold)));
    gd.title = `${GOLD_META.name}（万能）`;
    t.appendChild(gd);
    node.appendChild(t);
    if (p.reserved.length) {
      const res = el('div', 'reserved');
      res.appendChild(el('div', 'res-label', `预定 ${p.reserved.length}/3`));
      const strip = el('div', 'res-strip');
      const mine = active && canAct();
      p.reserved.forEach((card) => {
        strip.appendChild(reservedNode(card, p, mine));
      });
      res.appendChild(strip);
      node.appendChild(res);
    }
    box.appendChild(node);
  });
}
// ---------- 动作栏 ----------
function renderActionBar() {
  const bar = $('#action-bar');
  bar.innerHTML = '';
  if (G().winner) {
    bar.appendChild(el('div', 'turn-label', '对局结束'));
    return;
  }
  const label = el('div', 'turn-label', `轮到 <b>${actor().name}</b>`);
  bar.appendChild(label);

  // 房主掉线：状态只存在房主内存里，本局没法继续。必须明说，
  // 否则界面会一直显示"轮到 XX"、点哪儿都没反应，玩家以为是卡了。
  if (session.hostGone) {
    bar.appendChild(el('div', 'sel-desc', '房主已离开，本局无法继续'));
    const out = el('button', 'btn-mini primary', '返回大厅');
    out.addEventListener('click', () => {
      if (session) { session.leave(); session = null; }
      show('setup');
    });
    bar.appendChild(out);
    return;
  }

  // 联机时别人的回合：只展示等待提示，不给任何可点的动作。
  if (!canAct()) {
    const w = el('div', null, '<small>等待对手行动…</small>');
    w.style.color = 'var(--muted)';
    bar.appendChild(w);
    return;
  }

  // 选取直接在棋盘上进行，动作栏只负责确定/取消。
  if (ui.card) {
    const card = ui.card.card;
    bar.appendChild(el('div', 'sel-desc',
      `已选 <b>${nameForCard(card)}</b> <span class="sw" data-color="${card.bonus}"></span>`
      + `${card.points ? ' ★' + card.points : ''}`));
    const buy = el('button', 'btn-mini primary', '确定购买');
    buy.disabled = !canAfford(actor(), card);
    buy.addEventListener('click', () => commit(buyAction(ui.card), card));
    bar.appendChild(buy);
    const rsv = el('button', 'btn-mini', `预定 得${GOLD_META.name}`);
    rsv.disabled = actor().reserved.length >= 3;
    rsv.addEventListener('click', () => commit({ type: 'reserve', source: 'board', tier: ui.card.tier, pos: ui.card.pos }, card, true));
    bar.appendChild(rsv);
    bar.appendChild(cancelBtn());
    if (!canAfford(actor(), card)) bar.appendChild(hint('代币不足，可先预定占位'));
  } else if (ui.picked.length) {
    const swatches = ui.picked.map((c) => `<span class="sw" data-color="${c}"></span>`).join(' ');
    bar.appendChild(el('div', 'sel-desc', `已选 ${swatches}`));
    const confirm = el('button', 'btn-mini primary', '确定');
    confirm.disabled = !validTake();
    confirm.addEventListener('click', commitTake);
    bar.appendChild(confirm);
    bar.appendChild(cancelBtn());
    bar.appendChild(hint('3 种不同色各 1，或同色 2 个（该色需 ≥4）；再点已选中的球可取消'));
  } else {
    bar.appendChild(hint('点宝石拿取，点宝可梦购买或预定'));
  }
}

function hint(text) {
  const t = el('div', 'bar-hint', `<small>${text}</small>`);
  return t;
}

function cancelBtn() {
  const b = el('button', 'btn-mini', '取消');
  b.addEventListener('click', () => { ui = { picked: [], card: null }; renderAll(); });
  return b;
}

function buyAction(sel) {
  return { type: 'buy', source: 'board', tier: sel.tier, pos: sel.pos };
}

// ---------- 交互 ----------
function pickGem(color) {
  // 选宝石与选卡互斥：点宝石自动取消已选的卡。
  if (ui.card) ui.card = null;
  const p = ui.picked;
  const sameCount = p.filter((x) => x === color).length;

  // 点已选中的色：唯一的例外是"同色双击拿 2"（该色≥4），其余一律后退。
  // 后退语义按选中形态区分：单独选中一个色时再点是取消该色；
  // 多色时是摘掉这一色，好让玩家不必整组重选。
  if (sameCount > 0) {
    if (sameCount === 1 && p.length === 1 && G().bank[color] >= 4) {
      p.push(color); // [c] -> [c,c]
    } else {
      ui.picked = p.filter((x) => x !== color); // [c] / [c,c] -> []，[c,d] -> [d]
    }
    return renderAll();
  }

  // 同色 2 个是终态：不能再掺别的色，也不能超过 3 种。两者都给一句反馈，
  // 免得玩家点了没反应、以为界面卡住。
  if (p.length >= 3) {
    renderAll();
    return flash('最多选 3 种不同色，再点已选中的球可取消');
  }
  if (p.length === 2 && p[0] === p[1]) {
    renderAll();
    return flash('已选同色 2 个，再点该球可取消');
  }
  p.push(color);
  renderAll();
}

function validTake() {
  const p = ui.picked;
  if (p.length === 0) return false;
  const distinct = new Set(p);
  if (distinct.size === 1 && p.length === 2) return G().bank[p[0]] >= 4;   // 同色 2 个
  if (distinct.size !== p.length) return false;
  // 规则要求 3 种不同色；只有银行可选色不足 3 种时才允许按实际数量少拿。
  // 必须和 engine.js 的 take3 校验保持一致，否则会出现"能点确定但被拒"。
  const avail = COLORS.filter((c) => G().bank[c] > 0).length;
  return p.length === Math.min(3, avail);
}

function commitTake() {
  const p = ui.picked;
  const distinct = new Set(p);
  const action = distinct.size === 1 && p.length === 2
    ? { type: 'take2', color: p[0] }
    : { type: 'take3', colors: [...distinct] };
  commit(action, null);
}

function selectBoardCard(card, tier, pos) {
  // 再点同一张即取消；选卡自动清空已选宝石。
  const same = ui.card && ui.card.card.id === card.id;
  ui = { picked: [], card: same ? null : { card, tier, pos } };
  renderAll();
}

function doReserveDeck(tier) {
  if (actor().reserved.length >= 3) return;
  commit({ type: 'reserve', source: 'deck', tier }, null, true);
}
// ---------- 提交动作（含弃牌流程） ----------
function commit(action, card, silent) {
  if (!canAct()) return;
  // 先本地预演：拿到 must_discard 就先走弃牌弹窗，把完整动作一次性提交。
  const pre = session.dryRun(action);
  if (!pre.ok) {
    if (pre.error === 'must_discard') return askDiscard(action, card, silent);
    return flash(why(pre.error));
  }
  const res = session.submit(action);
  if (!res.ok) return flash(why(res.error));
  // 买卡叫声：本地立即播，不等状态回传。
  if (card && action.type === 'buy') playCry(cryForCard(card));
  ui = { picked: [], card: null };
  renderAll();
}

function askDiscard(action, card, silent) {
  // 预演：先算出这步会得到的宝石，让玩家把总数弃到 10。
  const pl = actor();
  const tokens = { ...pl.tokens };
  let gold = pl.gold;
  if (action.type === 'take3') for (const c of new Set(action.colors)) tokens[c]++;
  else if (action.type === 'take2') tokens[action.color] += 2;
  else if (action.type === 'reserve') gold += G().bank.gold > 0 ? 1 : 0;
  const total = () => COLORS.reduce((s, c) => s + tokens[c], 0) + gold;
  const need = total() - 10;

  const chosen = {};
  const overlay = el('div', 'overlay');
  const dlg = el('div', 'dialog');
  dlg.appendChild(el('h2', null, '宝石超过 10 个'));
  dlg.appendChild(el('p', null, `请弃回 <b>${need}</b> 个宝石。`));
  const grid = el('div', 'bank'); grid.style.margin = '16px 0';
  const counter = el('div', null, '');
  counter.setAttribute('role', 'status');
  const refresh = (focusColor) => {
    grid.innerHTML = '';
    // 大师球也计入 10 张上限，所以也要出现在可弃列表里。
    const slots = [...COLORS.map((c) => ({ key: c, left: tokens[c] })), { key: 'gold', left: gold }];
    for (const { key, left } of slots) {
      const remain = left - (chosen[key] || 0);
      const node = gemNode(key, remain, remain > 0);
      if (remain > 0) {
        const label = key === 'gold' ? GOLD_META.name : COLOR_META[key].name;
        makeButton(node, `弃 ${label}，还可选 ${remain} 个`, () => {
          const picked = Object.values(chosen).reduce((a, b) => a + b, 0);
          if (remain > 0 && picked < need) { chosen[key] = (chosen[key] || 0) + 1; refresh(key); }
        });
      }
      if (key === focusColor) node.dataset.wantFocus = '1';
      grid.appendChild(node);
    }
    const picked = Object.values(chosen).reduce((a, b) => a + b, 0);
    counter.textContent = `已选弃 ${picked} / ${need}`;
    okBtn.disabled = picked !== need;
    // refresh 会重建整格，键盘用户按一次就丢焦点 —— 把焦点放回同一颗宝石上。
    const want = grid.querySelector('[data-want-focus]');
    if (want) want.focus();
  };
  const row = el('div', 'row');
  const reset = el('button', 'btn-mini', '重选');
  reset.addEventListener('click', () => { for (const k in chosen) delete chosen[k]; refresh(); });
  const okBtn = el('button', 'btn-mini primary', '确认弃牌');
  row.appendChild(reset); row.appendChild(okBtn);
  dlg.appendChild(grid); dlg.appendChild(counter); dlg.appendChild(row);
  refresh();
  const closeDlg = openDialog(dlg, overlay);
  okBtn.addEventListener('click', () => {
    closeDlg();
    commit({ ...action, discard: chosen }, card, silent);
  });
}

// ---------- 提示 / 规则 / 胜利 ----------
const why = (code) => DENY_TEXT[code] || ('无法执行：' + code);

// 读屏播报。flash/toast 是非法操作与联机状态的唯一反馈，
// 键盘/读屏用户不能只依赖一闪而过的视觉提示。清空再写入才会重复播报同一句话。
function announce(msg) {
  const live = $('#live');
  if (!live) return;
  live.textContent = '';
  setTimeout(() => { live.textContent = msg; }, 30);
}

function flash(msg) {
  announce(msg);
  const bar = $('#action-bar');
  const n = el('div', null, msg); n.style.color = 'var(--r)'; n.style.fontWeight = '700';
  bar.appendChild(n);
  setTimeout(() => n.remove(), 2000);
}

function showRules() {
  const overlay = el('div', 'overlay');
  const dlg = el('div', 'dialog');
  const gold = `<span class="sw" data-color="gold"></span>`;
  dlg.innerHTML = `<h2>怎么玩</h2>
    <p>每回合从以下选择一项：</p>
    <ul>
      <li>拿 3 个不同颜色的能量宝石各 1 个</li>
      <li>拿同色 2 个（该色银行需≥4）</li>
      <li>购买展示区或已预定的宝可梦卡</li>
      <li>预定一张卡并获得 1 个大师球${gold}（万能）</li>
    </ul>
    <p>卡上的属性加成永久抵扣后续购买成本。集齐贵族要求的加成会自动获得 ★3。</p>
    <p>手中宝石（含${gold}）最多 10 个。率先达到 <b>★15</b> 后，打满当前一轮，最高分者获胜。</p>
    <div class="row"><button class="btn-mini primary" id="rules-close">明白了</button></div>`;
  const close = openDialog(dlg, overlay);
  $('#rules-close').addEventListener('click', close);
}

function showWin() {
  const winner = G().players.find((p) => p.id === G().winner);
  const overlay = el('div', 'overlay');
  const dlg = el('div', 'dialog');
  const ranked = [...G().players].sort((a, b) => b.points - a.points || a.cards.length - b.cards.length);
  dlg.innerHTML = `<h2>对局结束</h2>
    <p>冠军训练家</p>
    <div class="win-name">${winner.name} · ★${winner.points}</div>
    <ul>${ranked.map((p) => `<li>${p.name} — ★${p.points}（${p.cards.length} 张卡）</li>`).join('')}</ul>
    <div class="row"><button class="btn-mini primary" id="win-again">再来一局</button></div>`;
  openDialog(dlg, overlay);
  $('#win-again').addEventListener('click', () => location.reload());
}

// ---------- toast ----------
function toast(msg) {
  announce(msg);
  const n = el('div', 'toast', msg);
  $('#toast-root').appendChild(n);
  setTimeout(() => n.classList.add('out'), 2600);
  setTimeout(() => n.remove(), 3000);
}

// ---------- 大厅 ----------
async function enterLobby() {
  show('lobby');
  $('#lobby-my-name').textContent = getIdentity().name + ' · #' + shortId();
  $('#lobby-status').textContent = '正在连接信令网络…';
  try {
    lobby = await joinLobby();
  } catch (e) {
    $('#lobby-status').textContent = '连接失败：' + e.message + '（可能被网络屏蔽，试试热点或换网络）';
    return;
  }
  $('#lobby-status').textContent = '已连接。看到的人都在线，房间可直接点进去。';
  lobby.onUpdate(renderLobby);
}

function renderLobby({ people, rooms, selfId }) {
  const list = $('#online-list');
  list.innerHTML = '';
  $('#online-count').textContent = `（${people.length}）`;
  for (const p of people) {
    const row = el('div', 'list-row');
    const tag = p.status === 'hosting' ? '开房中' : p.status === 'playing' ? '对战中' : '空闲';
    row.appendChild(el('span', null, `${p.name}${p.id === selfId ? ' （你）' : ''}`));
    row.appendChild(el('span', 'muted', tag));
    list.appendChild(row);
  }

  const rl = $('#room-list');
  rl.innerHTML = '';
  if (!rooms.length) rl.appendChild(el('div', 'muted', '还没有人开房。你可以开一个。'));
  for (const r of rooms) {
    const row = el('div', 'list-row');
    row.appendChild(el('span', null, `${r.roomId} · 房主 ${r.host} · ${r.seats}/${r.max}`));
    const btn = el('button', 'btn-mini', r.mine ? '回到房间' : '加入');
    btn.addEventListener('click', () => enterRoom(r.roomId, r.mine));
    row.appendChild(btn);
    rl.appendChild(row);
  }
}

function initLobbyControls() {
  $('#lobby-back').addEventListener('click', () => {
    if (lobby) { lobby.leave(); lobby = null; }
    show('setup');
  });
  $('#lobby-rename').addEventListener('click', () => {
    // 原本用 window.prompt：跳出应用自己的弹层风格、阻塞主线程，
    // 沙箱/嵌入环境里还会静默失效。改成应用内的弹层。
    const overlay = el('div', 'overlay');
    const dlg = el('div', 'dialog');
    dlg.innerHTML = `<h2>改名</h2>
      <label class="field"><span>新的训练家名</span>
        <input id="rename-input" type="text" maxlength="10" /></label>
      <div class="row"><button class="btn-mini" id="rename-cancel">取消</button>
        <button class="btn-mini primary" id="rename-ok">确定</button></div>`;
    const close = openDialog(dlg, overlay);
    const input = dlg.querySelector('#rename-input');
    input.value = getIdentity().name;
    input.select();
    const apply = () => {
      const name = input.value.trim();
      close();
      if (!name) return;
      setName(name);
      $('#lobby-my-name').textContent = getIdentity().name + ' · #' + shortId();
      if (lobby) lobby.announce({ name: getIdentity().name });
    };
    dlg.querySelector('#rename-cancel').addEventListener('click', close);
    dlg.querySelector('#rename-ok').addEventListener('click', apply);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); apply(); } });
  });
  $('#create-room-btn').addEventListener('click', () => enterRoom(makeRoomCode(), true));
  $('#join-code-btn').addEventListener('click', () => {
    const code = normalizeRoomCode($('#join-code').value);
    if (!code) return toast('房间码格式不对');
    enterRoom(code, false);
  });
}

// ---------- 房间 ----------
async function enterRoom(roomId, asHost) {
  show('room');
  $('#room-code').textContent = roomId;
  $('#room-status').textContent = asHost ? '房间已开，等朋友加入…' : '正在连接房主…';
  $('#room-seats').innerHTML = '';
  try {
    session = await createNetSession({ roomId, asHost });
  } catch (e) {
    $('#room-status').textContent = '连接失败：' + e.message;
    return;
  }
  if (lobby) lobby.announce({ status: 'hosting', roomId: asHost ? roomId : null, seats: 1 });

  session.onNotice(toast);
  session.onChange(({ events }) => {
    if (session.phase === 'playing' && session.state) {
      if ($('#game').classList.contains('hidden')) {
        if (lobby) lobby.announce({ status: 'playing', roomId: null });
        startSession(session, { wire: false });
        return;
      }
      if (events) for (const ev of events) if (ev.kind === 'buy') playCryById(ev.cardId);
      renderAll();
      return;
    }
    renderRoom();
  });
  renderRoom();
}

function renderRoom() {
  const box = $('#room-seats');
  box.innerHTML = '';
  const seats = session.roster || [];
  for (const r of seats) {
    const row = el('div', 'list-row');
    const who = r.name + (r.id === session.myId ? ' （你）' : '') + (r.host ? ' · 房主' : '');
    row.appendChild(el('span', null, who));
    row.appendChild(el('span', r.ready ? 'ok' : 'muted', r.online ? (r.ready ? '已准备' : '未准备') : '掉线'));
    box.appendChild(row);
  }
  if (!seats.length) box.appendChild(el('div', 'muted', '等待握手…'));

  const meSeat = seats.find((r) => r.id === session.myId);
  $('#ready-btn').textContent = meSeat && meSeat.ready ? '取消准备' : '准备';
  const startBtn = $('#start-net-btn');
  startBtn.classList.toggle('hidden', !session.isHost);
  startBtn.disabled = !session.canStart();
  $('#room-status').textContent = session.isHost
    ? (session.canStart() ? '所有人已准备，可以开始。' : '至少 2 人且全部准备后可开始。')
    : '等房主开始对战。';
  if (session.isHost && lobby) lobby.announce({ status: 'hosting', roomId: session.roomId, seats: seats.length });
}

function initRoomControls() {
  $('#ready-btn').addEventListener('click', () => {
    const meSeat = (session.roster || []).find((r) => r.id === session.myId);
    session.setReady(!(meSeat && meSeat.ready));
    renderRoom();
  });
  $('#start-net-btn').addEventListener('click', () => {
    if (!session.start()) toast('还不能开始');
  });
  $('#leave-room-btn').addEventListener('click', () => {
    if (session) { session.leave(); session = null; }
    if (lobby) lobby.announce({ status: 'idle', roomId: null, seats: 0 });
    show('lobby');
  });
}

// ---------- 启动 ----------
initSetup();
initTopbar();
initLobbyControls();
initRoomControls();



