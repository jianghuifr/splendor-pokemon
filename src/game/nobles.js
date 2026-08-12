// 10 张贵族牌（标准 Splendor）。每张 3 分，requires 为所需各色「加成卡」数量。
// 5 张「三色各 3」+ 5 张「两色各 4」。色缩写同 cards.js：w u g r k。
export const NOBLES = [
  { id: 'n0', points: 3, requires: { w: 3, u: 3, g: 3 } },
  { id: 'n1', points: 3, requires: { u: 3, g: 3, r: 3 } },
  { id: 'n2', points: 3, requires: { g: 3, r: 3, k: 3 } },
  { id: 'n3', points: 3, requires: { w: 3, r: 3, k: 3 } },
  { id: 'n4', points: 3, requires: { w: 3, u: 3, k: 3 } },
  { id: 'n5', points: 3, requires: { r: 4, g: 4 } },
  { id: 'n6', points: 3, requires: { g: 4, u: 4 } },
  { id: 'n7', points: 3, requires: { u: 4, w: 4 } },
  { id: 'n8', points: 3, requires: { w: 4, k: 4 } },
  { id: 'n9', points: 3, requires: { r: 4, k: 4 } },
];
