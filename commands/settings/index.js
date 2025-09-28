// commands/settings/index.js
const { Markup } = require('telegraf');
const { mainMenu } = require('../../menu/menu.js');

const shared = require('./_shared.js');
const data   = require('./data.js');

const esc = (s = '') => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const replyCode = (ctx, text, extra = {}) =>
  ctx.reply(`<code>${esc(String(text))}</code>`, { parse_mode: 'HTML', ...extra });
const editCode = (ctx, text, extra = {}) =>
  ctx.editMessageText(`<code>${esc(String(text))}</code>`, { parse_mode: 'HTML', ...extra });

function fmtDDMMYYYY(d) {
  try {
    const dt = new Date(d);
    if (Number.isNaN(dt.getTime())) return null;
    const dd = String(dt.getDate()).padStart(2, '0');
    const mm = String(dt.getMonth() + 1).padStart(2, '0');
    const yy = String(dt.getFullYear());
    return `${dd}.${mm}.${yy}`;
  } catch { return null; }
}

function rootText() {
  return '⚙️ Настройки';
}

function profileText({ firstName, lastName, shopName, isSubscribed, untilText }) {
  const name = [firstName || '', lastName || ''].filter(Boolean).join(' ').trim() || '—';
  const shop = shopName || '—';
  const sub  = (isSubscribed === false)
    ? 'Подписка: не активна'
    : `Подписка: активна до ${untilText || '00.00.2025'}`;
  return `👤 Профиль
Имя: ${name}
Магазин: ${shop}
${sub}`;
}

const profileMarkup = () =>
  Markup.inlineKeyboard([
    [
      Markup.button.url('💳 Тарифы', 'https://telegra.ph/123-09-24-73'),
      Markup.button.url('📘 Инструкция', 'https://telegra.ph/123-09-24-73'),
    ],
    [Markup.button.url('💰 Оплатить', 'https://telegra.ph/123-09-24-73')],
    [Markup.button.callback('⬅️ Назад', shared.CB.MAIN)],
  ]);

function shopKeyboard(shopId) {
  return Markup.inlineKeyboard([
    // [Markup.button.callback('📦 Товары для отслеживания', `${shared.CB.PRODS}:${shopId}:1`)],
    [Markup.button.callback('🧾 Себестоимость товаров', `${shared.CB.COSTS}:${shopId}:1`)],
    [Markup.button.callback('⬅️ Назад', shared.CB.MAIN)],
  ]);
}

// 👉 Изменено: компактная шапка магазина в одну строку
function shopText({ shopName }) {
  return `🏪 Магазин : ${shopName || '—'}`;
}

async function getUserShopInfo(ctx, db) {
  const chat_id = ctx.from.id;

  const uRes = await db.query(
    'SELECT first_name,last_name,is_subscribed,subscription_until,shop_name FROM users WHERE chat_id=$1 LIMIT 1',
    [chat_id]
  );
  const u = uRes.rows[0] || {};

  const sRes = await db.query(
    'SELECT id,name FROM shops WHERE chat_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1',
    [chat_id]
  );
  const shop = sRes.rows[0] || {};
  const shopName = (shop.name || u.shop_name || '').trim();
  const shopId = shop.id || null;

  const untilText = u.subscription_until ? fmtDDMMYYYY(u.subscription_until) : null;
  const profile = {
    firstName: (u.first_name || ctx.from.first_name || '').trim(),
    lastName:  (u.last_name  || ctx.from.last_name  || '').trim(),
    isSubscribed: (typeof u.is_subscribed === 'boolean' ? u.is_subscribed : true),
    untilText,
  };

  return { profile, shopName, shopId };
}

async function showRoot(ctx) {
  try {
    await editCode(ctx, rootText(), shared.mainKeyboard());
  } catch {
    await replyCode(ctx, rootText(), shared.mainKeyboard());
  }
}

async function showShop(ctx, db, shopIdForce = null) {
  const chat_id = ctx.from.id;
  let shopId = shopIdForce;
  let shopName = null;

  if (!shopId) {
    const sRes = await db.query(
      'SELECT id,name FROM shops WHERE chat_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1',
      [chat_id]
    );
    if (sRes.rowCount) {
      shopId = sRes.rows[0].id;
      shopName = (sRes.rows[0].name || '').trim();
    }
  }
  if (!shopName && shopId) {
    const r = await db.query('SELECT name FROM shops WHERE id=$1 LIMIT 1', [shopId]);
    shopName = (r.rows[0]?.name || '').trim();
  }

  if (!shopId) {
    const kb = Markup.inlineKeyboard([shared.backRow(shared.CB.MAIN)]);
    try { await editCode(ctx, 'У вас пока нет подключённого магазина.', kb); }
    catch { await replyCode(ctx, 'У вас пока нет подключённого магазина.', kb); }
    return;
  }

  const txt = shopText({ shopName });
  const kb  = shopKeyboard(shopId);

  try { await editCode(ctx, txt, kb); }
  catch { await replyCode(ctx, txt, kb); }
}

module.exports = (bot, db) => {
  // Подключаем подмодули (товары и себестоимость)
  require('./prods.js')({ bot, db, shared, data });
  require('./costs.js')({ bot, db, shared, data });

  // /settings
  bot.command('settings', async (ctx) => {
    try {
      await showRoot(ctx);
    } catch (e) {
      console.error('[settings]/settings error:', e);
      await replyCode(ctx, 'Произошла ошибка. Попробуйте позже.', mainMenu());
    }
  });

  // Корень настроек
  bot.action(shared.CB.MAIN, async (ctx) => {
    try { await ctx.answerCbQuery(); } catch {}
    await showRoot(ctx);
  });

  // Профиль
  bot.action(shared.CB.PROFILE, async (ctx) => {
    try { await ctx.answerCbQuery(); } catch {}
    try {
      const { profile, shopName } = await getUserShopInfo(ctx, db);
      const text = profileText({ ...profile, shopName });
      try { await editCode(ctx, text, profileMarkup()); }
      catch { await replyCode(ctx, text, profileMarkup()); }
    } catch (e) {
      console.error('[settings] profile error:', e);
      await replyCode(ctx, 'Произошла ошибка. Попробуйте позже.');
    }
  });

  // Магазин
  bot.action(shared.CB.SHOPS, async (ctx) => {
    try { await ctx.answerCbQuery(); } catch {}
    try {
      await showShop(ctx, db);
    } catch (e) {
      console.error('[settings] shop open error:', e);
      await replyCode(ctx, 'Произошла ошибка. Попробуйте позже.');
    }
  });

  // Возврат в магазин из дочерних экранов
  bot.action(new RegExp(`^${shared.CB.SHOP_OPEN}:(\\d+)$`), async (ctx) => {
    try { await ctx.answerCbQuery(); } catch {}
    const shopId = Number(ctx.match[1]);
    await showShop(ctx, db, shopId);
  });
};
