const { Markup } = require('telegraf');

module.exports = ({ bot, db, shared, data }) => {
  const {
    CB, PAGE_SIZE, asInt, parseData, sendOrEdit, backRow,
    addShopInputState, costInputState
  } = shared;

  // helpers для отображения
  const firstWord = (s) => {
    const t = String(s || '').trim();
    return t ? t.split(/\s+/)[0] : '';
  };
  const fmtRUB0 = (n) => `${Math.round(Number(n) || 0).toLocaleString('ru-RU')}₽`;

  // ----- подменю конкретного магазина -----
  function shopSubmenuKeyboard(shopId) {
    return Markup.inlineKeyboard([
      [Markup.button.callback('📦 Товары для отслеживания', `${CB.PRODS}:${shopId}:1`)],
      [Markup.button.callback('💰 Себестоимость товаров', `${CB.COSTS}:${shopId}:1`)],
      [Markup.button.callback('🗑 Удалить магазин', `${CB.DEL_CONF}:${shopId}`)],
      backRow(CB.MAIN),
    ]);
  }

  function productsKeyboard(shopId, page, totalPages, items) {
    const rows = [];
    for (const it of items) {
      const name = firstWord(it.title) || `SKU ${it.sku}`;
      const label = `${it.tracked ? '✅' : '❌'} ${name} (${it.sku})`;
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

  function costsKeyboard(shopId, page, totalPages, items) {
    const rows = items.map(it => {
      const name = firstWord(it.title) || `SKU ${it.sku}`;
      const price = fmtRUB0(it.net);
      const label = `${name} (${it.sku}): ${price}`;
      return [Markup.button.callback(label, `${CB.COSTS_SET}:${shopId}:${it.sku}:${page}`)];
    });
    const nav = [];
    if (page > 1) nav.push(Markup.button.callback('⬅️', `${CB.COSTS}:${shopId}:${page - 1}`));
    nav.push(Markup.button.callback(`стр. ${page}/${totalPages}`, 'noop'));
    if (page < totalPages) nav.push(Markup.button.callback('➡️', `${CB.COSTS}:${shopId}:${page + 1}`));
    if (nav.length) rows.push(nav);
    rows.push(backRow(`${CB.SHOP_OPEN}:${shopId}`));
    return Markup.inlineKeyboard(rows);
  }

  // ---------- открыть пункт «Магазин» (ед. число) ----------
  async function openSingleShopMenu(ctx) {
    const chatId = ctx.from.id;
    const shops = await data.getShopsByChat(db, chatId);

    if (!shops.length) {
      await sendOrEdit(
        ctx,
        '🏬 У вас пока нет магазина.',
        Markup.inlineKeyboard([
          [Markup.button.callback('➕ Добавить магазин', CB.ADD_SHOP)],
          backRow(CB.MAIN),
        ])
      );
      return;
    }

    const shop = shops[0]; // разрешён один магазин
    const title = shop.name || `Магазин #${shop.id}`;
    await sendOrEdit(ctx, `Магазин: ${title}`, shopSubmenuKeyboard(shop.id));
  }

  // безопасно регистрируем триггеры для открытия магазина
  const SHOP_TRIGGERS = [CB.SHOPS, CB.SHOP].filter(
    t => typeof t === 'string' && t.length > 0
  );
  if (SHOP_TRIGGERS.length) {
    bot.action(SHOP_TRIGGERS, async (ctx) => {
      await ctx.answerCbQuery();
      return openSingleShopMenu(ctx);
    });
  }

  // ---------- возврат в подменю магазина ----------
  bot.action(new RegExp(`^${CB.SHOP_OPEN}:(\\d+)$`), async (ctx) => {
    await ctx.answerCbQuery();
    const { a: shopIdStr } = parseData(ctx.match.input);
    const shopId = asInt(shopIdStr);
    const shop = await data.getShopById(db, shopId);
    if (!shop) {
      await sendOrEdit(ctx, 'Магазин не найден.', Markup.inlineKeyboard([backRow(CB.MAIN)]));
      return;
    }
    const name = shop.name || `Магазин #${shop.id}`;
    await sendOrEdit(ctx, `Магазин: ${name}`, shopSubmenuKeyboard(shop.id));
  });

  // ---------- товары ----------
  bot.action(new RegExp(`^${CB.PRODS}:(\\d+):(\\d+)$`), async (ctx) => {
    await ctx.answerCbQuery();
    const { a: shopIdStr, b: pageStr } = parseData(ctx.match.input);
    const shopId = asInt(shopIdStr);
    const page = Math.max(1, asInt(pageStr, 1));

    try {
      await data.refreshShopProductsFromOzon(db, shopId);
    } catch (e) {
      console.error('[settings/shops] refreshShopProductsFromOzon error:', e?.response?.data || e);
    }

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

  // ---------- себестоимость ----------
  bot.action(new RegExp(`^${CB.COSTS}:(\\d+):(\\d+)$`), async (ctx) => {
    await ctx.answerCbQuery();
    const { a: shopIdStr, b: pageStr } = parseData(ctx.match.input);
    const shopId = asInt(shopIdStr);
    const page = Math.max(1, asInt(pageStr, 1));

    const { items, total } = await data.getActiveTrackedPage(db, shopId, page, PAGE_SIZE);
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

    if (!items.length) {
      return sendOrEdit(
        ctx,
        'Пока нет активных отслеживаемых товаров в этом магазине.\nОткройте «📦 Товары…» и включите нужные позиции.',
        Markup.inlineKeyboard([backRow(`${CB.SHOP_OPEN}:${shopId}`)])
      );
    }

    const shop = await data.getShopById(db, shopId);
    const title = shop?.name || `Магазин #${shopId}`;
    await sendOrEdit(ctx, `💰 Себестоимость — ${title}`, costsKeyboard(shopId, page, totalPages, items));
  });

  bot.action(new RegExp(`^${CB.COSTS_SET}:(\\d+):(\\d+):(\\d+)$`), async (ctx) => {
    await ctx.answerCbQuery();
    const { a: shopIdStr, b: skuStr, c: pageStr } = parseData(ctx.match.input);
    const shopId = asInt(shopIdStr);
    const sku = asInt(skuStr);
    const page = Math.max(1, asInt(pageStr, 1));

    costInputState.set(ctx.from.id, { shopId, sku, page });
    await sendOrEdit(
      ctx,
      `Введите себестоимость для SKU ${sku} (число, можно с запятой).`,
      Markup.inlineKeyboard([backRow(`${CB.COSTS}:${shopId}:${page}`)])
    );
  });

  // ======================================================
  // ================ ДОБАВИТЬ МАГАЗИН ====================
  // ======================================================
  bot.action(CB.ADD_SHOP, async (ctx) => {
    await ctx.answerCbQuery();
    costInputState.delete(ctx.from.id);

    const shops = await data.getShopsByChat(db, ctx.from.id);
    if (shops.length > 0) {
      // уже есть магазин — открываем его подменю
      const shop = shops[0];
      const title = shop.name || `Магазин #${shop.id}`;
      await sendOrEdit(ctx, `Магазин: ${title}`, shopSubmenuKeyboard(shop.id));
      return;
    }

    addShopInputState.set(ctx.from.id, { step: 1 });
    await sendOrEdit(
      ctx,
      '➕ Добавление магазина\n\nВведите название магазина:',
      Markup.inlineKeyboard([backRow(CB.MAIN)])
    );
  });

  bot.action(CB.ADD_CANCEL, async (ctx) => {
    await ctx.answerCbQuery();
    addShopInputState.delete(ctx.from.id);
    await sendOrEdit(ctx, 'Операция отменена.', Markup.inlineKeyboard([backRow(CB.MAIN)]));
  });

  // ---------- вводы (себестоимость и добавление магазина) ----------
  bot.on('text', async (ctx, next) => {
    // ввод себестоимости
    const costSt = costInputState.get(ctx.from.id);
    if (costSt) {
      const raw = (ctx.message?.text || '').trim();
      if (!raw) return;

      if (raw === '/cancel' || /^отмена$/i.test(raw)) {
        costInputState.delete(ctx.from.id);
        await ctx.reply('Отмена ввода себестоимости.');
        return;
      }

      const normalized = raw.replace(',', '.');
      const net = Number(normalized);
      if (!Number.isFinite(net) || net < 0) {
        await ctx.reply('Введите корректное число (например, 123.45).');
        return;
      }

      await data.setNetForTracked(db, costSt.shopId, costSt.sku, net);
      costInputState.delete(ctx.from.id);

      const page = costSt.page || 1;
      const { items, total } = await data.getActiveTrackedPage(db, costSt.shopId, page, PAGE_SIZE);
      const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
      const shop = await data.getShopById(db, costSt.shopId);
      const title = shop?.name || `Магазин #${costSt.shopId}`;
      await ctx.reply(`💾 Себестоимость сохранена.`);
      await sendOrEdit(ctx, `💰 Себестоимость — ${title}`, costsKeyboard(costSt.shopId, page, totalPages, items));
      return;
    }

    // добавление магазина
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

        const shop = await data.getShopById(db, shopId);
        const title = shop?.name || `Магазин #${shopId}`;
        await ctx.reply(`✅ Магазин «${st.shop_name}» добавлен (ID: ${shopId}).`);
        await sendOrEdit(ctx, `Магазин: ${title}`, shopSubmenuKeyboard(shopId));
        return;
      }
    } catch (e) {
      addShopInputState.delete(ctx.from.id);
      await ctx.reply(
        e?.code === 'only_one_shop_per_chat'
          ? '❌ Можно добавить только один магазин.'
          : e?.code === 'client_id_exists'
            ? '❌ Такой client_id уже используется.'
            : 'Произошла ошибка при добавлении магазина.'
      );
    }
  });

  // ======================================================
  // ================ УДАЛЕНИЕ МАГАЗИНА ===================
  // ======================================================
  bot.action(new RegExp(`^${CB.DEL_CONF}:(\\d+)$`), async (ctx) => {
    await ctx.answerCbQuery();
    const { a: shopIdStr } = parseData(ctx.match.input);
    const shopId = asInt(shopIdStr);
    const shop = await data.getShopById(db, shopId);
    if (!shop || shop.chat_id !== ctx.from.id) {
      await sendOrEdit(ctx, 'Магазин не найден или не принадлежит вам.', Markup.inlineKeyboard([backRow(CB.MAIN)]));
      return;
    }
    const name = shop.name || `Магазин #${shop.id}`;
    await sendOrEdit(
      ctx,
      `Удалить магазин «${name}»?\nБудут удалены все его товары и отслеживание.`,
      Markup.inlineKeyboard([
        [Markup.button.callback('✅ Удалить', `${CB.DEL_DO}:${shop.id}`)],
        backRow(`${CB.SHOP_OPEN}:${shop.id}`),
      ])
    );
  });

  bot.action(new RegExp(`^${CB.DEL_DO}:(\\d+)$`), async (ctx) => {
    await ctx.answerCbQuery();
    const { a: shopIdStr } = parseData(ctx.match.input);
    const shopId = asInt(shopIdStr);

    try {
      await data.deleteShopDeep(db, ctx.from.id, shopId);
      await sendOrEdit(ctx, '🗑 Магазин удалён.', Markup.inlineKeyboard([backRow(CB.MAIN)]));
    } catch (e) {
      await sendOrEdit(
        ctx,
        e?.message === 'shop_not_found' ? 'Магазин не найден или не принадлежит вам.' : 'Ошибка при удалении магазина.',
        Markup.inlineKeyboard([backRow(CB.MAIN)])
      );
    }
  });
};
