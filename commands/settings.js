// commands/settings.js
const { Markup } = require('telegraf');

// ---- callback keys (до 64 байт)
const CB = {
  MAIN:        'set_main',
  PROFILE:     'set_prof',

  SHOPS:       'set_shops',
  SHOP_OPEN:   'set_shop',      // set_shop:<shopId>

  PRODS:       'set_prods',     // set_prods:<shopId>:<page>
  TOGGLE:      'set_tgl',       // set_tgl:<shopId>:<sku>:<page>

  ADD_SHOP:    'set_add_shop',
  DEL_SHOP:    'set_del_shop',

  PRODUCTS_TAB:'set_tab_prods', // заглушка

  // новое: себестоимость
  COSTS:       'set_costs',     // set_costs[:<page>]
  COST_SET:    'cst_set',       // cst_set|<shopId>|<sku>|<page>
};

const PAGE_SIZE = 10;

// ---- локальное состояние ввода себестоимости
// key = chat_id -> { shop_id, sku, page }
const costInputState = Object.create(null);

// ---- helpers
const asInt = (v, d = 0) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};

function parseData(data) {
  const [cmd, a, b, c] = String(data).split(/[:|]/); // поддержим и ":" и "|"
  return { cmd, a, b, c };
}

async function sendOrEdit(ctx, text, keyboard) {
  try {
    if (ctx.updateType === 'callback_query') {
      await ctx.editMessageText(text, { reply_markup: keyboard?.reply_markup, parse_mode: undefined });
    } else {
      await ctx.reply(text, keyboard);
    }
  } catch {
    await ctx.reply(text, keyboard);
  }
}

// ---- SQL helpers
async function getUserByChat(db, chatId) {
  const r = await db.query('SELECT * FROM users WHERE chat_id = $1 LIMIT 1', [chatId]);
  return r?.rows?.[0] || null;
}

async function getShopsByChat(db, chatId) {
  const r = await db.query(
    'SELECT * FROM shops WHERE chat_id = $1 ORDER BY created_at DESC, id DESC',
    [chatId]
  );
  return r?.rows || [];
}

async function getShopById(db, shopId) {
  const r = await db.query('SELECT * FROM shops WHERE id = $1 LIMIT 1', [shopId]);
  return r?.rows?.[0] || null;
}

/**
 * Возвращает страницу товаров магазина с текущими отметками отслеживания.
 * Если явных tracked записей по магазину нет — tracked = quantity>0.
 */
async function getShopProductsPage(db, shopId, page = 1, pageSize = PAGE_SIZE) {
  const offset = (page - 1) * pageSize;

  const hc = await db.query(
    'SELECT COUNT(*)::int AS cnt FROM tracked_products WHERE shop_id = $1',
    [shopId]
  );
  const hasCustom = (hc.rows?.[0]?.cnt || 0) > 0;

  const totalRes = await db.query(
    'SELECT COUNT(*)::int AS c FROM shop_products WHERE shop_id = $1',
    [shopId]
  );
  const total = totalRes.rows?.[0]?.c || 0;

  const r = await db.query(
    `
      SELECT p.sku, p.title, p.quantity,
             COALESCE(tp.is_active, false) AS user_tracked
      FROM shop_products p
      LEFT JOIN tracked_products tp
        ON tp.shop_id = p.shop_id AND tp.sku = p.sku
      WHERE p.shop_id = $1
      ORDER BY p.title NULLS LAST, p.sku
      LIMIT $2 OFFSET $3
    `,
    [shopId, pageSize, offset]
  );

  const items = (r.rows || []).map(it => {
    const effective =
      hasCustom ? Boolean(it.user_tracked) : (Number(it.quantity) || 0) > 0;
    return {
      sku: it.sku,
      title: it.title || `SKU ${it.sku}`,
      quantity: Number(it.quantity) || 0,
      tracked: effective,
    };
  });

  return { items, total, hasCustom };
}

// вкл/выкл отслеживание (idempotent)
async function toggleTracked(db, shopId, sku) {
  await db.query(
    `
      INSERT INTO tracked_products (shop_id, sku, is_active, created_at, net)
      VALUES ($1, $2, true, NOW(), COALESCE(
        (SELECT net FROM tracked_products WHERE shop_id=$1 AND sku=$2 LIMIT 1), 0
      ))
      ON CONFLICT (shop_id, sku)
      DO UPDATE SET is_active = NOT tracked_products.is_active
    `,
    [shopId, sku]
  );
}

