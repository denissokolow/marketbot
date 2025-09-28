// commands/settings/costs.js
const { Markup } = require('telegraf');

module.exports = ({ bot, db, shared, data }) => {
  const { CB, PAGE_SIZE, asInt, parseData, backRow } = shared;

  // helpers
  const esc = (s = '') => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const replyCode = (ctx, text, extra = {}) =>
    ctx.reply(`<code>${esc(String(text))}</code>`, { parse_mode: 'HTML', ...extra });
  const editCode = (ctx, text, extra = {}) =>
    ctx.editMessageText(`<code>${esc(String(text))}</code>`, { parse_mode: 'HTML', ...extra });
  const sendOrEditCode = async (ctx, text, keyboard) => {
    try { await editCode(ctx, text, { reply_markup: keyboard?.reply_markup }); }
    catch { await replyCode(ctx, text, keyboard); }
  };
  const fmtMoney0  = (n) => Math.round(Number(n) || 0).toLocaleString('ru-RU');
  const firstWord  = (s = '') => (String(s).trim().split(/\s+/)[0] || '');

  function costsKeyboard(shopId, page, totalPages, items) {
    const rows = [];
    for (const it of items) {
      const name    = firstWord(it.title || '') || '—';
      const btnText = `${name} (${it.sku}) - ${fmtMoney0(it.net || 0)} руб.`;
      rows.push([
        Markup.button.callback(
          btnText,
          `${CB.COST_SET}:${shopId}:${it.sku}:${page}`
        ),
      ]);
    }
    const nav = [];
    if (page > 1) nav.push(Markup.button.callback('⬅️', `${CB.COSTS}:${shopId}:${page - 1}`));
    nav.push(Markup.button.callback(`стр. ${page}/${totalPages}`, 'noop'));
    if (page < totalPages) nav.push(Markup.button.callback('➡️', `${CB.COSTS}:${shopId}:${page + 1}`));
    if (nav.length) rows.push(nav);
    rows.push(backRow(`${CB.SHOP_OPEN}:${shopId}`)); // назад в меню магазина
    return Markup.inlineKeyboard(rows);
  }

  // СПИСОК tracked-позиций КОНКРЕТНОГО магазина
  bot.action(new RegExp(`^${CB.COSTS}:(\\d+):(\\d+)$`), async (ctx) => {
    await ctx.answerCbQuery();
    shared.costInputState.delete(ctx.from.id);

    const { a: shopIdStr, b: pageStr } = parseData(ctx.match.input);
    const shopId = asInt(shopIdStr);
    const page   = Math.max(1, asInt(pageStr, 1));

    const { items, total } = await data.getActiveTrackedPage(db, shopId, page, PAGE_SIZE);

    if (!total) {
      await sendOrEditCode(
        ctx,
        'Пока нет активных отслеживаемых товаров в этом магазине.\nОткройте «📦 Товары…» и включите нужные позиции.',
        Markup.inlineKeyboard([backRow(`${CB.SHOP_OPEN}:${shopId}`)])
      );
      return;
    }

    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    await sendOrEditCode(
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

    shared.costInputState.set(ctx.from.id, { shopId, sku, backData: { page } });

    await sendOrEditCode(
      ctx,
      `Введите себестоимость для SKU ${sku} (целое число 1…1 000 000):`,
      Markup.inlineKeyboard([backRow(`${CB.COSTS}:${shopId}:${page}`)])
    );
  });

  // ТЕКСТОВЫЙ ввод net
  bot.on('text', async (ctx, next) => {
    const state = shared.costInputState.get(ctx.from.id);
    if (!state) return next();

    const raw = (ctx.message?.text || '').trim().replace(/\s+/g, '');
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 1 || n > 1_000_000) {
      await replyCode(ctx, 'Введите корректную себестоимость (целое число от 1 до 1 000 000).');
      return;
    }

    try {
      await data.setNetForTracked(db, state.shopId, state.sku, n);
      await replyCode(ctx, `✔️ Себестоимость для SKU ${state.sку} установлена: ${fmtMoney0(n)} руб.`);
    } catch (e) {
      if (String(e.message) === 'shop_not_found') {
        await replyCode(ctx, 'Магазин не найден или не принадлежит вам.');
      } else {
        await replyCode(ctx, 'Ошибка при сохранении. Попробуйте ещё раз.');
      }
    } finally {
      shared.costInputState.delete(ctx.from.id);
    }

    // перерисуем текущую страницу
    const page = state.backData?.page || 1;
    const { items, total } = await data.getActiveTrackedPage(db, state.shopId, page, PAGE_SIZE);
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    await replyCode(
      ctx,
      '💵 Себестоимость (активные позиции магазина):',
      costsKeyboard(state.shopId, page, totalPages, items)
    );
  });
};
