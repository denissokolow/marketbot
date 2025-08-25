const { Markup } = require('telegraf');

module.exports = ({ bot, db, shared, data }) => {
  const {
    CB, PAGE_SIZE, asInt, parseData, sendOrEdit, backRow,
    addShopInputState, costInputState
  } = shared;

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
      [Markup.button.callback('💰 Себестоимость товаров', `${CB.COSTS}:${shopId}:1`)],
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

  // ---------- список магазинов ----------
  bot.action(CB.SHOPS, async (ctx) => {
    await ctx.answerCbQuery();
    addShopInputState.delete(ctx.from.id);
    costInputState.delete(ctx.from.id);

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

  // ---------- подменю магазина ----------
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

  // ---------- товары магазина ----------
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

  // переключить отслеживание
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

  // ======================================================
  // ================ ДОБАВИТЬ МАГАЗИН ====================
  // ======================================================
  bot.action(CB.ADD_SHOP, async (ctx) => {
    await ctx.answerCbQuery();
    costInputState.delete(ctx.from.id);
    addShopInputState.set(ctx.from.id, { step: 1 });
    await sendOrEdit(
      ctx,
      '➕ Добавление магазина\n\nВведите название магазина:',
      Markup.inlineKeyboard([backRow(CB.SHOPS)])
    );
  });

  bot.action(CB.ADD_CANCEL, async (ctx) => {
    await ctx.answerCbQuery();
    addShopInputState.delete(ctx.from.id);
    await sendOrEdit(ctx, 'Операция отменена.', Markup.inlineKeyboard([backRow(CB.SHOPS)]));
  });

  // шаги добавления магазина (текстом)
  bot.on('text', async (ctx, next) => {
    const st = addShopInputState.get(ctx.from.id);
    if (!st) return next();

    const text = (ctx.message?.text || '').trim();
    if (!text) return;

    try {
      if (st.step === 1) {
        st.shop_name = text;
        st.step = 2;
        await ctx.reply('Введите client_id:');
        return;
      }

      if (st.step === 2) {
        const exists = await db.query(
          `SELECT 1 FROM shops WHERE client_id=$1
           UNION ALL
           SELECT 1 FROM users WHERE client_id=$1
           LIMIT 1`,
          [text]
        );
        if (exists.rowCount) {
          await ctx.reply('❌ Такой client_id уже используется. Введите другой client_id:');
          return;
        }
        st.client_id = text;
        st.step = 3;
        await ctx.reply('Введите api_key:');
        return;
      }

      if (st.step === 3) {
        if (!text) { await ctx.reply('api_key не должен быть пустым. Введите api_key:'); return; }

        const shopId = await data.addShopWithSync(db, {
          chat_id: ctx.from.id,
          shop_name: st.shop_name,
          client_id: st.client_id,
          api_key: text,
        });

        addShopInputState.delete(ctx.from.id);
        await ctx.reply(`✅ Магазин «${st.shop_name}» добавлен (ID: ${shopId}).`);

        const shops = await data.getShopsByChat(db, ctx.from.id);
        await ctx.reply('Ваши магазины:', shopsKeyboard(shops));
        return;
      }
    } catch (e) {
      addShopInputState.delete(ctx.from.id);
      await ctx.reply(e?.code === 'client_id_exists'
        ? '❌ Такой client_id уже используется.'
        : 'Произошла ошибка при добавлении магазина.');
    }
  });

  // ======================================================
  // ================ УДАЛИТЬ МАГАЗИН =====================
  // ======================================================
  bot.action(CB.DEL_SHOP, async (ctx) => {
    await ctx.answerCbQuery();
    const shops = await data.getShopsByChat(db, ctx.from.id);
    if (!shops.length) {
      await sendOrEdit(ctx, 'У вас нет магазинов.', Markup.inlineKeyboard([backRow(CB.SHOPS)]));
      return;
    }
    const rows = shops.map(s => [
      Markup.button.callback(`🗑 ${s.name || `Магазин #${s.id}`} (${s.client_id})`, `${CB.DEL_CONF}:${s.id}`)
    ]);
    rows.push(backRow(CB.SHOPS));
    await sendOrEdit(ctx, 'Выберите магазин для удаления:', Markup.inlineKeyboard(rows));
  });

  bot.action(new RegExp(`^${CB.DEL_CONF}:(\\d+)$`), async (ctx) => {
    await ctx.answerCbQuery();
    const { a: shopIdStr } = parseData(ctx.match.input);
    const shopId = asInt(shopIdStr);
    const shop = await data.getShopById(db, shopId);
    if (!shop || shop.chat_id !== ctx.from.id) {
      await sendOrEdit(ctx, 'Магазин не найден или не принадлежит вам.', Markup.inlineKeyboard([backRow(CB.DEL_SHOP)]));
      return;
    }
    const name = shop.name || `Магазин #${shop.id}`;
    await sendOrEdit(
      ctx,
      `Удалить магазин «${name}»?\nБудут удалены все его товары и отслеживание.`,
      Markup.inlineKeyboard([
        [Markup.button.callback('✅ Удалить', `${CB.DEL_DO}:${shop.id}`)],
        backRow(CB.DEL_SHOP),
      ])
    );
  });

  bot.action(new RegExp(`^${CB.DEL_DO}:(\\d+)$`), async (ctx) => {
    await ctx.answerCbQuery();
    const { a: shopIdStr } = parseData(ctx.match.input);
    const shopId = asInt(shopIdStr);

    try {
      await data.deleteShopDeep(db, ctx.from.id, shopId);
      await sendOrEdit(ctx, '🗑 Магазин удалён.', Markup.inlineKeyboard([backRow(CB.SHOPS)]));
    } catch (e) {
      await sendOrEdit(
        ctx,
        e?.message === 'shop_not_found' ? 'Магазин не найден или не принадлежит вам.' : 'Ошибка при удалении магазина.',
        Markup.inlineKeyboard([backRow(CB.SHOPS)])
      );
    }
  });
};