/** Список активных отслеживаемых товаров пользователя, с пагинацией */
async function getActiveTrackedPage(db, chatId, page = 1, pageSize = PAGE_SIZE) {
  const offset = (page - 1) * pageSize;

  const cnt = await db.query(
    `
      SELECT COUNT(*)::int AS c
      FROM tracked_products tp
      JOIN shops s ON s.id = tp.shop_id
      WHERE s.chat_id = $1 AND tp.is_active = TRUE
    `,
    [chatId]
  );
  const total = cnt.rows?.[0]?.c || 0;

  const r = await db.query(
    `
      SELECT
        tp.shop_id,
        tp.sku,
        COALESCE(sp.title,'') AS title,
        COALESCE(tp.net,0)    AS net,
        s.name                AS shop_name
      FROM tracked_products tp
      JOIN shops s
        ON s.id = tp.shop_id
       AND s.chat_id = $1
      LEFT JOIN shop_products sp
        ON sp.shop_id = tp.shop_id
       AND sp.sku     = tp.sku
      WHERE tp.is_active = TRUE
      ORDER BY s.name, tp.sku
      LIMIT $2 OFFSET $3
    `,
    [chatId, pageSize, offset]
  );

  return { items: r.rows || [], total };
}

// ---- UI builders
function mainKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('👤 Профиль', CB.PROFILE)],
    [Markup.button.callback('🏬 Магазины', CB.SHOPS)],
    // оставляем старую заглушку «Товары», чтобы не ломать прежние экраны
    [Markup.button.callback('📦 Товары', CB.PRODUCTS_TAB)],
    // новый пункт
    [Markup.button.callback('💳 Себестоимость товаров', `${CB.COSTS}:1`)],
  ]);
}

function backRow(cb = CB.MAIN) {
  return [Markup.button.callback('◀️ Назад', cb)];
}

function shopsKeyboard(shops) {
  const rows = shops.map(s =>
    [Markup.button.callback(`🏪 ${s.name || `Магазин #${s.id}`}`, `${CB.SHOP_OPEN}:${s.id}`)]
  );
  rows.push([
    Markup.button.callback('➕ Добавить магазин', CB.ADD_SHOP),
    Markup.button.callback('🗑 Удалить магазин', CB.DEL_SHOP),
  ]);
  rows.push(...[backRow(CB.MAIN)]);
  return Markup.inlineKeyboard(rows);
}

function shopSubmenuKeyboard(shopId) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📦 Товары (выбрать для отслеживания)', `${CB.PRODS}:${shopId}:1`)],
    backRow(CB.SHOPS),
  ]);
}

function productsKeyboard(shopId, page, totalPages, items) {
  const rows = [];

  for (const it of items) {
    const title = (it.title || `SKU ${it.sku}`);
    const labelTitle = title.length > 32 ? title.slice(0, 31) + '…' : title;
    const label = `${it.tracked ? '✅' : '❌'} ${labelTitle} (${it.sku})`;
    rows.push([
      Markup.button.callback(label, `${CB.TOGGLE}:${shopId}:${it.sku}:${page}`)
    ]);
  }

  const navRow = [];
  if (page > 1) navRow.push(Markup.button.callback('⬅️', `${CB.PRODS}:${shopId}:${page - 1}`));
  navRow.push(Markup.button.callback(`стр. ${page}/${totalPages}`, 'noop'));
  if (page < totalPages) navRow.push(Markup.button.callback('➡️', `${CB.PRODS}:${shopId}:${page + 1}`));
  if (navRow.length) rows.push(navRow);

  rows.push(backRow(`${CB.SHOP_OPEN}:${shopId}`));
  return Markup.inlineKeyboard(rows);
}

