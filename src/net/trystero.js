// Trystero 加载点。集中在一处便于日后换成本地 vendor 副本或切换信令策略。
// nostr 策略用公共 relay 做信令，无需自建后端；连接建立后是浏览器间 WebRTC 直连。
export const APP_ID = 'pkmn-splendor-v1';
export const CDN = 'https://esm.run/trystero@0.25.3/nostr';

let mod = null;

export async function loadTrystero() {
  if (!mod) mod = await import(/* @vite-ignore */ CDN);
  return mod;
}
