const { Markup } = require('telegraf');

module.exports = ({ bot, db, shared, data }) => {
  const { CB, PAGE_SIZE, asInt, parseData, sendOrEdit, backRow, costInputState } = shared;

  function costsKeyboard(shopId, page, totalPages, items) {
    const rows = [];
    for (const it of items) {
      const title = `${it.sku} — ${it.title}`;
      const short = title.length > 48 ? (title.slice(0, 47) + '…') : title;
      const right = it.net ? ` (net: ${it.net}₽)` : ' (net: 0₽)';
      rows.push([
        Markup.button.callback(
          short + right,
          `${CB.COST_SET}:${shopId}:${it.sku}:${page}`
        ),
      ]);
    }
    const nav = [];
    if (page > 1) nav.push(Markup.button.callback('⬅️', `${CB.COSTS}:${shopId}:${page - 1}`));
    nav.push(Markup.button.callback(`стр. ${page}/${totalPages}`, 'noop'));
    if (page < totalPages) nav.push(Markup.button.callback('➡️', `${CB.COSTS}:${shopId}:${page + 1}`));
    if (nav.length) rows.push(nav);
    // назад — в подменю магазина
    rows.push(backRow(`${CB.SHOP_OPEN}:${shopId}`));
    return Markup.inlineKeyboard(rows);
  }

  // СПИСОК tracked-позиций КОНКРЕТНОГО магазина
  bot.action(new RegExp(`^${CB.COSTS}:(\\d+):(\\d+)$`), async (ctx) => {
    await ctx.answerCbQuery();
    costInputState.delete(ctx.from.id);

    const { a: shopIdStr, b: pageStr } = parseData(ctx.match.input);
    const shopId = asInt(shopIdStr);
    const page   = Math.max(1, asInt(pageStr, 1));

    const { items, total } = await data.getActiveTrackedPage(db, ctx.from.id, shopId, page, PAGE_SIZE);

    if (!total) {
      await sendOrEdit(
        ctx,
        'Пока нет активных отслеживаемых товаров в этом магазине.\n' +
          'Откройте «📦 Товары…» и включите нужные позиции.',
        Markup.inlineKeyboard([backRow(`${CB.SHOP_OPEN}:${shopId}`)])
      );
      return;
    }

    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    await sendOrEdit(
      ctx,
      '💵 Себестоимость (активные позиции магазина):',
      costsKeyboard(shopId, page, totalPages, items)
    );
  });

  // ВЫБОР позиции для ввода net
  bot.action(new RegExp(`^${CB.COST_SET}:(\\d+):(\\d+):(\\d+)$`), async (ctx) => {
    await ctx.answerCbQuery();
    const { a: shopIdStr, b: skuStr, c: pageStr } = parseData(ctx.match.input);
    const shopId = asInt(shopIdStr);
    const sku    = asInt(skuStr);
    const page   = Math.max(1, asInt(pageStr, 1));

    costInputState.set(ctx.from.id, { shopId, sku, backData: { page } });

    await sendOrEdit(
      ctx,
      `Введите себестоимость для SKU ${sku} (целое число 1…1 000 000):`,
      Markup.inlineKeyboard([backRow(`${CB.COSTS}:${shopId}:${page}`)])
    );
  });

  // ТЕКСТОВЫЙ ввод net
  bot.on('text', async (ctx, next) => {
    const state = costInputState.get(ctx.from.id);
    if (!state) return next();

    const raw = (ctx.message?.text || '').trim();
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 1 || n > 1_000_000) {
      await ctx.reply('Введите корректную себестоимость (целое число от 1 до 1 000 000).');
      return;
    }

    try {
      await data.setNetForTracked(db, ctx.from.id, state.shopId, state.sku, n);
      await ctx.reply(`✔️ Себестоимость для SKU ${state.sku} установлена: ${n}₽`);
    } catch (e) {
      if (String(e.message) === 'shop_not_found') {
        await ctx.reply('Магазин не найден или не принадлежит вам.');
      } else {
        await ctx.reply('Ошибка при сохранении. Попробуйте ещё раз.');
      }
    } finally {
      costInputState.delete(ctx.from.id);
    }

    // перерисуем текущую страницу
    const page = state.backData?.page || 1;
    const { items, total } = await data.getActiveTrackedPage(db, ctx.from.id, state.shopId, page, PAGE_SIZE);
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    await ctx.reply(
      '💵 Себестоимость (активные позиции магазина):',
      costsKeyboard(state.shopId, page, totalPages, items)
    );
  });
};
