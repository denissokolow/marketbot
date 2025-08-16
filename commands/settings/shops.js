const { Markup } = require('telegraf');

module.exports = ({ bot, db, shared, data }) => {
  const { CB, PAGE_SIZE, asInt, parseData, sendOrEdit, backRow } = shared;

  function shopsKeyboard(shops) {
    const rows = shops.map(s =>
      [Markup.button.callback(`🏪 ${s.name || `Магазин #${s.id}`}`, `${CB.SHOP_OPEN}:${s.id}`)]
    );
    rows.push([
      Markup.button.callback('➕ Добавить магазин', CB.ADD_SHOP),
      Markup.button.callback('🗑 Удалить магазин', CB.DEL_SHOP),
    ]);
    rows.push(backRow(CB.MAIN));
    return Markup.inlineKeyboard(rows);
  }

function shopSubmenuKeyboard(shopId) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📦 Товары (выбрать для отслеживания)', `${CB.PRODS}:${shopId}:1`)],
    [Markup.button.callback('💰 Себестоимость товаров', `set_costs:${shopId}:1`)],
    backRow(CB.SHOPS),
  ]);
}

  function productsKeyboard(shopId, page, totalPages, items) {
    const rows = [];
    for (const it of items) {
      const title = it.title || `SKU ${it.sku}`;
      const short = title.length > 32 ? (title.slice(0, 31) + '…') : title;
      const label = `${it.tracked ? '✅' : '❌'} ${short} (${it.sku})`;
      rows.push([Markup.button.callback(label, `${CB.TOGGLE}:${shopId}:${it.sku}:${page}`)]);
    }
    const nav = [];
    if (page > 1) nav.push(Markup.button.callback('⬅️', `${CB.PRODS}:${shopId}:${page - 1}`));
    nav.push(Markup.button.callback(`стр. ${page}/${totalPages}`, 'noop'));
    if (page < totalPages) nav.push(Markup.button.callback('➡️', `${CB.PRODS}:${shopId}:${page + 1}`));
    if (nav.length) rows.push(nav);
    rows.push(backRow(`${CB.SHOP_OPEN}:${shopId}`));
    return Markup.inlineKeyboard(rows);
  }

  // Список магазинов
  bot.action(CB.SHOPS, async (ctx) => {
    await ctx.answerCbQuery();
    const shops = await data.getShopsByChat(db, ctx.from.id);
    if (!shops.length) {
      await sendOrEdit(
        ctx,
        '🏬 У вас пока нет магазинов.',
        Markup.inlineKeyboard([
          [Markup.button.callback('➕ Добавить магазин', CB.ADD_SHOP)],
          backRow(CB.MAIN),
        ])
      );
      return;
    }
    await sendOrEdit(ctx, 'Ваши магазины:', shopsKeyboard(shops));
  });

  // Подменю магазина
  bot.action(new RegExp(`^${CB.SHOP_OPEN}:(\\d+)$`), async (ctx) => {
    await ctx.answerCbQuery();
    const { a: shopIdStr } = parseData(ctx.match.input);
    const shopId = asInt(shopIdStr);
    const shop = await data.getShopById(db, shopId);
    if (!shop) {
      await sendOrEdit(ctx, 'Магазин не найден.', Markup.inlineKeyboard([backRow(CB.SHOPS)]));
      return;
    }
    const name = shop.name || `Магазин #${shop.id}`;
    await sendOrEdit(ctx, `Магазин: ${name}`, shopSubmenuKeyboard(shop.id));
  });

  // Лист товаров магазина
  bot.action(new RegExp(`^${CB.PRODS}:(\\d+):(\\d+)$`), async (ctx) => {
    await ctx.answerCbQuery();
    const { a: shopIdStr, b: pageStr } = parseData(ctx.match.input);
    const shopId = asInt(shopIdStr);
    const page = Math.max(1, asInt(pageStr, 1));

    const { items, total } = await data.getShopProductsPage(db, shopId, page, PAGE_SIZE);
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

    const shop = await data.getShopById(db, shopId);
    const title = shop?.name || `Магазин #${shopId}`;
    const text = `📦 Товары магазина: ${title}\nВыберите, что отслеживать:`;

    await sendOrEdit(ctx, text, productsKeyboard(shopId, page, totalPages, items));
  });

  // Переключить отслеживание
  bot.action(new RegExp(`^${CB.TOGGLE}:(\\d+):(\\d+):(\\d+)$`), async (ctx) => {
    const { a: shopIdStr, b: skuStr, c: pageStr } = parseData(ctx.match.input);
    const shopId = asInt(shopIdStr);
    const sku = asInt(skuStr);
    const page = Math.max(1, asInt(pageStr, 1));

    await data.toggleTracked(db, shopId, sku);
    await ctx.answerCbQuery('Готово');

    const { items, total } = await data.getShopProductsPage(db, shopId, page, PAGE_SIZE);
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const shop = await data.getShopById(db, shopId);
    const title = shop?.name || `Магазин #${shopId}`;
    const text = `📦 Товары магазина: ${title}\nВыберите, что отслеживать:`;
    await sendOrEdit(ctx, text, productsKeyboard(shopId, page, totalPages, items));
  });

  // Заглушки add/del
  bot.action(CB.ADD_SHOP, async (ctx) => {
    await ctx.answerCbQuery();
    await sendOrEdit(
      ctx,
      'Добавление магазина — в разработке.\nПока добавляйте тем способом, который уже используете.',
      Markup.inlineKeyboard([backRow(CB.SHOPS)])
    );
  });

  bot.action(CB.DEL_SHOP, async (ctx) => {
    await ctx.answerCbQuery();
    await sendOrEdit(
      ctx,
      'Удаление магазина — в разработке.',
      Markup.inlineKeyboard([backRow(CB.SHOPS)])
    );
  });
};
