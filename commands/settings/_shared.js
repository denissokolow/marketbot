const { Markup } = require('telegraf');

const CB = {
  MAIN:        'set_main',
  PROFILE: 'profile',
  PROFILE_SHOP: 'profile_shop',

  SHOPS:       'set_shops',
  SHOP_OPEN:   'set_shop',     // set_shop:<shopId>

  // Товары (отслеживание)
  PRODS:       'set_prods',    // set_prods:<shopId>:<page>
  TOGGLE:      'set_tgl',      // set_tgl:<shopId>:<sku>:<page>

  // Себестоимость
  COSTS:       'set_costs',    // set_costs:<shopId>:<page>
  COST_SET:    'set_cost',     // set_cost:<shopId>:<sku>:<page>

  // Магазины: добавить/удалить
  ADD_SHOP:    'set_add_shop',
  ADD_CANCEL:  'set_add_cancel',
  DEL_SHOP:    'set_del_shop',
  DEL_CONF:    'set_del_conf',   // set_del_conf:<shopId>
  DEL_DO:      'set_del_do',     // set_del_do:<shopId>


};

const PAGE_SIZE = 10;

// ожидания ввода
const costInputState   = new Map(); // { shopId, sku, backData }
const addShopInputState = new Map(); // { step, shop_name, client_id }

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
    [Markup.button.callback('🏬 Магазин', CB.SHOPS)],
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
  addShopInputState,
};

