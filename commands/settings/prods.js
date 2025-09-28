// commands/settings/prods.js
const { Markup } = require('telegraf');

module.exports = ({ bot, db, shared, data }) => {
  const { CB, PAGE_SIZE, asInt, parseData, sendOrEdit, backRow } = shared;

  function prodsKeyboard(shopId, page, totalPages, items) {
    const rows = [];

    for (const it of items) {
      const tag = it.tracked ? '✅' : '☑️';
      const title = `${it.sku} — ${it.title}`.trim();
      const short = title.length > 48 ? title.slice(0, 47) + '…' : title;
      const right = ` (qty: ${it.quantity})`;
      rows.push([
        Markup.button.callback(
          `${tag} ${short}${right}`,
          `${CB.TOGGLE}:${shopId}:${it.sku}:${page}`
        ),
      ]);
    }

    const nav = [];
    if (page > 1) nav.push(Markup.button.callback('⬅️', `${CB.PRODS}:${shopId}:${page - 1}`));
    nav.push(Markup.button.callback(`стр. ${page}/${totalPages}`, 'noop'));
    if (page < totalPages) nav.push(Markup.button.callback('➡️', `${CB.PRODS}:${shopId}:${page + 1}`));
    if (nav.length) rows.push(nav);

    rows.push(backRow(`${CB.SHOP_OPEN}:${shopId}`)); // назад в подменю магазина
    return Markup.inlineKeyboard(rows);
  }

  // Открыть список товаров магазина с остатком > 0 (странично)
  bot.action(new RegExp(`^${CB.PRODS}:(\\d+):(\\d+)$`), async (ctx) => {
    try { await ctx.answerCbQuery(); } catch {}
    const { a: shopIdStr, b: pageStr } = parseData(ctx.match.input);
    const shopId = asInt(shopIdStr);
    const page   = Math.max(1, asInt(pageStr, 1));

    const { items, total } = await data.getShopProductsPage(db, shopId, page, PAGE_SIZE);

    if (!total) {
      await sendOrEdit(
        ctx,
        'В этом магазине пока нет товаров с положительным остатком.',
        Markup.inlineKeyboard([backRow(`${CB.SHOP_OPEN}:${shopId}`)])
      );
      return;
    }

    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    await sendOrEdit(
      ctx,
      '📦 Товары для отслеживания (остаток > 0):',
      prodsKeyboard(shopId, page, totalPages, items)
    );
  });

  // Переключить отслеживание конкретного SKU и перерисовать текущую страницу
  bot.action(new RegExp(`^${CB.TOGGLE}:(\\d+):(\\d+):(\\d+)$`), async (ctx) => {
    try { await ctx.answerCbQuery(); } catch {}
    const { a: shopIdStr, b: skuStr, c: pageStr } = parseData(ctx.match.input);
    const shopId = asInt(shopIdStr);
    const sku    = asInt(skuStr);
    const page   = Math.max(1, asInt(pageStr, 1));

    try {
      await data.toggleTracked(db, shopId, sku);
    } catch (e) {
      await sendOrEdit(
        ctx,
        'Не удалось изменить статус отслеживания. Попробуйте ещё раз.',
        Markup.inlineKeyboard([backRow(`${CB.SHOP_OPEN}:${shopId}`)])
      );
      return;
    }

    const { items, total } = await data.getShopProductsPage(db, shopId, page, PAGE_SIZE);
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    await sendOrEdit(
      ctx,
      '📦 Товары для отслеживания (остаток > 0):',
      prodsKeyboard(shopId, page, totalPages, items)
    );
  });
};
