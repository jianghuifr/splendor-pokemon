// 主题映射层：把 Splendor 的抽象数据映射到宝可梦素材（不改数值平衡）。
import { CARDS } from './cards.js';

const BASE = './assets';
const cries = new Set(['abra','bulbasaur','charmander','chikorita','cubone','cyndaquil','dratini','eevee','gengar','jigglypuff','lapras','magikarp','meowth','mew','oddish','pikachu','poliwag','psyduck','snorlax','squirtle','togepi','totodile','vulpix']);

// 5 宝石色 → 属性主题
export const COLOR_META = {
  w: { name: '一般', hex: '#e8e2d0', text: '#5a5344' },
  u: { name: '水', hex: '#4a90d9', text: '#e6f2ff' },
  g: { name: '草', hex: '#5fbf6b', text: '#eafff0' },
  r: { name: '火', hex: '#e0533d', text: '#fff0ec' },
  k: { name: '超能', hex: '#3a3550', text: '#efe9ff' },
};
export const GOLD_META = { name: '大师球', hex: '#f4c542', text: '#5a4700' };

// 各色宝可梦按进化阶段分组：tier1=初始, tier2=中间, tier3=最终/传说。
const POOLS = {
  r: { 1: ['charmander','vulpix','cyndaquil'], 2: ['charmeleon','quilava'], 3: ['charizard','typhlosion','groudon'] },
  u: { 1: ['squirtle','totodile','poliwag','magikarp','psyduck'], 2: ['wartortle','croconaw'], 3: ['blastoise','feraligatr','lapras','kyogre'] },
  g: { 1: ['bulbasaur','chikorita','oddish'], 2: ['ivysaur','bayleef'], 3: ['venusaur','meganium'] },
  w: { 1: ['eevee','jigglypuff','togepi','meowth','cubone'], 2: ['pikachu','butterfree'], 3: ['snorlax','pidgeot'] },
  k: { 1: ['abra','dratini'], 2: ['gengar'], 3: ['mewtwo','mew','dragonite'] },
};

// 为每张卡确定性分配一只宝可梦：按 (tier,bonus) 出现序在池内循环。
const cardMon = {};
{
  const counter = {};
  for (const card of CARDS) {
    const key = card.tier + card.bonus;
    const idx = counter[key] = (counter[key] ?? -1) + 1;
    const pool = POOLS[card.bonus][card.tier];
    cardMon[card.id] = pool[idx % pool.length];
  }
}

function cryFor(mon, color) {
  if (cries.has(mon)) return mon;
  // 回退：同色任一有叫声者，否则皮卡丘。
  for (const t of [1, 2, 3]) for (const m of POOLS[color][t]) if (cries.has(m)) return m;
  return 'pikachu';
}

// 中文名，供卡面与悬浮提示显示。键与 POOLS 一一对应。
const MON_NAMES = {
  charmander: '小火龙', vulpix: '六尾', cyndaquil: '火球鼠',
  charmeleon: '火恐龙', quilava: '火岩鼠',
  charizard: '喷火龙', typhlosion: '火暴兽', groudon: '固拉多',
  squirtle: '杰尼龟', totodile: '小锯鳄', poliwag: '蚊香蝌蚪', magikarp: '鲤鱼王', psyduck: '可达鸭',
  wartortle: '卡咪龟', croconaw: '蓝鳄',
  blastoise: '水箭龟', feraligatr: '大力鳄', lapras: '拉普拉斯', kyogre: '盖欧卡',
  bulbasaur: '妙蛙种子', chikorita: '菊草叶', oddish: '走路草',
  ivysaur: '妙蛙草', bayleef: '月桂叶',
  venusaur: '妙蛙花', meganium: '大竺葵',
  eevee: '伊布', jigglypuff: '胖丁', togepi: '波克比', meowth: '喵喵', cubone: '卡拉卡拉',
  pikachu: '皮卡丘', butterfree: '巴大蝴',
  snorlax: '卡比兽', pidgeot: '大比鸟',
  abra: '凯西', dratini: '迷你龙',
  gengar: '耿鬼',
  mewtwo: '超梦', mew: '梦幻', dragonite: '快龙',
};

export function monForCard(card) {
  return cardMon[card.id];
}
export function nameForCard(card) {
  const mon = cardMon[card.id];
  return MON_NAMES[mon] || mon;
}
export function spriteForCard(card) {
  return `${BASE}/pokemon/animated/${cardMon[card.id]}.gif`;
}
export function staticForCard(card) {
  return `${BASE}/pokemon/${cardMon[card.id]}.png`;
}
export function cryForCard(card) {
  return `${BASE}/pokemon/cries/${cryFor(cardMon[card.id], card.bonus)}.ogg`;
}

// 贵族 → 角色 SVG（教授/招牌角色）。
const NOBLE_CHARS = [
  { file: 'professor-oak.svg', name: '大木博士' },
  { file: 'professor-birch.svg', name: '小田卷博士' },
  { file: 'nurse-joy.svg', name: '乔伊小姐' },
  { file: 'ash-mom.svg', name: '小智妈妈' },
  { file: 'ditto.svg', name: '百变怪' },
];
export function nobleArt(noble, i) {
  const c = NOBLE_CHARS[i % NOBLE_CHARS.length];
  return { src: `${BASE}/characters/${c.file}`, name: c.name };
}

export const MUSIC = {
  title: `${BASE}/music/pokemon-rb-title-screen.mp3`,
  battle: `${BASE}/music/pokemon-rb-wild-battle.mp3`,
  victory: `${BASE}/music/pokemon-rb-victory-wild.mp3`,
};
