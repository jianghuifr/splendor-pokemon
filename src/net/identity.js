// 持久唯一身份：localStorage UUID 作主键，浏览器指纹仅作辅助展示（不稳定，不做主键）。
const KEY = 'pkmn-splendor-identity';
const DEFAULT_NAMES = ['小智', '小霞', '小刚', '小茂', '小遥', '真司'];

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// 轻量指纹：UA + 屏幕 + 时区 + canvas 渲染差异，摘要成 8 位十六进制。
function fingerprint() {
  const bits = [
    navigator.userAgent,
    navigator.language,
    screen.width + 'x' + screen.height + 'x' + (screen.colorDepth || 0),
    new Date().getTimezoneOffset(),
    navigator.hardwareConcurrency || 0,
  ];
  try {
    const cv = document.createElement('canvas');
    cv.width = 60; cv.height = 20;
    const ctx = cv.getContext('2d');
    ctx.textBaseline = 'top';
    ctx.font = '13px sans-serif';
    ctx.fillStyle = '#f60';
    ctx.fillRect(0, 0, 40, 12);
    ctx.fillStyle = '#069';
    ctx.fillText('pkmn', 2, 2);
    bits.push(cv.toDataURL().slice(-48));
  } catch { /* canvas 被隐私模式屏蔽时忽略 */ }

  let h = 0x811c9dc5;
  const s = bits.join('|');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

let cached = null;

export function getIdentity() {
  if (cached) return cached;
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { /* 损坏则重建 */ }
  if (!saved || !saved.id) {
    saved = {
      id: uuid(),
      name: DEFAULT_NAMES[Math.floor(Math.random() * DEFAULT_NAMES.length)],
    };
  }
  saved.fp = fingerprint();
  cached = saved;
  persist();
  return cached;
}

function persist() {
  try { localStorage.setItem(KEY, JSON.stringify({ id: cached.id, name: cached.name })); } catch { /* 无痕模式忽略 */ }
}

export function setName(name) {
  const id = getIdentity();
  id.name = (name || '').trim().slice(0, 10) || id.name;
  persist();
  return id.name;
}

// 供 UI 显示的短标识，便于同名玩家区分。
export function shortId(id = getIdentity().id) {
  return id.replace(/-/g, '').slice(0, 4).toUpperCase();
}
