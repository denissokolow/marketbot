// src/commands/settings.js
const { Markup } = require('telegraf');
const { syncStocksForUser } = require('../services/ozon/syncStocks');

const esc = (s = '') => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const replyCode = (ctx, text, extra = {}) =>
  ctx.reply(`<code>${esc(String(text))}</code>`, { parse_mode: 'HTML', ...extra });
const editCode = (ctx, text, extra = {}) =>
  ctx.editMessageText(`<code>${esc(String(text))}</code>`, { parse_mode: 'HTML', ...extra });
async function sendOrEdit(ctx, text, keyboard) {
  try { await editCode(ctx, text, { reply_markup: keyboard?.reply_markup }); }
  catch { await replyCode(ctx, text, keyboard); }
}
const fmtDate = (d) => {
  try { const dt = new Date(d); const dd=String(dt.getDate()).padStart(2,'0');
        const mm=String(dt.getMonth()+1).padStart(2,'0');
        const yy=String(dt.getFullYear()); return `${dd}.${mm}.${yy}`; } catch { return null; }
};
const fmtRUB0 = (n) => Math.round(Number(n)||0).toLocaleString('ru-RU');

const CB = {
  MAIN:       'settings:main',
  PROFILE:    'settings:profile',
  SHOP:       'settings:shop',
  COSTS:      'settings:costs',      // settings:costs:<page>
  COST_SET:   'settings:cost:set',   // settings:cost:set:<sku>:<page>
};
const PAGE_SIZE = 10;

const costInputState = new Map(); // { shopId, sku, page }

async function getUserByChat(pool, chatId) {
  const r = await pool.query('SELECT * FROM users WHERE chat_id=$1 LIMIT 1', [chatId]);
  return r.rows[0] || null;
}
async function getUsersShop(pool, chatId) {
  const r = await pool.query(
    `SELECT s.id, s.name
       FROM shops s
       JOIN users u ON u.id = s.user_id
      WHERE u.chat_id = $1
      ORDER BY s.created_at DESC, s.id DESC
      LIMIT 1`,
    [chatId]
  );
  return r.rows[0] || null;
}
async function getProductsPage(pool, shopId, page = 1, pageSize = 10) {
  const offset = Math.max(0, (page - 1) * pageSize);
  const totalRes = await pool.query(
    `SELECT COUNT(*)::int AS cnt
       FROM shop_products
      WHERE shop_id=$1 AND quantity > 0`,
    [shopId]
  );
  const rowsRes = await pool.query(
    `SELECT
        (sku)::bigint             AS sku,
        COALESCE(title,'')        AS title,
        quantity::int             AS quantity,
        COALESCE(net,0)::numeric  AS net
       FROM shop_products
      WHERE shop_id=$1 AND quantity > 0
      ORDER BY sku
      LIMIT $2 OFFSET $3`,
    [shopId, pageSize, offset]
  );
  return { items: rowsRes.rows, total: totalRes.rows[0].cnt };
}
async function setNet(pool, shopId, sku, net) {
  await pool.query(
    `UPDATE shop_products SET net = $3
      WHERE shop_id=$1 AND sku::text = $2::text`,
    [shopId, String(sku), Number(net) || 0]
  );
}

const rootText = () => '⚙️ Настройки';
function profileText({ firstName, lastName, shopName, isSubscribed, untilText }) {
  const name = [firstName||'', lastName||''].filter(Boolean).join(' ').trim() || '—';
  const shop = shopName || '—';
  const sub  = (isSubscribed === false)
    ? 'Подписка: не активна'
    : `Подписка: активна до ${untilText || '—'}`;
  return `👤 Профиль
Имя: ${name}
Магазин: ${shop}
${sub}`;
}
const mainKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('👤 Профиль', CB.PROFILE)],
    [Markup.button.callback('🏬 Магазин', CB.SHOP)],
  ]);
const profileKeyboard = () =>
  Markup.inlineKeyboard([
    [
      Markup.button.url('💳 Тарифы', 'https://telegra.ph/123-09-24-73'),
      Markup.button.url('📘 Инструкция', 'https://telegra.ph/123-09-24-73'),
    ],
    [Markup.button.callback('⬅️ Назад', CB.MAIN)],
  ]);
function shopKeyboard(shopId) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🧾 Себестоимость товаров', `${CB.COSTS}:1`)],
    [Markup.button.callback('⬅️ Назад', CB.MAIN)],
  ]);
}
function costsKeyboard(shopId, page, totalPages, items) {
  const rows = [];
  for (const it of items) {
    const name = (String(it.title).trim().split(/\s+/)[0] || `SKU ${it.sku}`);
    const label = `${name} (${it.sku}) — ${fmtRUB0(it.net)} ₽`;
    rows.push([Markup.button.callback(label, `${CB.COST_SET}:${it.sku}:${page}`)]);
  }
  const nav = [];
  if (page > 1) nav.push(Markup.button.callback('⬅️', `${CB.COSTS}:${page-1}`));
  nav.push(Markup.button.callback(`стр. ${page}/${totalPages}`, 'noop'));
  if (page < totalPages) nav.push(Markup.button.callback('➡️', `${CB.COSTS}:${page+1}`));
  if (nav.length) rows.push(nav);
  rows.push([Markup.button.callback('◀️ Назад', CB.SHOP)]);
  return Markup.inlineKeyboard(rows);
}