function costsKeyboard(items, page, totalPages) {
  const rows = [];
  for (const row of items) {
    const labelTitle = row.title ? `${row.sku} — ${row.title}` : String(row.sku);
    const netInfo = row.net ? ` (себестоимость: ${row.net})` : '';
    const label = (labelTitle + netInfo).slice(0, 60);
    rows.push([
      Markup.button.callback(label, `${CB.COST_SET}|${row.shop_id}|${row.sku}|${page}`)
    ]);
  }

  // пагинация
  const navRow = [];
  if (page > 1) navRow.push(Markup.button.callback('⬅️', `${CB.COSTS}:${page - 1}`));
  navRow.push(Markup.button.callback(`стр. ${page}/${totalPages}`, 'noop'));
  if (page < totalPages) navRow.push(Markup.button.callback('➡️', `${CB.COSTS}:${page + 1}`));
  if (navRow.length) rows.push(navRow);

  rows.push(backRow(CB.MAIN));
  return Markup.inlineKeyboard(rows);
}

function cancelCostKeyboard(page) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('↩️ Назад', `${CB.COSTS}:${Math.max(1, page || 1)}`)],
  ]);
}

// ---- Команда /settings и обработчики
module.exports = (bot, db) => {
  // /settings
  bot.command('settings', async (ctx) => {
    // выход из режима ввода себестоимости
    delete costInputState[ctx.from.id];
    await sendOrEdit(ctx, '⚙️ Меню', mainKeyboard());
  });

  // Главная
  bot.action(CB.MAIN, async (ctx) => {
    delete costInputState[ctx.from.id];
    await ctx.answerCbQuery();
    await sendOrEdit(ctx, '⚙️ Меню', mainKeyboard());
  });

  // Профиль
  bot.action(CB.PROFILE, async (ctx) => {
    await ctx.answerCbQuery();
    const user = await getUserByChat(db, ctx.from.id);
    const name = [user?.first_name, user?.last_name].filter(Boolean).join(' ') || '—';
    const sub = user?.is_subscribed ? 'активна' : 'выключена';
    const text =
      '👤 Профиль\n' +
      `Имя: ${name}\n` +
      `Статус подписки: ${sub}`;
    await sendOrEdit(ctx, text, Markup.inlineKeyboard([backRow(CB.MAIN)]));
  });

  // Заглушка "Товары"
  bot.action(CB.PRODUCTS_TAB, async (ctx) => {
    await ctx.answerCbQuery();
    await sendOrEdit(
      ctx,
      '📦 Раздел "Товары":\nВыберите магазин в разделе «Магазины» и отметьте товары для отслеживания.',
      Markup.inlineKeyboard([backRow(CB.MAIN)])
    );
  });

  // Список магазинов
  bot.action(CB.SHOPS, async (ctx) => {
    await ctx.answerCbQuery();
    const shops = await getShopsByChat(db, ctx.from.id);
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
    const shop = await getShopById(db, shopId);
    if (!shop) {
      await sendOrEdit(ctx, 'Магазин не найден.', Markup.inlineKeyboard([backRow(CB.SHOPS)]));
      return;
    }
    const name = shop.name || `Магазин #${shop.id}`;
    await sendOrEdit(ctx, `Магазин: ${name}`, shopSubmenuKeyboard(shop.id));
  });

  // Лист товаров (отслеживание)
  bot.action(new RegExp(`^${CB.PRODS}:(\\d+):(\\d+)$`), async (ctx) => {
    await ctx.answerCbQuery();
    const { a: shopIdStr, b: pageStr } = parseData(ctx.match.input);
    const shopId = asInt(shopIdStr);
    const page = Math.max(1, asInt(pageStr, 1));

    const { items, total } = await getShopProductsPage(db, shopId, page, PAGE_SIZE);
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

    const shop = await getShopById(db, shopId);
    const title = shop?.name || `Магазин #${shopId}`;
    const text = `📦 Товары магазина: ${title}\nВыберите, что отслеживать:`;

    await sendOrEdit(ctx, text, productsKeyboard(shopId, page, totalPages, items));
  });

  // Переключить отслеживание SKU
  bot.action(new RegExp(`^${CB.TOGGLE}:(\\d+):(\\d+):(\\d+)$`), async (ctx) => {
    const { a: shopIdStr, b: skuStr, c: pageStr } = parseData(ctx.match.input);
    const shopId = asInt(shopIdStr);
    const sku = asInt(skuStr);
    const page = Math.max(1, asInt(pageStr, 1));

    await toggleTracked(db, shopId, sku);
    await ctx.answerCbQuery('Готово');

    const { items, total } = await getShopProductsPage(db, shopId, page, PAGE_SIZE);
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const shop = await getShopById(db, shopId);
    const title = shop?.name || `Магазин #${shopId}`;
    const text = `📦 Товары магазина: ${title}\nВыберите, что отслеживать:`;
    await sendOrEdit(ctx, text, productsKeyboard(shopId, page, totalPages, items));
  });

  // Заглушки по магазинам
  bot.action(CB.ADD_SHOP, async (ctx) => {
    await ctx.answerCbQuery();
    await sendOrEdit(
      ctx,
      'Добавление магазина — в разработке.\nПока добавляйте магазины тем способом, который уже используете.',
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

  // ---- Новый раздел: "Себестоимость товаров"
  bot.action(new RegExp(`^${CB.COSTS}(?::(\\d+))?$`), async (ctx) => {
    await ctx.answerCbQuery();
    delete costInputState[ctx.from.id];

    const page = Math.max(1, asInt(ctx.match?.[1] || 1, 1));
    const { items, total } = await getActiveTrackedPage(db, ctx.from.id, page, PAGE_SIZE);
    if (!total) {
      return sendOrEdit(
        ctx,
        'Активно отслеживаемых товаров нет.',
        Markup.inlineKeyboard([backRow(CB.MAIN)])
      );
    }
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const head = '💳 Себестоимость товаров\n' +
                 'Нажмите на товар и введите себестоимость (целое 1..1 000 000).';
    await sendOrEdit(ctx, head, costsKeyboard(items, page, totalPages));
  });

  // Нажатие на конкретный товар для ввода стоимости
  bot.action(new RegExp(`^${CB.COST_SET}\\|(\\d+)\\|(\\d+)\\|(\\d+)$`), async (ctx) => {
    await ctx.answerCbQuery();
    const { a: shopIdStr, b: skuStr, c: pageStr } = parseData(ctx.match.input);
    const shop_id = asInt(shopIdStr);
    const sku = asInt(skuStr);
    const page = Math.max(1, asInt(pageStr, 1));

    if (!shop_id || !sku) {
      return sendOrEdit(ctx, 'Некорректные данные товара.', Markup.inlineKeyboard([backRow(`${CB.COSTS}:${page}`)]));
    }

    costInputState[ctx.from.id] = { shop_id, sku, page };

    const r = await db.query(
      `SELECT COALESCE(sp.title,'') AS title
         FROM shop_products sp
        WHERE sp.shop_id = $1 AND sp.sku = $2
        LIMIT 1`,
      [shop_id, sku]
    );
    const title = r.rows[0]?.title || '';

    const prompt =
      `Введите себестоимость:\n` +
      `SKU: ${sku}${title ? `\nНазвание: ${title}` : ''}\n\n` +
      `Только целое число от 1 до 1 000 000.`;
    await sendOrEdit(ctx, prompt, cancelCostKeyboard(page));
  });

  // Ввод текста для себестоимости
  bot.on('text', async (ctx, next) => {
    const st = costInputState[ctx.from.id];
    if (!st) return next(); // не ждём ввода — продолжаем другим хендлерам

    const raw = (ctx.message.text || '').trim();
    const val = Number(raw);
    const isInt = Number.isInteger(val);
    if (!isInt || val < 1 || val > 1_000_000) {
      return ctx.reply('Введите корректную себестоимость (целое число от 1 до 1 000 000).', cancelCostKeyboard(st.page));
    }

    try {
      await db.query(
        `UPDATE tracked_products
            SET net = $1
          WHERE shop_id = $2 AND sku = $3 AND is_active = TRUE`,
        [val, st.shop_id, st.sku]
      );
      delete costInputState[ctx.from.id];
      await ctx.reply(`Себестоимость для SKU ${st.sku} установлена: ${val}`, Markup.inlineKeyboard([
        [Markup.button.callback('⬅️ Вернуться к списку', `${CB.COSTS}:${st.page}`)],
        backRow(CB.MAIN),
      ]));
    } catch (e) {
      console.error('net update error:', e);
      delete costInputState[ctx.from.id];
      await ctx.reply('Не удалось сохранить себестоимость. Попробуйте позже.', Markup.inlineKeyboard([backRow(CB.MAIN)]));
    }
  });

  // защита от нажатия на «стр. X/Y»
  bot.action('noop', async (ctx) => ctx.answerCbQuery());
};

