const { Markup } = require('telegraf');

module.exports = ({ bot, db, shared, data }) => {
  const { CB, PAGE_SIZE, asInt, parseData, sendOrEdit, backRow, costInputState } = shared;

  function costsKeyboard(page, totalPages, items) {
    const rows = [];
    for (const it of items) {
      const title = `${it.sku} — ${it.title}`;
      const short = title.length > 48 ? (title.slice(0, 47) + '…') : title;
      const right = it.net ? ` (net: ${it.net}₽)` : ' (net: 0₽)';
      rows.push([Markup.button.callback(short + right, `${CB.COST_SET}:${it.shop_id}:${it.sku}:${page}`)]);
    }
    const nav = [];
    if (page > 1) nav.push(Markup.button.callback('⬅️', `${CB.COSTS}:${page - 1}`));
    nav.push(Markup.button.callback(`стр. ${page}/${totalPages}`, 'noop'));
    if (page < totalPages) nav.push(Markup.button.callback('➡️', `${CB.COSTS}:${page + 1}`));
    if (nav.length) rows.push(nav);
    rows.push(backRow(CB.MAIN));
    return Markup.inlineKeyboard(rows);
  }

  // Список активных tracked-позиций
  bot.action(new RegExp(`^${CB.COSTS}:(\\d+)$`), async (ctx) => {
    await ctx.answerCbQuery();
    costInputState.delete(ctx.from.id);

    const { a: pageStr } = parseData(ctx.match.input);
    const page = Math.max(1, asInt(pageStr, 1));

    const { items, total } = await data.getActiveTrackedPage(db, ctx.from.id, page, PAGE_SIZE);
    if (!total) {
      await sendOrEdit(
        ctx,
        'Пока нет активных отслеживаемых товаров.\nОткройте «🏬 Магазины → 📦 Товары…» и включите нужные позиции.',
        Markup.inlineKeyboard([backRow(CB.MAIN)])
      );
      return;
    }
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    await sendOrEdit(ctx, '💵 Себестоимость (активные позиции):', costsKeyboard(page, totalPages, items));
  });

  // Выбор позиции для ввода net
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
      Markup.inlineKeyboard([backRow(`${CB.COSTS}:${page}`)])
    );
  });

  // Текстовый ввод net
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

    const page = state.backData?.page || 1;
    const { items, total } = await data.getActiveTrackedPage(db, ctx.from.id, page, PAGE_SIZE);
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    await ctx.reply('💵 Себестоимость (активные позиции):', costsKeyboard(page, totalPages, items));
  });
};