function settings(bot, { pool, logger }) {
  const L = {
    info:  (logger?.info  || console.log).bind(logger || console),
    warn:  (logger?.warn  || console.warn).bind(logger || console),
    error: (logger?.error || console.error).bind(logger || console),
  };

  bot.command('settings', async (ctx) => {
    try { await sendOrEdit(ctx, rootText(), mainKeyboard()); }
    catch (e) { L.error(e, '/settings error'); }
  });

  bot.action(CB.MAIN, async (ctx) => { try { await ctx.answerCbQuery(); } catch {} ; await sendOrEdit(ctx, rootText(), mainKeyboard()); });

  bot.action(CB.PROFILE, async (ctx) => {
    try { await ctx.answerCbQuery(); } catch {}
    try {
      const user = await getUserByChat(pool, ctx.from.id);
      const shop = await getUsersShop(pool, ctx.from.id);
      const untilText = user?.subscription_until ? fmtDate(user.subscription_until) : null;
      const text = profileText({
        firstName: user?.first_name || ctx.from.first_name || '',
        lastName:  user?.last_name  || ctx.from.last_name  || '',
        shopName:  shop?.name || user?.shop_name || '',
        isSubscribed: (typeof user?.is_subscribed === 'boolean' ? user.is_subscribed : true),
        untilText,
      });
      await sendOrEdit(ctx, text, profileKeyboard());
    } catch (e) {
      L.error('settings:profile error', e);
      await replyCode(ctx, 'Произошла ошибка. Попробуйте позже.');
    }
  });

  bot.action(CB.SHOP, async (ctx) => {
    try { await ctx.answerCbQuery(); } catch {}
    const shop = await getUsersShop(pool, ctx.from.id);
    if (!shop) return sendOrEdit(ctx, 'У вас пока нет подключённого магазина.', Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', CB.MAIN)]]));
    await sendOrEdit(ctx, `🏪 Магазин: ${shop.name || '—'}`, shopKeyboard(shop.id));
  });

  // Список товаров с остатком > 0
  bot.action(new RegExp(`^${CB.COSTS}:(\\d+)$`), async (ctx) => {
    try { await ctx.answerCbQuery(); } catch {}
    const page = Math.max(1, Number(ctx.match[1] || 1));
    const shop = await getUsersShop(pool, ctx.from.id);
    if (!shop) {
      return sendOrEdit(
        ctx,
        'Магазин не найден.',
        Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', CB.MAIN)]]),
      );
    }

    // 1) синк остатков
    try {
      const syncRes = await syncStocksForUser(pool, ctx.from.id, logger);
      if (process.env.DEBUG_STOCKS === '1') {
        L.info('[settings] sync result', syncRes);
      }
    } catch (e) {
      L.warn('[settings] syncStocksForUser failed', e?.message || e);
    }

    // 2) выборка из БД
    const { items, total } = await getProductsPage(pool, shop.id, page, PAGE_SIZE);
    if (process.env.DEBUG_STOCKS === '1') {
      L.info('[settings] products page', { page, total, sample: items.slice(0, 5) });
    }

    if (!total) {
      return sendOrEdit(
        ctx,
        'В этом магазине пока нет товаров с положительным остатком.',
        Markup.inlineKeyboard([[Markup.button.callback('◀️ Назад', CB.SHOP)]]),
      );
    }

    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    await sendOrEdit(ctx, '💵 Себестоимость товаров (остаток > 0):', costsKeyboard(shop.id, page, totalPages, items));
  });

  // Выбор позиции
  bot.action(new RegExp(`^${CB.COST_SET}:(\\d+):(\\d+)$`), async (ctx) => {
    try { await ctx.answerCbQuery(); } catch {}
    const sku  = Number(ctx.match[1]);
    const page = Math.max(1, Number(ctx.match[2] || 1));
    const shop = await getUsersShop(pool, ctx.from.id);
    if (!shop) return sendOrEdit(ctx, 'Магазин не найден.', Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', CB.MAIN)]]));
    costInputState.set(ctx.from.id, { shopId: shop.id, sku, page });
    await sendOrEdit(
      ctx,
      `Введите себестоимость для SKU ${sku} (число, можно с запятой).`,
      Markup.inlineKeyboard([[Markup.button.callback('◀️ Назад', `${CB.COSTS}:${page}`)]]),
    );
  });

  // Ввод net
  bot.on('text', async (ctx, next) => {
    const st = costInputState.get(ctx.from.id);
    if (!st) return next();

    const raw = (ctx.message?.text || '').trim().replace(',', '.').replace(/\s+/g, '');
    const net = Number(raw);
    if (!Number.isFinite(net) || net < 0 || net > 1_000_000_000) {
      await replyCode(ctx, 'Введите корректную себестоимость (например, 123.45).');
      return;
    }

    try {
      await setNet(pool, st.shopId, st.sku, net);
      await replyCode(ctx, `✔️ Себестоимость для SKU ${st.sku} установлена: ${fmtRUB0(net)} ₽`);
    } catch (e) {
      await replyCode(ctx, 'Ошибка при сохранении. Попробуйте ещё раз.');
    } finally {
      costInputState.delete(ctx.from.id);
    }

    const { items, total } = await getProductsPage(pool, st.shopId, st.page, PAGE_SIZE);
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    await sendOrEdit(ctx, '💵 Себестоимость товаров (остаток > 0):', costsKeyboard(st.shopId, st.page, totalPages, items));
  });
}

module.exports.register = settings;
