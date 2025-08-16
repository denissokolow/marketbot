const { Markup } = require('telegraf');

const CB = {
  MAIN:        'set_main',
  PROFILE:     'set_prof',
  SHOPS:       'set_shops',
  SHOP_OPEN:   'set_shop',     // set_shop:<shopId>

  PRODS:       'set_prods',    // set_prods:<shopId>:<page>
  TOGGLE:      'set_tgl',      // set_tgl:<shopId>:<sku>:<page>

  ADD_SHOP:    'set_add_shop',
  DEL_SHOP:    'set_del_shop',

  COSTS:       'set_costs',    // set_costs:<page>
  COST_SET:    'set_cost',     // set_cost:<shopId>:<sku>:<page>
};

const PAGE_SIZE = 10;
const costInputState = new Map();

const asInt = (v, d = 0) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};

function parseData(data) {
  const [cmd, a, b, c] = String(data).split(':');
  return { cmd, a, b, c };
}

async function sendOrEdit(ctx, text, keyboard) {
  try {
    if (ctx.updateType === 'callback_query') {
      await ctx.editMessageText(text, { reply_markup: keyboard?.reply_markup });
    } else {
      await ctx.reply(text, keyboard);
    }
  } catch {
    await ctx.reply(text, keyboard);
  }
}

function mainKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('👤 Профиль', CB.PROFILE)],
    [Markup.button.callback('🏬 Магазины', CB.SHOPS)],
    [Markup.button.callback('💵 Себестоимость товаров', `${CB.COSTS}:1`)],
  ]);
}

function backRow(cb = CB.MAIN) {
  return [Markup.button.callback('◀️ Назад', cb)];
}

module.exports = {
  CB,
  PAGE_SIZE,
  asInt,
  parseData,
  sendOrEdit,
  mainKeyboard,
  backRow,
  costInputState,
};

