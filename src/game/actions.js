// 动作意图定义。UI/网络层构造这些对象交给 engine.applyAction 校验+应用。
// discard: 可选，形如 {w:1,k:2}，用于拿宝石后手持超过 10 个时弃回银行。
export const Action = {
  take3: (colors, discard) => ({ type: 'take3', colors, discard }),
  take2: (color, discard) => ({ type: 'take2', color, discard }),
  // source: 'board' 用 tier+pos；'deck' 用 tier（取牌堆顶，UI 不显示牌面）
  reserve: (source, tier, pos, discard) => ({ type: 'reserve', source, tier, pos, discard }),
  // source: 'board'(tier+pos) 或 'reserved'(cardId)
  buy: (source, { tier, pos, cardId } = {}) => ({ type: 'buy', source, tier, pos, cardId }),
};

export const ACTION_TYPES = ['take3', 'take2', 'reserve', 'buy'];
