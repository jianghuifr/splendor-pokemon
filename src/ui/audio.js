// 音频：宝可梦叫声 + 背景音乐，带全局静音。浏览器需用户交互后才允许播放。
import { MUSIC } from '../game/pokemon-map.js';

let muted = false;
let bgm = null;
let bgmKey = null;

export function isMuted() { return muted; }

export function setMuted(v) {
  muted = v;
  if (bgm) bgm.muted = v;
  return muted;
}

export function toggleMute() { return setMuted(!muted); }

export function playCry(src) {
  if (muted || !src) return;
  const a = new Audio(src);
  a.volume = 0.7;
  a.play().catch(() => {});
}

// key: 'title' | 'battle' | 'victory'
export function playBGM(key) {
  if (bgmKey === key && bgm) { bgm.muted = muted; return; }
  stopBGM();
  const url = MUSIC[key];
  if (!url) return;
  bgmKey = key;
  bgm = new Audio(url);
  bgm.loop = key !== 'victory';
  bgm.volume = 0.4;
  bgm.muted = muted;
  bgm.play().catch(() => {}); // 自动播放被拦时静默失败，等下次交互
}

export function stopBGM() {
  if (bgm) { bgm.pause(); bgm.currentTime = 0; }
  bgm = null; bgmKey = null;
}
